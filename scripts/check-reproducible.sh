#!/bin/bash
# Proves the build is reproducible: two clean builds of the same source must
# produce byte-identical output. The second build runs under a different locale
# and timezone so a leak of either into the emitted files fails here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

SNAPSHOT_DIR="$(mktemp -d)"
trap 'rm -rf "$SNAPSHOT_DIR"' EXIT

build() {
    rm -rf dist
    LC_ALL="$1" TZ="$2" ./node_modules/.bin/tsc -p tsconfig.json
}

build C UTC
cp -r dist "$SNAPSHOT_DIR/first"

build de_DE.UTF-8 Asia/Tokyo

if diff -r "$SNAPSHOT_DIR/first" dist; then
    echo "OK: two builds of the same source produced identical output"
else
    echo "ERROR: the build is not reproducible; see the diff above" >&2
    exit 1
fi
