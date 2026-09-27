#!/bin/bash
# Setup case-insensitive MSVC6 include/lib overlay for Wine on Linux.
# Linux filesystems are case-sensitive, but MSVC headers use mixed-case #includes.
# This script creates a mirror with both upper and lowercase copies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MSVC_ROOT="$PROJECT_ROOT/VC/VC98"
DEST="$HOME/.wine/drive_c/msvc6"

if [ ! -d "$MSVC_ROOT" ]; then
    echo "ERROR: MSVC6 directory not found at $MSVC_ROOT"
    exit 1
fi

echo "Setting up case-insensitive MSVC6 overlay at $DEST ..."

mkdir -p "$DEST/include" "$DEST/lib" "$DEST/bin"

lowercase() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

uppercase() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

# Copies every file in $1 into $2 under its own name and its lowercase name.
copy_with_case_variants() {
    local src="$1" dest="$2" f base lower
    for f in "$src/"*; do
        [ -d "$f" ] && continue
        base=$(basename "$f")
        lower=$(lowercase "$base")
        cp -f "$f" "$dest/$base" 2>/dev/null || true
        if [ "$base" != "$lower" ]; then
            cp -f "$f" "$dest/$lower" 2>/dev/null || true
        fi
    done
}

echo "Copying INCLUDE files..."
copy_with_case_variants "$MSVC_ROOT/INCLUDE" "$DEST/include"

# Handle subdirectories (GL/, SYS/, OBJMODEL/)
for dir in "$MSVC_ROOT/INCLUDE/GL" "$MSVC_ROOT/INCLUDE/SYS" "$MSVC_ROOT/INCLUDE/OBJMODEL"; do
    if [ -d "$dir" ]; then
        base=$(basename "$dir")
        lower=$(lowercase "$base")
        mkdir -p "$DEST/include/$base" "$DEST/include/$lower"
        for f in "$dir/"*; do
            [ -d "$f" ] && continue
            fname=$(basename "$f")
            flower=$(lowercase "$fname")
            cp -f "$f" "$DEST/include/$base/$fname" 2>/dev/null || true
            cp -f "$f" "$DEST/include/$base/$flower" 2>/dev/null || true
            cp -f "$f" "$DEST/include/$lower/$fname" 2>/dev/null || true
            cp -f "$f" "$DEST/include/$lower/$flower" 2>/dev/null || true
        done
    fi
done

# Fix 8.3-truncated STL header names -> full standard C++ names
echo "Creating STL header aliases..."
declare -A STL_MAP=(
    ["ALGRITHM"]="algorithm"
    ["FCTIONAL"]="functional"
    ["STDXCEPT"]="stdexcept"
    ["STREAMBF"]="streambuf"
    ["STRSTREM"]="strstream"
    ["XCEPTION"]="exception"
)

for truncated in "${!STL_MAP[@]}"; do
    full="${STL_MAP[$truncated]}"
    if [ -f "$DEST/include/$truncated" ]; then
        cp -f "$DEST/include/$truncated" "$DEST/include/$full"
        cp -f "$DEST/include/$truncated" "$DEST/include/$(uppercase "$full")"
        echo "  $truncated -> $full"
    fi
done

echo "Copying LIB files..."
copy_with_case_variants "$MSVC_ROOT/LIB" "$DEST/lib"

echo "Copying BIN files..."
copy_with_case_variants "$MSVC_ROOT/BIN" "$DEST/bin"

echo "Done. MSVC6 overlay created at $DEST"
printf '  Include: %s\n' 'C:\msvc6\include'
printf '  Lib:     %s\n' 'C:\msvc6\lib'
printf '  Bin:     %s\n' 'C:\msvc6\bin'
