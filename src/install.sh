#!/bin/sh
# Install (or re-install) the anti-thrash compaction guard into an installed
# DeepSeek Harness. Idempotent: safe to run after any `npm i -g` upgrade, which
# restores the stock package.
#
#   DSH_MODULES_ROOT=/path/to/dsh/node_modules ./src/install.sh
#
# Without DSH_MODULES_ROOT the script tries the usual global install locations.
#
# What it does, inside $DSH_MODULES_ROOT/@deepseek-ai/dsh-compaction-basic:
#   1. copies the stock lib/index.js to lib/engine-base.js (once),
#   2. writes lib/index.js as the guard shim, with the absolute path of this
#      repository's src/index.js substituted for the __GUARD_PATH__ placeholder.
#
# Undo:
#   cd $DSH_MODULES_ROOT/@deepseek-ai/dsh-compaction-basic/lib
#   rm index.js && mv engine-base.js index.js
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
GUARD="$REPO/src/index.js"

if [ ! -f "$GUARD" ]; then
	echo "install.sh: missing $GUARD" >&2
	exit 1
fi

find_root() {
	for candidate in \
		"${DSH_MODULES_ROOT:-}" \
		"$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules" \
		"/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules" \
		"/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules"
	do
		if [ -n "$candidate" ] && [ -d "$candidate/@deepseek-ai/dsh-compaction-basic/lib" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

if ! ROOT=$(find_root); then
	echo "install.sh: could not find @deepseek-ai/dsh-compaction-basic." >&2
	echo "            set DSH_MODULES_ROOT to the harness's node_modules directory." >&2
	exit 1
fi

LIB="$ROOT/@deepseek-ai/dsh-compaction-basic/lib"
echo "harness:  $ROOT"
echo "compactor: $LIB"

if [ -f "$LIB/engine-base.js" ]; then
	echo "engine-base.js already present; reinstalling the shim only"
else
	cp "$LIB/index.js" "$LIB/engine-base.js"
	echo "saved the stock engine as engine-base.js"
fi

sed "s|__GUARD_PATH__|$GUARD|" "$HERE/shim.js" > "$LIB/index.js"
node --check "$LIB/index.js"
echo "installed the guard shim at $LIB/index.js"
echo "restart the harness for it to take effect (server-side plugin)."
