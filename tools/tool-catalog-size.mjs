#!/usr/bin/env node
/**
 * What is actually in the request envelope?
 *
 * Reads a session log (.jsonl or .jsonl.zstd), finds the last `request/header`
 * record, and prices the tool catalog the way a host token meter does
 * (characters / 4). Prints the split that decides the fix:
 *
 *   descriptions  — cheap; trimming them buys little
 *   JSON schemas  — usually 80-90% of the cost, and the thing to attack
 *
 * Usage:
 *   node tools/tool-catalog-size.mjs --session path/to/session.jsonl.zstd [--top 10]
 *   node tools/tool-catalog-size.mjs --session s.jsonl --prefix mcp__rea__
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const CHARS_PER_TOKEN = 4;

export function readSessionLines(file) {
  const raw = readFileSync(file);
  const isZstd = file.endsWith('.zstd')
    || (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd);
  if (!isZstd) return raw.toString('utf8').split('\n').filter((line) => line.length > 0);

  // Append-only session logs are a CONCATENATION of zstd frames (one per flush).
  // Node's built-in decoder stops after the first frame, so prefer the CLI, which
  // streams all of them. Falling back is supported, with a warning, because a
  // half-read log produces a confidently wrong report.
  for (const [bin, args] of [['zstd', ['-dc', file]], ['unzstd', ['-c', file]]]) {
    try {
      const out = execFileSync(bin, args, { maxBuffer: 1024 * 1024 * 1024 });
      return out.toString('utf8').split('\n').filter((line) => line.length > 0);
    } catch {
      // try the next decoder
    }
  }

  const decoded = zlib.zstdDecompressSync(raw).toString('utf8');
  process.stderr.write(
    'warning: no zstd CLI found — decoded only the FIRST frame of a multi-frame log.\n'
    + '         install zstd (brew install zstd) for a complete picture.\n',
  );
  return decoded.split('\n').filter((line) => line.length > 0);
}

export function readEvents(file) {
  const events = [];
  for (const line of readSessionLines(file)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // a torn last line from a live session is expected; skip it
    }
  }
  return events;
}

/** Last canonical request envelope in the log, or undefined. */
export function lastRequestHeader(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'request/header') return event.data.header ?? event.data;
  }
  return undefined;
}

const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

function parseArgs(argv) {
  const args = { session: undefined, top: 8, prefix: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--session') { args.session = value; index += 1; }
    else if (key === '--top') { args.top = Number(value); index += 1; }
    else if (key === '--prefix') { args.prefix = value; index += 1; }
    else if (key === '--help' || key === '-h') { args.help = true; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.session === undefined) {
    console.log('usage: node tools/tool-catalog-size.mjs --session <session.jsonl[.zstd]> [--top 8] [--prefix mcp__server__]');
    process.exit(args.help ? 0 : 1);
  }

  const header = lastRequestHeader(readEvents(args.session));
  if (header === undefined) {
    console.error('no request/header record in that session — nothing was sent yet');
    process.exit(2);
  }

  const tools = Array.isArray(header.tools) ? header.tools : [];
  let descChars = 0;
  let schemaChars = 0;
  const rows = [];
  for (const tool of tools) {
    const description = typeof tool.description === 'string' ? tool.description.length : 0;
    const schema = JSON.stringify(tool.inputSchema ?? tool.parameters ?? {}).length;
    descChars += description;
    schemaChars += schema;
    rows.push({ name: tool.name, description, schema, total: JSON.stringify(tool).length });
  }
  rows.sort((left, right) => right.total - left.total);

  const systemChars = typeof header.system === 'string' ? header.system.length : 0;
  const totalChars = JSON.stringify(tools).length;

  const prefixed = args.prefix
    ? tools.filter((tool) => tool.name.startsWith(args.prefix)).length
    : null;

  console.log(`session: ${args.session}`);
  console.log(`tools: ${tools.length}${prefixed === null ? '' : ` (${args.prefix}*: ${prefixed})`}`);
  console.log(`  system prompt  ${String(systemChars).padStart(9)} chars ≈ ${String(tokens(systemChars)).padStart(8)} tokens`);
  console.log(`  descriptions   ${String(descChars).padStart(9)} chars ≈ ${String(tokens(descChars)).padStart(8)} tokens`);
  console.log(`  json schemas   ${String(schemaChars).padStart(9)} chars ≈ ${String(tokens(schemaChars)).padStart(8)} tokens  (${Math.round((schemaChars / Math.max(1, totalChars)) * 100)}% of the catalog)`);
  console.log(`  catalog total  ${String(totalChars).padStart(9)} chars ≈ ${String(tokens(totalChars)).padStart(8)} tokens`);
  console.log('');
  console.log(`top ${Math.min(args.top, rows.length)} by size:`);
  for (const row of rows.slice(0, args.top)) {
    console.log(`  ${row.name.padEnd(42)} desc ${String(row.description).padStart(6)}  schema ${String(row.schema).padStart(7)}  total ${String(row.total).padStart(7)}`);
  }
  const fattest = rows[0];
  if (fattest !== undefined && fattest.description > 0 && fattest.schema > fattest.description * 20) {
    console.log('');
    console.log(`note: ${fattest.name} has ${Math.round(fattest.schema / fattest.description)}× more schema than description —`);
    console.log('      the schema is describing a payload, not a call. That tool is a design bug, not a tuning problem.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
