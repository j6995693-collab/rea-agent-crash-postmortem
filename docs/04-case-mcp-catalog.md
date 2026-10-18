# 04 — Case study: a 207-tool MCP server and the 198.5k-token request tax

This is the second half of the story, and the one that mattered more. The
compaction guard makes the engine behave; it does not make a request cheaper. The
dominant cost on this machine was never compaction at all — it was the tool
catalog.

## The measurement

```console
$ node tools/tool-catalog-size.mjs --session ~/.dsh/sessions/.../session.jsonl.zstd
tools: 233 (mcp__rea__*: 207)
  descriptions: 102,929 chars ≈ 25,732 tokens
  schemas:      701,868 chars ≈ 175,467 tokens
  total:        821,268 chars ≈ 205,317 tokens

  worst offenders:
    mcp__rea__compare_web_captures        desc    885  schema 154,738
    mcp__rea__compare_application_versions desc    419  schema  28,495
    mcp__rea__inspect_analysis_view        desc  5,781  schema  21,691
    mcp__rea__evaluate_reconstruction_coverage desc 299 schema  24,267
```

Read the last column again: **154,738 characters of argument schema for one
tool**, whose human-facing description is 885 characters. That single schema is
~38,700 tokens — larger than most people's entire system prompt, on every request,
forever.

## Why the server was not "broken"

The server's own health check was clean:

```console
$ <server> mcp doctor
healthy: true
inventory: tools expected=207 observed=207 missing=[] unexpected=[] duplicates=[]
stderr_bytes: 0
```

This is the trap. **The MCP server was healthy, its tools worked, and it was still
the problem.** Any monitoring that only asks "is the server up?" will report
green while the agent burns a fifth of its window per request. The metric that
matters is *catalog cost*, not uptime.

## Three fixes, ranked by what they cost you

### 1. Do not mount it globally (best, when you rarely need it)

A 207-tool server that is needed for one kind of task should not tax every
session. Two ways:

- Mount it only in the agent preset used for that work.
- Disable the catalog row and re-enable it when the task is actually a reverse
  engineering task.

Result here: **233 → 26 tools, 205,317 → 6,766 tokens per request (−198,551)**,
and the process stops holding ~45 MB of RSS.

Cost: you must remember to enable it. That is a workflow change, not a config
tweak, and it is the honest price of the biggest win.

### 2. Change the tool presentation (when you need all the tools)

"Code Mode" presents the whole catalog as a single code tool plus a typed SDK
section, instead of N JSON schemas:

```console
$ node tools/presentation-compare.mjs --session <session>
native JSON schemas : 821,268 chars ≈ 205,317 tokens
code-mode SDK       : 138,006 chars ≈  34,502 tokens
saving              :            ≈ 170,816 tokens (83%)
```

Result: a **170,816-token** reduction with **zero** tools removed. The same
measurement also shows when it is pointless:

```console
# with only the 26 built-in tools
native JSON schemas : 27,065 chars ≈ 6,766 tokens
code-mode SDK       : 28,013 chars ≈ 7,003 tokens   ← 237 tokens WORSE
```

So: Code Mode is a remedy for catalog breadth, not a default. Measure before
switching; switching costs a change in how the model calls tools, and at 26 tools
it buys nothing.

### 3. Fix the individual tool (when you maintain the server)

The real fix for `compare_web_captures` is that comparing two captures should
take two paths, not two inline JSON documents. A tool whose `inputSchema` is 175×
its description is a design smell: the schema is describing a payload, not a
call. Cap it, reference a file, or split it.

## The transferable lesson

1. **Measure the envelope before you tune the policy.** `H` is a constant you can
   print; everything else is a variable.
2. **Server health ≠ agent cost.** A green health check and a 198k-token tax
   coexist happily.
3. **Presentation is a lever with a threshold.** For small catalogs it is noise;
   for 200+ tool catalogs it is the whole game. Compare before switching.
4. **The biggest win is usually an absence, not a feature.** Removing a mount beat
   every code change written in this repository.
