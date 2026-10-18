#!/usr/bin/env node
/**
 * Would a different tool presentation be cheaper?
 *
 * Two ways to put a tool catalog in front of a model:
 *
 *   native     one JSON Schema per tool (what MCP servers declare)
 *   code mode  one code tool plus a typed SDK section describing the same tools
 *
 * For a broad catalog the second is dramatically smaller; for a small catalog it
 * is slightly *worse*, because the SDK render costs overhead per tool anyway.
 * Measure before switching — this script does the comparison on a real catalog.
 *
 * Usage:
 *   node tools/presentation-compare.mjs --session path/to/session.jsonl.zstd
 *   DSH_TOOLS_MODULE=/path/to/@deepseek-ai/dsh-tools/lib/index.js node tools/presentation-compare.mjs --session …
 *
 * Without the host's dsh-tools module this script prints only the native figure
 * and explains how to enable the comparison.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readEvents, lastRequestHeader } from './tool-catalog-size.mjs';

const CHARS_PER_TOKEN = 4;
const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

function locateToolsModule() {
  const candidates = [
    process.env.DSH_TOOLS_MODULE,
    process.env.DSH_MODULES_ROOT && path.join(process.env.DSH_MODULES_ROOT, '@deepseek-ai/dsh-tools/lib/index.js'),
    process.env.HOME && path.join(process.env.HOME, '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

async function main() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--session');
  if (index === -1 || argv[index + 1] === undefined) {
    console.log('usage: node tools/presentation-compare.mjs --session <session.jsonl[.zstd]>');
    process.exit(1);
  }
  const file = argv[index + 1];
  const header = lastRequestHeader(readEvents(file));
  if (header === undefined) {
    console.error('no request/header record in that session');
    process.exit(2);
  }

  const tools = Array.isArray(header.tools) ? header.tools : [];
  const nativeChars = JSON.stringify(tools).length;
  console.log(`session: ${file}`);
  console.log(`tools: ${tools.length}`);
  console.log(`native JSON schemas : ${String(nativeChars).padStart(8)} chars ≈ ${String(tokens(nativeChars)).padStart(7)} tokens`);

  const modulePath = locateToolsModule();
  if (modulePath === undefined) {
    console.log('');
    console.log('code-mode SDK       : skipped — host module not found.');
    console.log('  point DSH_MODULES_ROOT at the harness node_modules, or set DSH_TOOLS_MODULE');
    console.log('  to @deepseek-ai/dsh-tools/lib/index.js, to get the comparison.');
    return;
  }

  const toolsModule = await import(pathToFileURL(modulePath).href);
  const schemas = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? tool.parameters ?? { type: 'object' },
    output: { type: 'object' },
  }));

  let sdkChars;
  try {
    sdkChars = toolsModule.renderToolsSdkPy(schemas).length;
  } catch (error) {
    console.log('');
    console.log(`code-mode SDK       : render failed (${error.message}) — one of these schemas is not renderable`);
    return;
  }

  const delta = nativeChars - sdkChars;
  console.log(`code-mode SDK       : ${String(sdkChars).padStart(8)} chars ≈ ${String(tokens(sdkChars)).padStart(7)} tokens`);
  console.log(
    delta > 0
      ? `saving              :            ≈ ${String(tokens(delta)).padStart(7)} tokens (${Math.round((delta / nativeChars) * 100)}% smaller)`
      : `code mode is        :            ≈ ${String(tokens(-delta)).padStart(7)} tokens LARGER — keep native`,
  );
  console.log('');
  console.log('Rule of thumb from the case study: below ~50 tools the two presentations are a wash;');
  console.log('at 200+ tools code mode removed 83% of the catalog cost. See docs/04-case-mcp-catalog.md.');
}

await main();
