/**
 * Shared test helpers: locate the host harness once, and skip cleanly when this
 * machine has no installation (the pure-core tests never need it).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function findModulesRoot() {
  const candidates = [
    process.env.DSH_MODULES_ROOT,
    process.env.HOME && path.join(process.env.HOME, '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  return candidates.find((candidate) => existsSync(path.join(candidate, '@deepseek-ai/dsh-compaction/lib/index.js')));
}

export const modulesRoot = findModulesRoot();

/** Import one entry from the host harness tree. */
export async function importHarness(entry) {
  if (modulesRoot === undefined) throw new Error('no harness installation found');
  return await import(pathToFileURL(path.join(modulesRoot, entry)).href);
}

/** A real cordis Context from the host tree, or undefined without one. */
export async function makeContext() {
  if (modulesRoot === undefined) return undefined;
  const { Context } = await importHarness('@deepseek-ai/cordis/lib/index.js');
  return new Context();
}

export const skipReason = 'no DeepSeek Harness installation found — set DSH_MODULES_ROOT to the harness node_modules';
