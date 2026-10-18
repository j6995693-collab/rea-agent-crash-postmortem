# 02 — Forensics: measuring a context problem with facts

The entire diagnosis in this repository came out of **session logs**, not from
reading the engine. If your harness logs requests, you can do the same. The
three scripts in `tools/` are the generalized versions of what was run here.

## The four numbers that matter

| Number | Where it comes from | What it tells you |
|---|---|---|
| `contextWindow` | the harness's model catalog, or the provider's `request/context` record | the denominator. Get this wrong and every other conclusion is wrong — measured 1,000,000 here while the account's practical ceiling was never verified |
| provider-reported **pressure** | usage on the assistant message: `input + cache_read + cache_write` | the *real* numerator. Cheaper and more trustworthy than any local estimate |
| **envelope** cost | `len(system) / 4 + len(JSON.stringify(tools)) / 4` | the irreducible part. Everything else is commentary |
| **per-message** prices | your token meter's estimate for each surface message | only needed once you suspect a single oversized node |

`tools/scan-sessions.mjs` produces the first three for every session; `tools/tool-catalog-size.mjs`
produces the envelope breakdown; `tools/presentation-compare.mjs` answers "would
another presentation be cheaper".

## Reading a compaction transaction

A replay-safe compaction is not a buffer edit — it is a small transaction with
its own audit trail. The harness used here logs:

```text
compaction/start      ← opens the transaction, also the concurrency lock
compaction/summary    ← the checkpoint text + shadowedTokenCount (the price of
                        the exact range being replaced)
user/message          ← the replacement checkpoint node (surfaceOp: replace)
compaction/end        ← closes the transaction
```

`shadowedTokenCount` is the number you want: it is the amount of context the
transaction actually bought back. Two checks against it answer question 2 from
[01-symptom.md](01-symptom.md):

- `shadowed / (total_before)` — if this is small, the tail is eating the window.
- `total_after ≥ threshold` — if this holds right after a successful
  transaction, the policy will fire again immediately.

In the real case: `shadowedTokenCount = 309,476` on a `792,169`-token request.
The transaction was real, the reduction was real, and the window was still ~480k
full afterwards because a fixed verbatim tail was kept plus an uncounted floor.

## A note on heuristic prices

Most harnesses price content with `chars / 4` plus a small per-block overhead.
It is wrong in absolute terms (Japanese, code and JSON all disagree) but it is
*consistent*, which is what matters: a policy that compares two heuristic prices
makes correct decisions even when both are 15% off. Use the provider-reported
number for the headline metric and the heuristic for internal budgeting — that
is exactly the split the guarded engine makes (see
[05-fix-compaction-guard.md](05-fix-compaction-guard.md)).

## Worked example

```console
$ node tools/scan-sessions.mjs --sessions ~/.dsh/sessions
sessions: 39
  sessions with a compaction: 1
  max pressure seen: 792,169 / 1,000,000 tokens (79%)
  session      pressure   window    compactions  shadowed   prunes  errors
  8a06bcad…    792,169    1,000,000 1            309,476    16      0
  0d581bf3…    380,757    1,000,000 0            -          0       0
  ccaabcbb…    333,054    1,000,000 0            -          0       0
  …

$ node tools/tool-catalog-size.mjs --session <newest session>
tools: 233 (rea: 207)
  descriptions: 102,929 chars ≈ 25,732 tokens
  schemas:      701,868 chars ≈ 175,467 tokens
  total:        821,268 chars ≈ 205,317 tokens
  worst: compare_web_captures desc 885 schema 154,738
```

The first command says: compaction works, it just does not hold. The second says:
the envelope is a quarter of the window. Both are actionable, and neither needed
a profiler, a debugger, or a guess.
