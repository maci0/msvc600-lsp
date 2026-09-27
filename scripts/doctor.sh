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
    fail "bun" "install bun (https://bun.sh); package.json pins bun@1.4.0 via packageManager"
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
    echo "$failures prerequisite(s) missing. Tests that need the compiler will be skipped until these are in place."
    exit 1
fi

echo "OK: all prerequisites present"
