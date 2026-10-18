# rea-agent-crash-postmortem

**How the REA project (a 207-tool MCP server) took this machine's local agent down entirely — the investigation, the four root causes, and the fix that brought it back.**

> **TL;DR** — The local agent kept collapsing: sessions froze mid-task, the prompt was reported as "too long", and every recovery attempt cost minutes of silence. The cause was the **REA** MCP server (`rea-agents` v6.5.0): it alone added ~198,500 tokens of JSON schema to *every* request, which shoved the conversation into a context-window thrash loop the stock compaction engine could not escape. We instrumented the sessions, found four separate mechanisms behind the collapse, fixed the engine (this repo), and removed the REA mount. The agent has run without a single thrash since.

Every agent harness eventually hits the same wall: a long session fills the context window, the automatic compaction fires, the window fills up again two steps later, and the agent either loops forever or freezes. Claude Code puts it plainly:

> Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.

That message names the symptom, not the mechanism — and in our case its advice (read smaller chunks, start fresh) was useless, because the cost lived in the request envelope, not in the transcript. This repository is what actually happened when we instrumented a real 1M-token session and pulled it apart: the guarded compaction engine that fixed the engine side, the forensic scripts used to measure it, and how the same method found the larger cause hiding behind the smaller one.

The diagnosis method is not tied to one harness — it works on anything that logs requests — and the compaction guard is written against the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) compaction seam but reads as a design document for any engine that does "summarize old turns, keep a verbatim tail".

---

## The four findings behind the crash

| # | Finding | Measured |
|---|---------|----------|
| 1 | **A fixed verbatim tail cannot converge.** The engine kept `0.16 × window` verbatim on *every* compaction. When one step adds more than `threshold − header − tail`, the window refills before the next step, so it compacts again at the exact same size, forever. | window 1,000,000 → threshold 800,000, kept tail 160,000; the one real compaction in 39 sessions fired at 792,169 tokens and shadowed 309,476 |
| 2 | **The newest node is exempt from compaction.** Selection walks back from the end until the tail reaches its budget, so a *single* large tool result survives every compaction intact and refills the window by itself. | one REA tool (`compare_web_captures`) contributed 154,738 characters of `inputSchema` alone |

And the second layer, found by measuring instead of guessing:

| # | Finding | Measured |
|---|---------|----------|
| 3 | **The non-compactable part of the request is invisible to the policy.** System prompt + tool schemas ride every request and no amount of message compaction touches them. The **REA** MCP server (207 tools, `rea-agents` v6.5.0) cost **198,551 tokens per request** — 84% of the entire catalog budget, on a server whose own health check reported `healthy: true`. | tool catalog: 233 tools / 821,268 chars ≈ 205,317 tokens → after removing that server: 26 tools / 27,065 chars ≈ **6,766 tokens** |
| 4 | **Nothing counts failures.** No consecutive-compaction counter, no escalating budget, no circuit breaker, no diagnosis. The engine retried the same futile operation every step. | the stock engine's only exit was a thrown "still above threshold" warning, once per step |

The fix has three halves — because the REA crash needed all three:

- **`src/` — a guarded compaction engine** (`dsh-compaction-guard`): escalating retention, oversized-node reclaim, a circuit breaker, and one honest steered diagnostic carrying real numbers. 20 tests, seven of them exercising the *real* compaction transaction.
- **`tools/` — the forensics** that produced every number above, generalized so you can run them on your own session logs. This is what pointed at REA in the first place: one MCP server owned 84% of the tool catalog.
- **the mount itself** — the single biggest win was not code. Unmounting the REA server took the request envelope from **205,317 → 6,766 tokens**, i.e. **198,551 tokens freed per request**, and the crash stopped.

---

## Quick start

### Diagnose your own sessions first

```bash
# 1. What is actually in your context? (needs no harness internals)
node tools/tool-catalog-size.mjs --session path/to/session.jsonl.zstd
#   → total tokens, split into descriptions vs JSON Schema, worst offenders

# 2. How close did you get to the wall, and did compaction ever converge?
node tools/scan-sessions.mjs --sessions ~/.dsh/sessions
#   → per session: max provider-reported pressure, context window, compaction
#     transactions, shadowed tokens, error codes

# 3. Would a different tool presentation be cheaper?
node tools/presentation-compare.mjs --session path/to/session.jsonl.zstd
#   → native JSON schemas vs Code Mode SDK section, in tokens
```

If step 1 says one server owns most of your catalog, you already know why the
window refills: no compaction policy can remove a cost that lives in the request
envelope. See [`docs/04-case-mcp-catalog.md`](docs/04-case-mcp-catalog.md).

### Install the guard (DeepSeek Harness)

```bash
# point at the harness's installed module tree
export DSH_MODULES_ROOT="$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules"

./src/install.sh                 # idempotent; keeps the stock engine as engine-base.js
# restart the harness — it is a server-side plugin
```

Undo:

```bash
cd "$DSH_MODULES_ROOT/@deepseek-ai/dsh-compaction-basic/lib"
rm index.js && mv engine-base.js index.js
```

### Run the tests

```bash
node --test tests/*.test.mjs
```

The integration half binds the guard to the **real** compaction transaction from
the installed harness (start marker, shadow price, surface replace, end marker,
tool-pairing balance). Without an installation those tests skip with a reason
instead of failing.

---

## What changed, in behaviour

| Situation | Stock policy | Guarded policy |
|---|---|---|
| Window over threshold | Compact, keep `retainRatio × window` verbatim | Compact, keep the same tail **the first time** |
| Refills within a step or two | Compact again at the same size, indefinitely | Halve the tail each consecutive run (160k → 80k → 40k → 20k → 8k floor) so the context monotonically drains |
| One tool result larger than the tail budget | Retained verbatim forever; nothing can compact it | Re-pruned head/middle/tail through the replay-safe shadow-price protocol, before the range is selected |
| Tool schemas alone exceed the threshold | Summarize anyway (a full-size request that changes nothing) | Trip the breaker immediately, spend nothing, and say why |
| Four compactions in a row without holding | Keep trying every step | Stop, and steer exactly one message with the measured breakdown |

The diagnostic the agent receives is deliberately boring and checkable:

```text
[context guard] Automatic compaction cannot free enough context here, ...
Occupancy: ~930000 tokens of a 1000000-token window (93%; compaction threshold 800000).
  system prompt ~1510 tokens
  tool schemas ~205103 tokens across 232 tools
  conversation surface ~720000 tokens across 41 messages
The non-compactable part (system prompt + tool schemas) is ~206613 tokens, ...
```

---

## Repository map

```
docs/01-symptom.md          the error, what the user sees, why it feels like a hang
docs/02-forensics.md        the measurement method: logs, request envelopes, pricing
docs/03-root-causes.md      the four mechanisms, with the code that causes them
docs/04-case-mcp-catalog.md the 207-tool server and the 198.5k-token request tax
docs/05-fix-compaction-guard.md  design + test matrix of the guard
src/index.js                the guarded engine (framework-agnostic decision core)
src/shim.js                 drop-in replacement for the stock compaction entry
src/install.sh              idempotent installer with a documented undo
tools/                      the three forensic scripts behind every number above
tests/                      policy unit tests + end-to-end transaction tests
```

## Honest limits

- The numbers come from one machine (macOS, 1M-token model, DeepSeek Harness
  `0.1.0-rc.6`). The *method* generalizes; the constants do not.
- The guard reads the harness's internal token meter, session surface and
  compaction seam. It is a patch against a specific engine, not a universal
  library — but `docs/03` and `docs/05` are written so you can port the four
  rules to another engine without reading the code.
- The fix does not make a too-small window bigger. When the request envelope
  alone exceeds the threshold, the honest answer is "remove or shrink the
  envelope", which is what the breaker says out loud instead of looping.

## License

MIT. See [LICENSE](LICENSE).
