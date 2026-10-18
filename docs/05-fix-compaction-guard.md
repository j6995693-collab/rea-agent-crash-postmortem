# 05 — The fix: a guarded compaction engine

The stock engine's transaction (summarize → shadow-price → surface replace →
checkpoint) is good and is left untouched. What is replaced is the **decision
layer**: when to compact, how much to keep, and when to stop. That split is why
this is a ~450-line patch instead of a rewrite.

## The decision core is pure

```js
planPressureCompaction({ totalTokens, thresholdTokens, headerTokens,
                         retainTokens, consecutive })
// → { kind: 'below' }
// → { kind: 'compact', retainTokens, attempt }
// → { kind: 'breaker', reason: 'floor' | 'no-progress' }
```

Three rules, in order:

```js
if (totalTokens < thresholdTokens) return { kind: 'below' };

const retain      = escalatedRetainTokens(retainTokens, consecutive);  // ×0.5^n, floored
const floorTokens = headerTokens + min(minRetainTokens, retain);

// Rule 1 — a provable floor: never spend a request that cannot possibly work.
if (floorTokens >= thresholdTokens) return { kind: 'breaker', reason: 'floor' };

// Rule 2 — a circuit breaker: after N failed rounds, stop.
if (consecutive >= maxConsecutive) return { kind: 'breaker', reason: 'no-progress' };

return { kind: 'compact', retainTokens: retain, attempt: consecutive };
```

Because it is pure, the interesting behaviour is unit-testable without a session,
an agent, or a model — see `tests/policy.test.mjs`.

## The four behaviours

### 1. Escalating retention (fixes cause 1)

```js
retain(consecutive) = max(minRetain, min(retain, retain0 × 0.5^consecutive))
```

160k → 80k → 40k → 20k → 8k floor. Each round grants strictly less verbatim
history, so the state machine cannot stay at its old fixed point: either the
window drains or the floor rule proves it cannot and the breaker stops the loop.

The counter resets only after `recoverySteps` **consecutive below-threshold
steps**. That detail matters: resetting on the first below-threshold step would
make a one-step dip (the refill pattern this whole document is about) look like
recovery, and the escalation would never engage.

### 2. Oversized-node reclaim (fixes cause 2)

Before selecting a range, every tool result whose own price exceeds the retention
budget — or whose text exceeds the second-stage character budget — is re-pruned
head/middle/tail:

```text
3,000 chars head … [oversized tool result pruned by context guard] … 600 chars tail
```

This is replay-safe: the original event stays in the log, and the replacement
cites it through the same shadow-price protocol the stock pruner uses, so replay
and the token fold stay consistent. Non-tool messages are never touched — you do
not get to "prune" a user's pasted document.

Why re-prune rather than compact it into the summary? Because the model may still
be working with that output, and a summary of a tool result is strictly less
useful than its head and tail.

### 3. The envelope floor (fixes cause 3)

`headerTokens` is priced exactly the way the harness's meter prices it
(`system/4 + JSON(tools)/4`), then compared with the threshold *before* any
summarization. When the envelope alone can exceed it, the guard spends **zero**
requests and says so.

### 4. Breaker + honest diagnostic (fixes cause 4)

When the breaker trips, the engine steers exactly one message into the live turn
carrying the measured breakdown (system / tools / surface / total) and the three
ways out (`/clear`, presentation change, fresh session with a handoff). It is
steered, not logged, because a log the user never reads is not a diagnosis; the
model relays it in the user's language.

Announcement is once per streak (`WeakSet`), so a tripped breaker costs one
message, not one per step.

## Safety properties

| Property | How |
|---|---|
| Never worse than stock | The whole decision path is wrapped: an unexpected guard failure logs and delegates to the stock policy for that step. |
| Never concurrent | The durable `compaction/start` marker is still the lock; the guard checks it before opening a transaction. |
| Never destructive | Checkpoints and prunes both keep the shadowed events in the log and go through the harness's surface-replace protocol. |
| Never silent | Every trip logs a warning with the reason and the three numbers. |

## Test matrix

`tests/policy.test.mjs` — 11 pure tests: threshold/hysteresis, escalation
monotonicity and floor, the drain simulation, the exemption that motivates
reclaim, both breaker reasons, envelope pricing parity with the harness, the
prune primitive, diagnostic content, and a live load of the patched package.

`tests/integration.test.mjs` — 7 tests against the **real** transaction (each one
is a shape of the original failure):

| Test | Shape | Expectation |
|---|---|---|
| A | 60k of tool output per step, 16k tail budget | pruned before the threshold; no compaction needed |
| B | a long normal conversation | compact cleanly, real ranges, no fallback warnings |
| C | envelope (90k) ≥ threshold (80k) | breaker at once, one steer, zero transactions |
| D | newest message is unholdable (45k paste) | bounded attempts, then the breaker |
| E | internal error in the guard | falls back to stock, reports it |
| F | the steered diagnostic | an ordinary user message the agent can relay |
| G | manual compaction entry point | untouched |

## Porting to another engine

The decision core has no imports. To port:

1. Replace `measure()` with your own pressure + per-node pricing.
2. Implement `selectCompactableRange()` (head-anchored, tool-pairing balanced) —
   ~20 lines, see `src/index.js`.
3. Keep your existing compaction transaction as-is and call it from the loop.
4. Port the four rules above verbatim. They are the whole idea; the rest is
   plumbing.
