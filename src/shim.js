/**
 * Drop-in replacement for `@deepseek-ai/dsh-compaction-basic/lib/index.js`.
 *
 * `src/install.sh` copies this file over the stock entry point and rewrites the
 * `__GUARD_PATH__` placeholder with the absolute path of this repository's
 * `src/index.js`. The stock engine is preserved beside it as `engine-base.js`,
 * so the undo is two shell commands (see src/install.sh).
 *
 * If the guard cannot be imported for any reason, this file falls back to the
 * stock engine and says so — a broken guard must never be worse than no guard.
 */
import BaseCompactionEngine from './engine-base.js';

const GUARD_PATH = '__GUARD_PATH__';

let Engine = BaseCompactionEngine;
try {
	const { createGuardedEngine } = await import(GUARD_PATH);
	Engine = await createGuardedEngine(BaseCompactionEngine);
} catch (error) {
	console.warn(`[agent-context-thrash] guard unavailable (${error?.message ?? error}); using stock compaction`);
}

export { Engine as BasicCompactionEngine, Engine as default };
