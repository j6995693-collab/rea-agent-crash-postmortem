# 03 — The four root causes

Each cause is stated as a mechanism, with the smallest piece of code that makes
it inevitable. All four were present at once; fixing any one of them alone would
have looked like a partial success.

---

## 1. A fixed verbatim tail cannot converge

The selection rule is "compact from the head, keep a priced tail":

```js
let accumulated = 0;
let keepFromIdx = pricedNodes.length;
for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
  accumulated += pricedNodes[index].tokens;
  keepFromIdx = index;
  if (accumulated >= retainTokens) break;   // ← the same budget, every run
}
```

`retainTokens` is derived from the window once (`0.16 × contextWindow`) and
reused forever. Define:

- `H` = envelope (system + tools), not compactable
- `R` = retained tail
- `B` = tokens one step adds
- `T` = threshold

After a compaction the window holds `≈ H + R`. If `H + R + B ≥ T`, the very next
step is over the threshold again, and the next compaction keeps `R` again. The
state machine is a fixed point that sits above the threshold: **it never
converges, and every iteration costs a full-size request.**

The fix is not "compact harder" — it is to make the budget a function of how many
consecutive failures have happened (`retain × decay^n`, floored). See
[05](05-fix-compaction-guard.md).

---

## 2. The newest node is exempt, so one big tool result is immortal

The walk-back loop stops as soon as the tail reaches its budget — and the tail
always includes the newest node. A 300k-token tool result with a 160k budget
leaves the loop at index `len-1`:

```text
nodes = [ 5k, 300k ]   retainTokens = 160k
walk: accumulated = 300k ≥ 160k  →  keepFromIdx = 1
result: compact nodes[0..0], keep nodes[1] verbatim
```

So the single node that is *most* responsible for the overflow is the one node
that can never be compacted away. The aggregate metrics look fine — one
transaction ran, `shadowedTokenCount` is substantial — and the window is still
too full.

Two ways out, and they are not equivalent:

- **Compact it into the summary.** Cheap, but it destroys tool output the model
  is still working with, and it cannot be undone.
- **Re-prune it.** Keep head and tail, elide the middle, keep the original in the
  log for replay. This is what the guard does, and it is why the fix is
  "reclaim oversized tool results" rather than "compact the tail too".

---

## 3. The envelope is invisible to the policy

Every request carries a system prompt and a tool schema set that the session
surface does not own, so a policy that only measures messages is blind to it:

| Catalog | Characters | ≈ tokens | Share of a 1M window |
|---|---:|---:|---:|
| 233 tools (207 from one MCP server + 26 built-in) | 821,268 | 205,317 | 21% |
| … of which argument JSON Schema | 701,868 | 175,467 | 17.5% |
| … of which descriptions | 102,929 | 25,732 | 2.6% |
| 26 built-in tools only | 27,065 | 6,766 | 0.7% |

Note the shape of the distribution: descriptions are 12.5% of the cost, schemas
are 85.5%. A catalog that reads as "32 pages of prose" may actually be "175k
tokens of JSON Schema". One tool contributed **154,738 characters** of
`inputSchema` while its description was 885 characters.

When `H ≥ T`, compaction is provably useless — but a policy that never computes
`H` will keep trying, at full request price, forever. That is cause 4's job.

---

## 4. Nothing counts failures

The stock engine's loop was bounded per call:

```js
for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
  result = await this.compactRegion(range.start, range.end, agent, signal);
  measurement = meter.measure(agent.session);
  if (measurement.totalTokens < spec.thresholdTokens) return result;
}
throw new Error(`still above threshold after ${spec.compactionRetries + 1} attempts`);
```

`compactionRetries` defaulted to 1, so the engine gave up *within* one call — but
the caller (`agent/pre-step`) simply continued the turn, and the next step called
it again. There was no memory across steps of *how many times this has already
failed*, so:

- no escalation (cause 1 could never be worked around),
- no circuit breaker (a provably hopeless case cost a full request per step),
- no diagnosis (the user saw a generic warning in a log they do not read).

A counter and a floor computation are enough to turn all three into one honest
message. That is the entire "breaker" half of the guard.

---

## They interact

The failure that produced this repository needed all four:

1. The envelope was 205k of a 1M window, so the usable budget was 594k, not 800k.
2. A tool result larger than the retained tail survived every compaction (cause 2).
3. The fixed tail guaranteed refill (cause 1).
4. Nothing stopped the loop (cause 4).

Diagnosing them one at a time is why it took four separate measurements — and
why "lower the threshold" and "read files in smaller chunks" (the advice in the
original error message) both failed to fix it.
