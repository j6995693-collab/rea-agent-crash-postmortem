#!/usr/bin/env node
/**
 * How close did each session get to the wall — and did compaction ever converge?
 *
 * Walks a harness session directory (`<root>/<workspace>/<session>/session.jsonl.zstd`),
 * and for every session reports:
 *
 *   pressure     provider-reported prompt pressure: input + cache read + cache write
 *   window       the model's advertised context window
 *   transactions compaction/start count
 *   shadowed     tokens each compaction actually bought back
 *   prev/post    whether the window went below the threshold right after a compaction
 *   errors       failure codes (context-window-exceeded shows up here)
 *
 * Usage:
 *   node tools/scan-sessions.mjs --sessions ~/.dsh/sessions
 *   node tools/scan-sessions.mjs --sessions ~/.dsh/sessions --threshold 0.8
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readEvents } from './tool-catalog-size.mjs';

const fraction = (window, usage) => {
  const pressure = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
  return pressure;
};

/** Every `session.jsonl.zstd` (or `.jsonl`) below a root. */
function findSessions(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^session\.jsonl(\.zstd)?$/.test(entry.name)) found.push(full);
    }
  };
  walk(root, 0);
  return found.sort();
}

function analyse(file, thresholdRatio) {
  const events = readEvents(file);
  if (events.length === 0) return undefined;

  const stats = {
    file,
    window: undefined,
    maxPressure: 0,
    compactions: [],
    prunes: 0,
    tools: undefined,
    errors: new Set(),
  };

  for (const event of events) {
    if (event.type === 'request/context' && Number.isInteger(event.data?.contextWindow)) {
      stats.window = event.data.contextWindow;
    }
    if (event.type === 'request/header') {
      const tools = event.data?.header?.tools ?? event.data?.tools;
      if (Array.isArray(tools)) stats.tools = tools.length;
    }
    if (event.type === 'compaction/start') stats.compactions.push({ startSeq: event.seq });
    if (event.type === 'compaction/summary') {
      const open = stats.compactions[stats.compactions.length - 1];
      if (open !== undefined) {
        open.shadowed = event.data?.shadowedTokenCount;
        open.range = event.data?.shadowedRange;
      }
    }
    if (event.type === 'compaction/prune') stats.prunes += 1;
    if (/error/i.test(String(event.type)) && event.type !== 'assistant/chunk') {
      const code = event.data?.failure?.code ?? event.data?.error?.code ?? event.data?.code;
      if (typeof code === 'string') stats.errors.add(code);
    }
    const usage = event.type === 'assistant/message'
      ? event.data?.usage
      : (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage' ? event.data.chunk.usage : undefined);
    if (usage !== undefined) stats.maxPressure = Math.max(stats.maxPressure, fraction(stats.window, usage));
  }

  if (stats.window !== undefined) stats.threshold = Math.round(stats.window * thresholdRatio);
  return stats;
}

function main() {
  const argv = process.argv.slice(2);
  let root = path.join(process.env.HOME ?? '', '.dsh/sessions');
  let thresholdRatio = 0.8;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--sessions') { root = argv[index + 1]; index += 1; }
    else if (argv[index] === '--threshold') { thresholdRatio = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('usage: node tools/scan-sessions.mjs --sessions <dir> [--threshold 0.8]');
      process.exit(0);
    }
  }

  let files;
  try {
    files = findSessions(root);
  } catch (error) {
    console.error(`cannot read ${root}: ${error.message}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`no session logs under ${root}`);
    process.exit(1);
  }

  const rows = [];
  for (const file of files) {
    try {
      const row = analyse(file, thresholdRatio);
      if (row !== undefined) rows.push(row);
    } catch (error) {
      rows.push({ file, broken: error.message });
    }
  }
  rows.sort((left, right) => (right.maxPressure ?? 0) - (left.maxPressure ?? 0));

  const withCompaction = rows.filter((row) => (row.compactions?.length ?? 0) > 0).length;
  const totalTransactions = rows.reduce((sum, row) => sum + (row.compactions?.length ?? 0), 0);
  const worst = rows[0];

  console.log(`sessions: ${rows.length}`);
  console.log(`  sessions with a compaction: ${withCompaction}`);
  console.log(`  compaction transactions: ${totalTransactions}`);
  if (worst?.window) {
    console.log(`  max pressure seen: ${worst.maxPressure.toLocaleString()} / ${worst.window.toLocaleString()} tokens (${Math.round((worst.maxPressure / worst.window) * 100)}%)`);
  }
  console.log('');
  console.log('session                    interface  pressure    window   comp  shadowed  prunes  tools  errors');
  for (const row of rows.slice(0, 15)) {
    if (row.broken !== undefined) {
      console.log(`${path.basename(path.dirname(row.file)).slice(0, 26).padEnd(26)}  <unreadable: ${row.broken}>`);
      continue;
    }
    const id = path.basename(path.dirname(row.file)).replace(/^session-/, '').slice(0, 26);
    const shadowed = row.compactions.filter((c) => typeof c.shadowed === 'number').map((c) => c.shadowed);
    console.log(
      `${id.padEnd(26)}  ${String(row.maxPressure).padStart(9)}  ${String(row.window ?? '-').padStart(9)}  `
      + `${String(row.compactions.length).padStart(4)}  ${String(shadowed.length ? Math.max(...shadowed) : '-').padStart(8)}  `
      + `${String(row.prunes).padStart(6)}  ${String(row.tools ?? '-').padStart(5)}  ${[...row.errors].join(',') || '-'}`,
    );
  }
  console.log('');
  console.log('read it as: no compactions + high pressure ⇒ the threshold never fired (raise pressure earlier,');
  console.log('or the window is smaller than the policy believes). Compactions + pressure pinned at the');
  console.log('threshold ⇒ thrash: the retention policy is not converging. See docs/03-root-causes.md.');
}

main();

void statSync;
