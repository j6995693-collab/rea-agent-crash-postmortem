# 01 — The symptom

## What the user sees

> Autocompact is thrashing: the context refilled to the limit within 3 turns of
> the previous compact, 3 times in a row. A file being read or a tool output is
> likely too large for the context window. Try reading in smaller chunks, or use
> /clear to start fresh.

Or, in the generic form the user actually complains about:

> 聊着聊着说这个 Prompt 超长了，然后就开始卡住。
> ("it chats for a while, then says the prompt is too long, then it just freezes")

Three distinct things are being described as one:

1. **A refusal** — the harness decides the prompt is too long and stops.
2. **A stall** — every retry costs a full-size request, so the UI shows nothing
   for minutes at a time and looks hung.
3. **Thrash** — compaction runs, nothing improves, compaction runs again.

Users read all three as "the agent broke". They are different failure modes with
different fixes, and the first job of a debug session is to say which one is
happening.

## Why it looks like a hang

A compaction is not free. It is itself a model request that replays the whole
prefix so the provider's KV cache still applies. So one "compaction event" costs
roughly one full-size request, at the exact moment the request is already at its
largest.

Measured on the real case in this repository: a single compaction ran over
**792,169 prompt tokens** and shadowed **309,476** of them. On a busy 1M-token
session that is tens of seconds of silence, twice — once for the request that
overflowed, once for the summary — before anything appears on screen.

Thrash makes it worse in a way that is invisible to the user: the same full-size
request is paid *per step*.

## The three questions to answer first

Before touching a policy, answer these with measurements (see
[02-forensics.md](02-forensics.md)):

| Question | Why it decides the fix |
|---|---|
| How big is the **request envelope** (system prompt + tool schemas) compared with the threshold? | If the envelope alone reaches the threshold, no message compaction can ever help. The fix is to shrink the envelope, not to tune compaction. |
| Did compaction ever get the window **below** the threshold? | If yes and it refilled, the retention policy is the problem. If no, the floor is the problem. |
| What is the **largest single message** on the surface, and is it newer than the retained tail? | This is the exemption described in [03-root-causes.md](03-root-causes.md) §2. A single oversized node is invisible to every aggregate metric. |

Each of the three has a different remedy. Guessing at them is how people end up
lowering `thresholdRatio` and calling it a fix.
