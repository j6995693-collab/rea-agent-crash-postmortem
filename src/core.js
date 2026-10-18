/**
 * The host-independent decision core.
 *
 * Nothing in this file imports a harness, a framework, or a model client — it is
 * plain functions over plain data, which is why the interesting behaviour
 * (escalation, the breaker, the floor) is unit-testable without a session, an
 * agent, or a provider. `src/index.js` binds it to one concrete harness.
 *
 * Four rules, in order of what they save:
 *
 *   1. below  — nothing to do below the threshold (and track the healthy streak)
 *   2. floor  — the envelope alone reaches the threshold: compacting cannot help
 *   3. breaker— N consecutive compactions that failed to hold: stop
 *   4. compact— with a tail budget that halves on each consecutive failure
 *
 * @module rea-agent-crash-postmortem/core
 */

/** Guard tuning. Constants on purpose: they must not depend on host config keys. */
export const GUARD_DEFAULTS = Object.freeze({
  /** Multiplier applied to the verbatim tail on each consecutive compaction. */
  retainDecay: 0.5,
  /** Floor for the escalated verbatim tail. */
  minRetainTokens: 8192,
  /** Consecutive compactions that failed to hold before the breaker trips. */
  maxConsecutive: 4,
  /** Below-threshold steps needed before the thrash streak resets. */
  recoverySteps: 2,
  /** Character budget for the second-stage tool-result prune. */
  aggressiveThresholdChars: 4000,
  aggressiveHeadChars: 2000,
  aggressiveTailChars: 600,
});

/** Marker inserted by the second-stage prune; also skips already-pruned nodes. */
export const AGGRESSIVE_MARKER = '\n\n[... oversized tool result pruned by context guard ...]\n\n';

/** Text-density divisor used by the host's token meter. */
const CHARS_PER_TOKEN = 4;
/** Per-envelope structural overhead used by the host's token meter. */
const ENVELOPE_OVERHEAD = 4;

/** Count Unicode code points without splitting surrogate pairs. */
export function codePointLength(text) {
  return Array.from(text).length;
}

/**
 * Price the non-surface part of the last routed request the way the host's token
 * meter does (`estimateSystemTokens` + `estimateToolsTokens`).
 * @param session - session supplying the last logged request header.
 * @returns system/tool estimates plus the tool count.
 */
export function measureHeader(session) {
  const header = session.requestHeader?.();
  if (header === undefined || header === null) return { systemTokens: 0, toolsTokens: 0, toolCount: 0 };
  const systemTokens = typeof header.system === 'string' && header.system.length > 0
    ? Math.ceil(header.system.length / CHARS_PER_TOKEN) + ENVELOPE_OVERHEAD
    : 0;
  const tools = Array.isArray(header.tools) ? header.tools : [];
  const toolsTokens = tools.length === 0
    ? 0
    : Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + ENVELOPE_OVERHEAD;
  return { systemTokens, toolsTokens, toolCount: tools.length };
}

/**
 * The verbatim tail budget for the Nth consecutive compaction.
 * @param retainTokens - tail budget for a healthy conversation.
 * @param consecutive - compactions already run since the last healthy streak.
 * @param options - guard tuning.
 * @returns a non-increasing tail budget, never below the floor.
 */
export function escalatedRetainTokens(retainTokens, consecutive, options = GUARD_DEFAULTS) {
  const decayed = Math.round(retainTokens * options.retainDecay ** Math.max(0, consecutive));
  return Math.max(options.minRetainTokens, Math.min(retainTokens, decayed));
}

/**
 * The pure anti-thrash decision.
 * @param input - measured pressure plus the guard's memory of this history.
 * @returns `below` (nothing to do), `breaker` (compaction provably cannot help,
 *   or has already failed enough times), or `compact` with the tail budget.
 */
export function planPressureCompaction(input) {
  const {
    totalTokens,
    thresholdTokens,
    headerTokens,
    retainTokens,
    consecutive,
    options = GUARD_DEFAULTS,
  } = input;
  if (totalTokens < thresholdTokens) return { kind: 'below' };

  const retain = escalatedRetainTokens(retainTokens, consecutive, options);
  const floorTokens = headerTokens + Math.min(options.minRetainTokens, retain);

  // A provable floor: the envelope is not compactable, so a maximal compaction
  // still lands above the threshold. Never summarize — that spends a full-size
  // request to change nothing.
  if (floorTokens >= thresholdTokens) return { kind: 'breaker', reason: 'floor', retainTokens: retain, floorTokens };

  // A circuit breaker: repeated attempts are the "stuck" state itself.
  if (consecutive >= options.maxConsecutive) return { kind: 'breaker', reason: 'no-progress', retainTokens: retain, floorTokens };

  return { kind: 'compact', retainTokens: retain, attempt: consecutive, floorTokens };
}

/**
 * Resolve the next head-anchored compactable range: walk back accumulating
 * prices until the tail reaches its budget, then move the cut left until it does
 * not split an assistant tool-call/result pair.
 *
 * This is the rule that makes cause #2 in docs/03 possible: the tail always
 * contains the newest node, so one oversized node survives every compaction.
 *
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - `{ nodes: [{ seq, tokens }] }` in model-visible order.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param isCutBalanced - `(session, seq) => boolean`; inject your host's pairing check.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(session, measurement, retainTokens, isCutBalanced) {
  const pricedNodes = measurement.nodes;
  if (pricedNodes.length === 0) return null;
  const surfaceNodes = session.surface.nodes;
  if (
    surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)
  ) {
    throw new Error('compaction-guard: token-meter surface does not match the current session surface');
  }
  let accumulated = 0;
  let keepFromIdx = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx === 0) return null;
  while (keepFromIdx > 0) {
    if (isCutBalanced(session, surfaceNodes[keepFromIdx])) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx === 0) return null;
  return { start: surfaceNodes[0], end: surfaceNodes[keepFromIdx - 1] };
}

/** Count code points across text blocks. */
export function textBlockChars(blocks) {
  let chars = 0;
  for (const block of blocks) if (block.type === 'text') chars += codePointLength(block.text);
  return chars;
}

/**
 * Head/middle/tail cut under a caller-supplied budget — the shipped pruner's
 * algorithm with a second, tighter budget.
 * @param blocks - tool-result content blocks.
 * @returns pruned blocks, or `null` when nothing has to be removed.
 */
export function pruneBlocks(blocks, options = GUARD_DEFAULTS) {
  const totalChars = textBlockChars(blocks);
  if (totalChars <= options.aggressiveThresholdChars) return null;
  const removedStart = options.aggressiveHeadChars;
  const removedEnd = Math.max(removedStart, totalChars - options.aggressiveTailChars);
  const pruned = [];
  let consumed = 0;
  let markerInserted = false;
  for (const block of blocks) {
    if (block.type !== 'text') {
      pruned.push(block);
      continue;
    }
    const points = Array.from(block.text);
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? AGGRESSIVE_MARKER : '';
    if (marker.length > 0) markerInserted = true;
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('');
    if (text.length > 0) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) return null;
  if (textBlockChars(pruned) >= totalChars) return null;
  return pruned;
}

/** Test whether a tool result already carries the guard's marker. */
export function hasGuardMarker(blocks) {
  return blocks.some((block) => block.type === 'text' && block.text.includes(AGGRESSIVE_MARKER));
}

/**
 * Build the single diagnostic the agent relays to the human. Every number is
 * measured, so the message never guesses.
 * @param facts - measured occupancy for this step.
 * @returns the message text.
 */
export function guardDiagnostic(facts) {
  const {
    reason,
    totalTokens,
    thresholdTokens,
    contextWindow,
    systemTokens,
    toolsTokens,
    toolCount,
    surfaceTokens,
    surfaceNodes,
    consecutive,
  } = facts;
  const pct = (value) => `${Math.round((value / Math.max(1, contextWindow)) * 100)}%`;
  const lines = [
    '[context guard] Automatic compaction cannot free enough context here, so no further compaction will be attempted for this history.',
    '',
    `Occupancy: ~${totalTokens} tokens of a ${contextWindow}-token window (${pct(totalTokens)}; compaction threshold ${thresholdTokens}).`,
    `  system prompt ~${systemTokens} tokens`,
    `  tool schemas ~${toolsTokens} tokens across ${toolCount} tools`,
    `  conversation surface ~${surfaceTokens} tokens across ${surfaceNodes} messages`,
    '',
  ];
  if (reason === 'floor') {
    lines.push(
      `The non-compactable part (system prompt + tool schemas) is ~${systemTokens + toolsTokens} tokens, which already reaches the ${thresholdTokens}-token threshold. Compacting messages cannot recover that space, so it will not be attempted.`,
    );
  } else {
    lines.push(
      `Compaction ran ${consecutive} times in a row and the context refilled to the threshold every time; another attempt would only cost another full-size request.`,
    );
  }
  lines.push(
    '',
    'What to do now:',
    '- Stop adding large content. Do not read whole files or dump long tool output; prefer targeted reads over small ranges.',
    '- Answer the user directly with what is already known, and tell them in their own language that this session reached its context ceiling.',
    '- Give them the concrete ways out: (a) /clear and restate the goal, (b) if tool schemas dominate, change the tool presentation or unmount the oversized MCP server, (c) continue in a fresh session from a short handoff summary.',
  );
  return lines.join('\n');
}

/**
 * Wrap a host compaction engine class with the anti-thrash policy.
 * @param BaseCompactionEngine - the host engine class to extend.
 * @param deps - host bindings: `{ toolPairingBalancedBefore, createUserMessage, freezeMessage }`.
 * @returns a drop-in replacement for the host's export.
 */
export function createGuardedCompactionEngine(BaseCompactionEngine, deps) {
  const { toolPairingBalancedBefore, createUserMessage, freezeMessage } = deps;

  return class GuardedCompactionEngine extends BaseCompactionEngine {
    guardStates = new WeakMap();
    guardAnnounced = new WeakSet();

    /** Read (and lazily create) this session's anti-thrash memory. */
    _guardState(session) {
      let state = this.guardStates.get(session);
      if (state === undefined) {
        state = { consecutive: 0, healthyStreak: 0 };
        this.guardStates.set(session, state);
      }
      return state;
    }

    /** A below-threshold step; enough of them in a row forget the thrash streak. */
    _recordHealthyStep(session) {
      const state = this._guardState(session);
      state.healthyStreak += 1;
      if (state.healthyStreak >= GUARD_DEFAULTS.recoverySteps) {
        state.consecutive = 0;
        this.guardAnnounced.delete(session);
      }
    }

    /** One compaction ran; the surface must now prove that it holds. */
    _recordCompaction(session) {
      const state = this._guardState(session);
      state.consecutive += 1;
      state.healthyStreak = 0;
    }

    /** Resolve this route's policy, honouring an exact-target override if present. */
    _policyFor(target) {
      const override = (this.config.modelPolicies ?? []).find(
        (policy) => policy.provider === target.provider && policy.model === target.model,
      );
      return {
        thresholdRatio: override?.thresholdRatio ?? this.config.thresholdRatio,
        retainRatio: override?.retainRatio ?? this.config.retainRatio,
        retainTokens: override?.retainTokens ?? this.config.retainTokens,
        compactionRetries: override?.compactionRetries ?? this.config.compactionRetries ?? 0,
      };
    }

    /** Whether a durable compaction lock is already open for this session. */
    _compactionBusy(session) {
      let latestSeed;
      for (let index = session.events.length - 1; index >= 0; index -= 1) {
        const event = session.events[index];
        if (latestSeed === undefined && event.type === 'session/end-seed') latestSeed = event.seq;
        if (event.type === 'compaction/start') return latestSeed === undefined || latestSeed < event.seq;
        if (event.type === 'compaction/end') return false;
      }
      return false;
    }

    /**
     * Second-stage prune: reclaim any tool result whose own price exceeds the
     * retention budget, which the head-anchored selection rule can never compact
     * away. Replay-safe — the original stays in the log and the replacement cites
     * it through the shadow-price protocol.
     * @param session - session whose current surface is rewritten.
     * @param retainTokens - the tail budget for this attempt.
     * @returns whether any node was rewritten.
     */
    _reclaimOversizedToolResults(session, retainTokens) {
      const meter = this.ctx.tokenMeter;
      const candidates = [];
      for (const seq of [...session.surface.nodes]) {
        const event = session.events[seq];
        if (event === undefined || event.type !== 'tool/result') continue;
        const result = event.data?.message?.content?.[0];
        const blocks = result?.content;
        if (!Array.isArray(blocks)) continue;
        if (hasGuardMarker(blocks)) continue;
        const tokens = meter.estimateMessage(event.data.message);
        if (tokens <= retainTokens && textBlockChars(blocks) <= GUARD_DEFAULTS.aggressiveThresholdChars) continue;
        candidates.push({ seq, event, result, blocks, tokens });
      }
      let changed = false;
      for (const candidate of candidates) {
        const pruned = pruneBlocks(candidate.blocks);
        if (pruned === null) continue;
        const message = freezeMessage({
          ...candidate.event.data.message,
          content: [{ ...candidate.result, content: pruned }],
        });
        session.append('compaction/prune', {
          shadowedRange: { start: candidate.seq, end: candidate.seq },
          shadowedSeqs: [candidate.seq],
          shadowedTokenCount: candidate.tokens,
        });
        session.append(
          'tool/result',
          { ...candidate.event.data, message },
          { surfaceOp: { op: 'replace', start: candidate.seq, end: candidate.seq }, sourceEventSeqs: [candidate.seq] },
        );
        changed = true;
      }
      return changed;
    }

    /** Steer one honest, numerically grounded message into the running turn. */
    _announceBreaker(agent, facts) {
      if (this.guardAnnounced.has(agent.session)) return;
      this.guardAnnounced.add(agent.session);
      this.ctx.logger.warn(
        `compaction guard tripped (${facts.reason}): ${facts.totalTokens}/${facts.thresholdTokens} tokens, header ${facts.systemTokens + facts.toolsTokens}, surface ${facts.surfaceTokens}`,
      );
      try {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: guardDiagnostic(facts) }],
          source: { kind: 'plugin', plugin: 'rea-agent-crash-postmortem' },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.logger.warn(`compaction guard could not steer its diagnostic: ${message}`);
      }
    }

    /**
     * Guarded pressure and overflow handling. The overflow path keeps the stock
     * behaviour (prune, then one maximal reduction); the pressure path adds the
     * escalation, the oversized-node reclaim, and the breaker.
     */
    async compactIfNeeded(agent, trigger, signal) {
      try {
        return await this._guardedCompactIfNeeded(agent, trigger, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Never make the harness worse than stock: an unexpected guard failure
        // falls back to the stock policy for this step, once.
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.logger.warn(`compaction guard failed (${message}); falling back to stock compaction for this step`);
        return super.compactIfNeeded(agent, trigger, signal);
      }
    }

    async _guardedCompactIfNeeded(agent, trigger, signal) {
      const session = agent.session;

      if (trigger === 'context-overflow') {
        const state = this._guardState(session);
        state.consecutive += 1;
        state.healthyStreak = 0;
        this.guardAnnounced.delete(session);
        return super.compactIfNeeded(agent, trigger, signal);
      }

      const config = session.requestHeader()?.config;
      if (config === undefined || config.provider.length === 0 || config.model.length === 0) return null;
      const target = { provider: config.provider, model: config.model };
      const targetKey = `${target.provider}/${target.model}`;
      const policy = this._policyFor(target);
      const meter = this.ctx.tokenMeter;
      let measurement = meter.measure(session);

      const modelInfo = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      const capacity = modelInfo?.context;
      if (capacity === undefined) {
        if (this.warnedPressureConfigTargets.has(targetKey)) return null;
        this.warnedPressureConfigTargets.add(targetKey);
        throw new Error(`compaction-guard: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
      }
      const contextWindow = capacity.contextWindow;
      const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
      const retainTokens = policy.retainTokens === undefined
        ? Math.floor(contextWindow * policy.retainRatio)
        : policy.retainTokens;

      if (measurement.totalTokens < thresholdTokens) {
        this._recordHealthyStep(session);
        return null;
      }

      const prune = this.ctx.get('toolResultPruner');
      if (prune !== undefined) {
        prune.pruneSession(session);
        measurement = meter.measure(session);
        if (measurement.totalTokens < thresholdTokens) {
          this._recordHealthyStep(session);
          return null;
        }
      }

      const state = this._guardState(session);
      const pricedHeader = measureHeader(session);
      const headerTokens = pricedHeader.systemTokens + pricedHeader.toolsTokens;
      const plan = planPressureCompaction({
        totalTokens: measurement.totalTokens,
        thresholdTokens,
        headerTokens,
        retainTokens,
        consecutive: state.consecutive,
      });

      if (plan.kind === 'breaker') {
        this._announceBreaker(agent, {
          reason: plan.reason,
          totalTokens: measurement.totalTokens,
          thresholdTokens,
          contextWindow,
          systemTokens: pricedHeader.systemTokens,
          toolsTokens: pricedHeader.toolsTokens,
          toolCount: pricedHeader.toolCount,
          surfaceTokens: measurement.surfaceTokens,
          surfaceNodes: measurement.nodes.length,
          consecutive: state.consecutive,
        });
        return null;
      }

      if (this._compactionBusy(session)) return null;

      if (this._reclaimOversizedToolResults(session, plan.retainTokens)) {
        measurement = meter.measure(session);
        if (measurement.totalTokens < thresholdTokens) {
          this._recordHealthyStep(session);
          return null;
        }
      }

      let result = null;
      const attempts = Math.max(1, policy.compactionRetries + 1);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const range = selectCompactableRange(session, measurement, plan.retainTokens, toolPairingBalancedBefore);
        if (range === null) break;
        result = await this.compactRegion(range.start, range.end, agent, signal);
        measurement = meter.measure(session);
        if (measurement.totalTokens < thresholdTokens) {
          this._recordCompaction(session);
          return result;
        }
      }
      if (result === null) return null;
      this._recordCompaction(session);
      throw new Error(
        `compaction-guard: still above threshold after ${attempts} attempts (${measurement.totalTokens} estimated tokens >= threshold ${thresholdTokens})`,
      );
    }
  };
}
