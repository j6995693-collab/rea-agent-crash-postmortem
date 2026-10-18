/**
 * End-to-end tests against the REAL compaction transaction from the installed
 * harness: real `compactSurfaceRegion` (start marker, shadow price, surface
 * replace, end marker), real tool-pairing balance, real checkpoint framing. Only
 * the model call, the session storage and the token meter are fakes, because
 * those are the harness's edges.
 *
 * Each scenario is one shape of the reported failure:
 *   A oversized tool output refilling the window every step
 *   B a normal long conversation that must compact cleanly
 *   C an envelope so large that message compaction is provably useless
 *   D a newest message so large that even a maximal compaction cannot hold
 *
 * Without an installation these skip with a reason instead of failing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { findModulesRoot, importHarness, makeContext, skipReason } from './harness.mjs';

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const THRESHOLD = 80_000;
const available = findModulesRoot() !== undefined;

/** Minimal stand-in for a real session: surface bookkeeping plus append. */
class FakeSession {
  constructor(headerTokens) {
    this.events = [];
    this.replaceGeneration = 0;
    this.headerTokens = headerTokens;
    this.localNodes = [];
    const self = this;
    this.surface = {
      get nodes() { return self.localNodes; },
      get replaceGeneration() { return self.replaceGeneration; },
    };
  }

  /** Four characters per token, matching the meter's density estimate. */
  requestHeader() {
    return {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      system: 'x'.repeat(this.headerTokens * 4),
      tools: [],
    };
  }

  deriveEventMessage(event) {
    if (event.type === 'user/message') return event.data;
    if (event.type === 'assistant/message') return event.data.message;
    if (event.type === 'tool/result') return event.data.message;
    return null;
  }

  append(type, data, options = {}) {
    const seq = this.events.length;
    const event = { seq, type, data, ...options };
    this.events.push(event);
    if (options.surfaceOp !== undefined) {
      const { op, start, end } = options.surfaceOp;
      assert.equal(op, 'replace');
      const from = this.localNodes.indexOf(start);
      const to = this.localNodes.indexOf(end);
      assert.ok(from !== -1 && to !== -1, 'surface replace names a current range');
      this.localNodes.splice(from, to - from + 1, seq);
      this.replaceGeneration += 1;
    } else if (SURFACE_TYPES.has(type)) {
      this.localNodes.push(seq);
    }
    return event;
  }
}

/** Deterministic meter matching the harness heuristic shape. */
function makeMeter() {
  return {
    estimateMessage(message) {
      return Math.ceil(JSON.stringify(message).length / 4) + 4;
    },
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => ({
        seq,
        tokens: this.estimateMessage(session.deriveEventMessage(session.events[seq])),
      }));
      const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0);
      return {
        logRevision: session.events.length,
        baseline: { kind: 'estimated', tokens: session.headerTokens },
        surfaceDeltaTokens: 0,
        totalTokens: session.headerTokens + surfaceTokens,
        surfaceTokens,
        nodes,
      };
    },
  };
}

/** Build a guarded engine bound to one fake session. */
async function makeEngine(session, contextWindow = 100_000) {
  const Base = (await importHarness('@deepseek-ai/dsh-compaction-basic/lib/engine-base.js')).default;
  const { createGuardedEngine } = await import('../src/index.js');
  const ctx = await makeContext();

  ctx.provide('tokenMeter');
  ctx.tokenMeter = makeMeter();
  ctx.provide('llm');
  ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow } }) };
  ctx.provide('sessions');
  ctx.sessions = { flush: async () => {} };

  // `ctx.logger` is Cordis's own logger object, not an injectable service, so the
  // harness-level hook is its warn method.
  const warnings = [];
  ctx.logger.warn = (line) => warnings.push(String(line));
  ctx.logger.info = () => {};
  ctx.logger.error = () => {};

  const Guarded = await createGuardedEngine(Base);
  class TestEngine extends Guarded {
    async summarize() {
      return {
        summary: [{ type: 'text', text: 'checkpoint body' }],
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      };
    }
  }
  return { engine: new TestEngine(ctx, {}), warnings };
}

function makeAgent(session) {
  const steered = [];
  return {
    agent: { session, options: {}, status: 'running', steer: (message) => steered.push(message) },
    steered,
  };
}

/** One model step whose OUTPUT is a tool result carrying `tokens` of text. */
function addToolStep(session, tokens) {
  const pad = 'z'.repeat(Math.max(4, tokens * 4));
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'read it' }] });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'tool-call', name: 'bash', arguments: '{"command":"cat big"}' },
      ],
    },
  });
  session.append('tool/result', {
    message: {
      role: 'tool',
      content: [{ type: 'tool-result', callId: 'call-1', content: [{ type: 'text', text: pad }] }],
    },
  });
}

/** One model step whose INPUT is a pasted document carrying `tokens` of text. */
function addPasteStep(session, tokens) {
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: `doc ${'p'.repeat(tokens * 4)}` }] });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
  });
}

const transactions = (session) => session.events.filter((event) => event.type === 'compaction/start').length;

test('A: oversized tool output is reclaimed before it reaches the threshold', { skip: !available && skipReason }, async () => {
  // The reported failure: 60k of tool output per step with a 16k tail budget.
  // Message compaction can never remove it — the guard prunes it instead.
  const session = new FakeSession(10_000);
  session.append('turn/start', { turn: 1 });
  const { engine, warnings } = await makeEngine(session);
  const meter = engine.ctx.tokenMeter;
  const { agent, steered } = makeAgent(session);
  const signal = new AbortController().signal;

  const totals = [];
  for (let step = 0; step < 5; step += 1) {
    addToolStep(session, 60_000);
    if (meter.measure(session).totalTokens >= THRESHOLD) await engine.compactIfNeeded(agent, 'pressure', signal);
    totals.push(meter.measure(session).totalTokens);
  }

  assert.ok(totals.every((total) => total < THRESHOLD), `every step ends under the threshold: ${totals.join(', ')}`);
  const pruned = session.events.filter((event) => event.type === 'compaction/prune');
  assert.ok(pruned.length >= 4, 'each oversized result is reclaimed through the shadow-price protocol');
  assert.equal(steered.length, 0);
  assert.ok(warnings.every((line) => !line.includes('guard failed')));
});

test('B: a normal long conversation compacts cleanly, keeping a real tail', { skip: !available && skipReason }, async () => {
  const session = new FakeSession(10_000);
  session.append('turn/start', { turn: 1 });
  const { engine, warnings } = await makeEngine(session);
  const meter = engine.ctx.tokenMeter;
  const { agent } = makeAgent(session);
  const signal = new AbortController().signal;

  let ran = 0;
  for (let step = 0; step < 10; step += 1) {
    addPasteStep(session, 12_000);
    if (meter.measure(session).totalTokens < THRESHOLD) continue;
    const result = await engine.compactIfNeeded(agent, 'pressure', signal);
    if (result !== null) ran += 1;
  }

  assert.ok(ran >= 1, 'the pressure path actually compacted');
  assert.ok(meter.measure(session).totalTokens < THRESHOLD);
  assert.equal(transactions(session), ran, 'every run is a real start/end transaction pair');
  assert.equal(session.events.filter((event) => event.type === 'compaction/end').length, ran);

  const shadowed = session.events.filter((event) => event.type === 'compaction/summary').map((event) => event.data.shadowedTokenCount);
  assert.ok(shadowed.every((count) => count > 1000), 'real ranges were summarized');
  assert.ok(warnings.every((line) => !line.includes('guard failed')), 'no fallback was needed');
});

test('C: a catalog-sized envelope trips the breaker at once and steers one message', { skip: !available && skipReason }, async () => {
  // 90k of tool schemas against an 80k threshold: no message compaction can help.
  const session = new FakeSession(90_000);
  session.append('turn/start', { turn: 1 });
  const { engine, warnings } = await makeEngine(session);
  const { agent, steered } = makeAgent(session);
  const signal = new AbortController().signal;
  addToolStep(session, 1_000);

  const first = await engine.compactIfNeeded(agent, 'pressure', signal);
  assert.equal(first, null, 'no summarization request was spent');
  assert.equal(steered.length, 1, 'the agent is told the truth once');
  assert.match(steered[0].content[0].text, /non-compactable part/);
  assert.equal(transactions(session), 0, 'no compaction transaction was opened');

  const second = await engine.compactIfNeeded(agent, 'pressure', signal);
  assert.equal(second, null);
  assert.equal(steered.length, 1, 'the diagnostic is announced once per streak');
  assert.ok(warnings.some((line) => line.includes('guard tripped')));
});

test('D: an unholdable newest message stops the loop instead of retrying forever', { skip: !available && skipReason }, async () => {
  // 45k pasted per step: after any compaction the newest node alone is 45k, so a
  // 10k envelope + 45k keeps landing just under and re-firing next step.
  const session = new FakeSession(10_000);
  session.append('turn/start', { turn: 1 });
  const { engine, warnings } = await makeEngine(session);
  const meter = engine.ctx.tokenMeter;
  const { agent, steered } = makeAgent(session);
  const signal = new AbortController().signal;

  for (let step = 0; step < 8; step += 1) {
    addPasteStep(session, 45_000);
    if (meter.measure(session).totalTokens < THRESHOLD) continue;
    await engine.compactIfNeeded(agent, 'pressure', signal);
    if (steered.length > 0) break;
  }
  assert.equal(steered.length, 1, 'the breaker fired exactly once');
  assert.match(steered[0].content[0].text, /refilled to the threshold every time|non-compactable part/);
  assert.ok(transactions(session) <= 5, `compaction attempts are bounded (saw ${transactions(session)})`);
  assert.ok(warnings.some((line) => line.includes('guard tripped')));
});

test('E: an internal failure falls back to the stock policy instead of breaking the turn', { skip: !available && skipReason }, async () => {
  const session = new FakeSession(10_000);
  session.append('turn/start', { turn: 1 });
  const { engine, warnings } = await makeEngine(session);
  const { agent } = makeAgent(session);
  const signal = new AbortController().signal;
  addPasteStep(session, 60_000);

  engine.ctx.tokenMeter.measure = () => {
    throw new Error('meter exploded');
  };
  await assert.rejects(async () => engine.compactIfNeeded(agent, 'pressure', signal), /meter exploded/);
  assert.ok(warnings.some((line) => line.includes('falling back')), 'the failure is reported and the stock path runs');
});

test('F: the steered diagnostic is an ordinary, relayable user message', { skip: !available && skipReason }, async () => {
  const session = new FakeSession(90_000);
  session.append('turn/start', { turn: 1 });
  const { engine } = await makeEngine(session);
  const { agent, steered } = makeAgent(session);
  addToolStep(session, 1_000);
  await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);

  assert.equal(steered.length, 1);
  assert.equal(typeof steered[0].id, 'string');
  assert.equal(steered[0].source.kind, 'plugin');
  assert.equal(steered[0].source.plugin, 'rea-agent-crash-postmortem');
  assert.ok(steered[0].content.every((block) => block.type === 'text'));
  assert.match(steered[0].content[0].text, /\/clear/);
});

test('G: the stock manual-compaction entry points are untouched', { skip: !available && skipReason }, async () => {
  const session = new FakeSession(10_000);
  session.append('turn/start', { turn: 1 });
  const { engine } = await makeEngine(session);
  assert.equal(typeof engine.compactNow, 'function');
  assert.equal(typeof engine.compactRegion, 'function');
});
