/**
 * The pure decision core: no harness, no session, no model. Every branch of the
 * four rules is exercised here, including the arithmetic that proves a fixed
 * verbatim tail cannot converge.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGGRESSIVE_MARKER,
  GUARD_DEFAULTS,
  escalatedRetainTokens,
  guardDiagnostic,
  measureHeader,
  planPressureCompaction,
  pruneBlocks,
  selectCompactableRange,
  textBlockChars,
} from '../src/core.js';
import { findModulesRoot, importHarness, makeContext, skipReason } from './harness.mjs';

const WINDOW = 1_000_000;
const THRESHOLD = 800_000;
const RETAIN = 160_000;

test('below the threshold there is nothing to do', () => {
  const plan = planPressureCompaction({
    totalTokens: 799_999,
    thresholdTokens: THRESHOLD,
    headerTokens: 200_000,
    retainTokens: RETAIN,
    consecutive: 3,
  });
  assert.equal(plan.kind, 'below');
});

test('retention escalates downward on consecutive compactions and floors', () => {
  assert.equal(escalatedRetainTokens(RETAIN, 0), 160_000);
  assert.equal(escalatedRetainTokens(RETAIN, 1), 80_000);
  assert.equal(escalatedRetainTokens(RETAIN, 2), 40_000);
  assert.equal(escalatedRetainTokens(RETAIN, 3), 20_000);
  assert.equal(escalatedRetainTokens(RETAIN, 99), GUARD_DEFAULTS.minRetainTokens);
  for (let n = 1; n < 12; n += 1) {
    assert.ok(escalatedRetainTokens(RETAIN, n) <= escalatedRetainTokens(RETAIN, n - 1), 'budget never grows');
  }
});

test('a thrash streak drains the context instead of oscillating', () => {
  // Each step adds 200k of new surface; compaction reclaims everything above the
  // escalated tail. With a FIXED tail the total resets to ~366k and climbs
  // straight back over the threshold; the escalating tail must end below it.
  let consecutive = 0;
  let surface = THRESHOLD;
  const totals = [];
  for (let step = 0; step < 12; step += 1) {
    surface += 200_000;
    const total = 206_000 + surface; // a measured 206k envelope
    totals.push(total);
    if (total < THRESHOLD) {
      consecutive = Math.max(0, consecutive - 1);
      continue;
    }
    const plan = planPressureCompaction({
      totalTokens: total,
      thresholdTokens: THRESHOLD,
      headerTokens: 206_000,
      retainTokens: RETAIN,
      consecutive,
    });
    if (plan.kind !== 'compact') break;
    surface = plan.retainTokens;
    consecutive += 1;
  }
  assert.ok(totals.at(-1) < THRESHOLD, `escalation must converge; totals were ${totals.slice(-4).join(', ')}`);
});

test('a fixed tail would oscillate — the failure mode this guard exists for', () => {
  let surface = THRESHOLD;
  const totals = [];
  for (let step = 0; step < 30; step += 1) {
    surface += 200_000;
    const total = 206_000 + surface;
    totals.push(total);
    if (total < THRESHOLD) continue;
    surface = RETAIN; // stock behaviour: the same budget every time
  }
  const overThreshold = totals.filter((total) => total >= THRESHOLD).length;
  const lowest = Math.min(...totals);
  assert.ok(overThreshold >= 8, `it re-fires on every cycle (${overThreshold} times in 30 steps) — this is the thrash`);
  assert.ok(
    lowest >= 500_000,
    `with a fixed tail the window never drains (low point ${lowest}); it sits in a periodic orbit around the threshold`,
  );
  assert.deepEqual(
    [totals[2] - totals[5], totals[5] - totals[8]],
    [0, 0],
    'the orbit is exactly periodic — same state, same failure, forever',
  );
});

test('the head-anchored cut keeps the newest node, which is why reclaim exists', () => {
  const nodes = [{ seq: 1, tokens: 5_000 }, { seq: 2, tokens: 300_000 }];
  const session = { surface: { nodes: [1, 2] } };
  const range = selectCompactableRange(session, { nodes }, RETAIN, () => true);
  assert.deepEqual(range, { start: 1, end: 1 }, 'the 300k newest node is retained verbatim at any tail budget');
});

test('the cut walks left until the tool-pairing balance holds', () => {
  const nodes = [{ seq: 10, tokens: 100 }, { seq: 11, tokens: 100 }, { seq: 12, tokens: 100 }];
  const session = { surface: { nodes: [10, 11, 12] } };
  // only the cut before seq 10 is balanced
  const balanced = (_session, seq) => seq === 10 || seq === 11;
  const range = selectCompactableRange(session, { nodes }, 150, balanced);
  assert.deepEqual(range, { start: 10, end: 10 }, 'kept the balanced tail from seq 11 on');
});

test('the breaker trips when the tool catalog alone reaches the threshold', () => {
  const plan = planPressureCompaction({
    totalTokens: 900_000,
    thresholdTokens: THRESHOLD,
    headerTokens: 850_000,
    retainTokens: RETAIN,
    consecutive: 0,
  });
  assert.equal(plan.kind, 'breaker');
  assert.equal(plan.reason, 'floor');
});

test('the breaker trips after maxConsecutive failed rounds', () => {
  const plan = planPressureCompaction({
    totalTokens: 900_000,
    thresholdTokens: THRESHOLD,
    headerTokens: 206_000,
    retainTokens: RETAIN,
    consecutive: GUARD_DEFAULTS.maxConsecutive,
  });
  assert.equal(plan.kind, 'breaker');
  assert.equal(plan.reason, 'no-progress');
});

test('a real compaction plan carries the tail budget and the attempt index', () => {
  const plan = planPressureCompaction({
    totalTokens: 820_000,
    thresholdTokens: THRESHOLD,
    headerTokens: 206_000,
    retainTokens: RETAIN,
    consecutive: 2,
  });
  assert.equal(plan.kind, 'compact');
  assert.equal(plan.attempt, 2);
  assert.equal(plan.retainTokens, 40_000);
});

test('header pricing matches the host token meter heuristics', () => {
  const session = {
    requestHeader: () => ({
      config: { provider: 'p', model: 'm' },
      system: 'x'.repeat(4_000),
      tools: [{ name: 'a', description: 'y'.repeat(40_000) }],
    }),
  };
  const priced = measureHeader(session);
  assert.equal(priced.systemTokens, 1_004); // 4000/4 + 4
  assert.equal(priced.toolsTokens, Math.ceil(JSON.stringify(session.requestHeader().tools).length / 4) + 4);
  assert.equal(priced.toolCount, 1);
  assert.deepEqual(measureHeader({ requestHeader: () => undefined }), { systemTokens: 0, toolsTokens: 0, toolCount: 0 });
});

test('the second-stage prune keeps head and tail and inserts one marker', () => {
  const blocks = [{ type: 'text', text: `${'H'.repeat(3_000)}${'M'.repeat(20_000)}${'T'.repeat(1_000)}` }];
  const pruned = pruneBlocks(blocks);
  assert.ok(pruned !== null);
  const text = pruned.map((block) => block.text).join('');
  assert.ok(text.includes(AGGRESSIVE_MARKER));
  assert.ok(text.startsWith('HHH'));
  assert.ok(text.endsWith('TTT'));
  assert.ok(textBlockChars(pruned) <= GUARD_DEFAULTS.aggressiveThresholdChars);
  assert.equal(pruneBlocks([{ type: 'text', text: 'short' }]), null, 'small results are untouched');
});

test('the diagnosis names the measured breakdown', () => {
  const text = guardDiagnostic({
    reason: 'floor',
    totalTokens: 930_000,
    thresholdTokens: 800_000,
    contextWindow: 1_000_000,
    systemTokens: 1_510,
    toolsTokens: 205_103,
    toolCount: 232,
    surfaceTokens: 720_000,
    surfaceNodes: 41,
    consecutive: 0,
  });
  assert.match(text, /tool schemas ~205103 tokens across 232 tools/);
  assert.match(text, /93%/);
  assert.match(text, /non-compactable/);
  assert.match(text, /\/clear/);
});

// ── the harness binding, only when this machine has an installation ──────────

test('the guarded class extends the stock engine and keeps its injections', async (t) => {
  if (findModulesRoot() === undefined) return t.skip(skipReason);
  const { default: Base } = await importHarness('@deepseek-ai/dsh-compaction-basic/lib/engine-base.js');
  const { createGuardedEngine } = await import('../src/index.js');
  const Guarded = await createGuardedEngine(Base);

  assert.notEqual(Guarded, Base);
  assert.ok(Guarded.prototype instanceof Base, 'guarded class extends the stock engine');
  assert.deepEqual(Guarded.inject, ['llm', 'tokenMeter', 'sessions'], 'the Loader still sees the stock injections');
  assert.equal(typeof Guarded.Config, 'function', 'the stock config schema is inherited for Loader validation');

  const ctx = await makeContext();
  const engine = new Guarded(ctx, {});
  assert.equal(typeof engine.compactIfNeeded, 'function');
  assert.equal(typeof engine.compactRegion, 'function', 'the stock transaction layer is inherited');
  assert.equal(typeof engine._announceBreaker, 'function', 'the guard layer is present');
  assert.equal(engine.config.thresholdRatio, 0.8, 'stock config resolution still applies');
  assert.equal(engine.config.retainRatio, 0.16);
});
