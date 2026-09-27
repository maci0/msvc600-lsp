#!/bin/bash
# Preflight for the contributor path: names every missing prerequisite instead
# of letting the first test or `bun run start` fail with a spawn error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CL_EXE="$PROJECT_ROOT/VC/VC98/BIN/CL.EXE"
OVERLAY_DIR="$HOME/.wine/drive_c/msvc6"

failures=0

fail() {
    echo "MISSING: $1"
    echo "  fix: $2"
    failures=$((failures + 1))
}

if ! command -v bun >/dev/null 2>&1; then
    fail "bun" "install the version package.json pins via packageManager (https://bun.sh)"
else
    pinned_bun=$(BUN_MANIFEST="$PROJECT_ROOT/package.json" bun -e 'const { packageManager } = require(process.env.BUN_MANIFEST); console.log(packageManager.replace(/^bun@/, ""))' 2>/dev/null)
    if [ -z "$pinned_bun" ]; then
        fail "packageManager pin in package.json" "the field is missing or unreadable; the bun version the lockfile was written by is unknown"
    elif [ "$pinned_bun" != "$(bun --version)" ]; then
        fail "bun $pinned_bun" "package.json pins bun@$pinned_bun via packageManager, found $(bun --version); the lockfile is written by that version"
    fi
fi

if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    fail "node_modules" "run 'bun install'"
fi

if ! command -v shellcheck >/dev/null 2>&1; then
    fail "shellcheck" "install ShellCheck; 'bun run check' lints scripts/*.sh with it"
fi

if [ ! -x "$CL_EXE" ] && [ ! -f "$CL_EXE" ]; then
    fail "MSVC 6.0 at VC/VC98/BIN/CL.EXE" "copy the MSVC 6.0 tree into VC/VC98 (it is not in git)"
fi

case "$(uname -s)" in
MINGW* | CYGWIN*) ;;
*)
    if ! command -v wine >/dev/null 2>&1; then
        fail "wine" "install Wine, or set useWine=false and use a native Windows CL.EXE"
    elif [ ! -d "$OVERLAY_DIR/include" ]; then
        fail "case-insensitive include overlay at $OVERLAY_DIR" "run 'bun run setup'"
    fi
    ;;
esac

if [ "$failures" -gt 0 ]; then
    echo
    echo "$failures prerequisite problem(s). Tests that need the compiler will be skipped until these are in place."
    exit 1
fi

echo "OK: all prerequisites present"
