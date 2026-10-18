/**
 * Harness binding: locates the installed harness module tree, injects its three
 * host bindings into the pure core (`src/core.js`), and exposes the guarded
 * engine class.
 *
 * Two entry points on purpose:
 *   `createGuardedEngine(Base)`              — bound to this installation (used by shim.js)
 *   `core.createGuardedCompactionEngine(Base, deps)` — portable, for another harness
 *
 * @module rea-agent-crash-postmortem
 */

import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as core from './core.js';

export {
  AGGRESSIVE_MARKER,
  GUARD_DEFAULTS,
  codePointLength,
  escalatedRetainTokens,
  guardDiagnostic,
  hasGuardMarker,
  measureHeader,
  planPressureCompaction,
  pruneBlocks,
  selectCompactableRange,
  textBlockChars,
} from './core.js';

/**
 * Locate the host harness's installed module tree.
 *
 * Absolute specifiers are deliberate: this guard is loaded from outside the
 * harness's own package tree, so a bare specifier would resolve against this
 * project's `node_modules` and hand the process a SECOND copy of the harness's
 * llm/session classes — two service registries, two message types, silent
 * breakage. Resolution is pinned to whichever tree the harness itself imported.
 *
 * @returns the modules root that contains `@deepseek-ai/dsh-compaction`.
 */
export function resolveModulesRoot() {
  const candidates = [
    process.env.DSH_MODULES_ROOT,
    process.env.DSH_GUARD_MODULES_ROOT,
    path.join(os.homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, '@deepseek-ai/dsh-compaction/lib/index.js'))) return candidate;
  }
  throw new Error(
    'rea-agent-crash-postmortem: cannot locate the harness module tree. '
    + 'Set DSH_MODULES_ROOT to the directory that contains @deepseek-ai/dsh-compaction.',
  );
}

let cached;

/**
 * Resolve (and cache) the host bindings the guard needs.
 * @returns `{ modulesRoot, toolPairingBalancedBefore, createUserMessage, freezeMessage }`.
 */
export async function resolveHostBindings() {
  if (cached !== undefined) return cached;
  const modulesRoot = resolveModulesRoot();
  const compaction = await import(pathToFileURL(path.join(modulesRoot, '@deepseek-ai/dsh-compaction/lib/index.js')).href);
  const llm = await import(pathToFileURL(path.join(modulesRoot, '@deepseek-ai/dsh-llm/lib/index.js')).href);
  cached = {
    modulesRoot,
    toolPairingBalancedBefore: compaction.toolPairingBalancedBefore,
    createUserMessage: llm.createUserMessage,
    freezeMessage: llm.freezeMessage,
  };
  return cached;
}

/**
 * Wrap a host compaction engine class, bound to this installation.
 * @param BaseCompactionEngine - the stock engine class from the harness.
 * @returns the guarded subclass.
 */
export async function createGuardedEngine(BaseCompactionEngine) {
  return core.createGuardedCompactionEngine(BaseCompactionEngine, await resolveHostBindings());
}
