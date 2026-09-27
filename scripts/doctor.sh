#!/bin/bash
# Preflight for the contributor path: names every missing prerequisite instead
# of letting the first test or `bun run start` fail with a spawn error.
set -uo pipefail

usage() {
    cat <<'EOF'
Usage: doctor.sh [--help]

Checks that every prerequisite of the contributor path is present: bun, an
installed node_modules tree, shellcheck, the MSVC 6.0 tree, and on non-Windows
Wine plus the case-insensitive include overlay.

Each missing prerequisite is written to stderr. Exits 0 when all are present,
1 when any is missing, 2 on a bad argument.
EOF
}

case "${1:-}" in
-h | --help)
    usage
    exit 0
    ;;
"")
    ;;
*)
    echo "doctor.sh: unknown argument '$1'" >&2
    usage >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CL_EXE="$PROJECT_ROOT/VC/VC98/BIN/CL.EXE"
MSVC_ROOT="$PROJECT_ROOT/VC/VC98"
OVERLAY_DIR="${HOME:-}/.wine/drive_c/msvc6"

failures=0

fail() {
    echo "MISSING: $1" >&2
    echo "  fix: $2" >&2
    failures=$((failures + 1))
}

note() {
    echo "NOTE: $1"
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
Linux)
    if ! command -v wine >/dev/null 2>&1; then
        fail "wine" "install Wine, or set useWine=false and use a native Windows CL.EXE"
    elif [ ! -d "$OVERLAY_DIR/include" ]; then
        fail "case-insensitive include overlay at $OVERLAY_DIR" "run 'bun run setup'"
    fi
    ;;
Darwin)
    # macOS volumes are case-insensitive, so the lowercase include mirror the
    # setup script builds is only reachable on Linux, where it is required.
    if ! command -v wine >/dev/null 2>&1; then
        fail "wine" "install Wine (brew install --cask wine-stable), or set useWine=false and use a native Windows CL.EXE"
    else
        note "'bun run setup' is Linux-only. On macOS, set includePaths to $MSVC_ROOT/INCLUDE if CL.EXE cannot find its headers."
    fi
    ;;
*)
    if ! command -v wine >/dev/null 2>&1; then
        fail "wine" "install Wine, or set useWine=false and use a native Windows CL.EXE"
    fi
    ;;
esac

if [ "$failures" -gt 0 ]; then
    {
        echo
        echo "$failures prerequisite problem(s). Tests that need the compiler will be skipped until these are in place."
    } >&2
    exit 1
fi

echo "OK: all prerequisites present"
