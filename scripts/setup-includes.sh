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

# Copy all include files with both original and lowercase names
echo "Copying INCLUDE files..."
for f in "$MSVC_ROOT/INCLUDE/"*; do
    [ -d "$f" ] && continue  # skip subdirs, handled below
    base=$(basename "$f")
    lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
    cp -f "$f" "$DEST/include/$base" 2>/dev/null || true
    if [ "$base" != "$lower" ]; then
        cp -f "$f" "$DEST/include/$lower" 2>/dev/null || true
    fi
done

# Handle subdirectories (GL/, SYS/, OBJMODEL/)
for dir in "$MSVC_ROOT/INCLUDE/GL" "$MSVC_ROOT/INCLUDE/SYS" "$MSVC_ROOT/INCLUDE/OBJMODEL"; do
    if [ -d "$dir" ]; then
        base=$(basename "$dir")
        lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
        mkdir -p "$DEST/include/$base" "$DEST/include/$lower"
        for f in "$dir/"*; do
            [ -d "$f" ] && continue
            fname=$(basename "$f")
            flower=$(echo "$fname" | tr '[:upper:]' '[:lower:]')
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
        FULL_UPPER=$(echo "$full" | tr '[:lower:]' '[:upper:]')
        cp -f "$DEST/include/$truncated" "$DEST/include/$FULL_UPPER"
        echo "  $truncated -> $full"
    fi
done

# Copy LIB files
echo "Copying LIB files..."
for f in "$MSVC_ROOT/LIB/"*; do
    [ -d "$f" ] && continue
    base=$(basename "$f")
    lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
    cp -f "$f" "$DEST/lib/$base" 2>/dev/null || true
    if [ "$base" != "$lower" ]; then
        cp -f "$f" "$DEST/lib/$lower" 2>/dev/null || true
    fi
done

# Copy BIN files
echo "Copying BIN files..."
for f in "$MSVC_ROOT/BIN/"*; do
    [ -d "$f" ] && continue
    base=$(basename "$f")
    lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
    cp -f "$f" "$DEST/bin/$base" 2>/dev/null || true
    if [ "$base" != "$lower" ]; then
        cp -f "$f" "$DEST/bin/$lower" 2>/dev/null || true
    fi
done

echo "Done. MSVC6 overlay created at $DEST"
echo "  Include: C:\\msvc6\\include"
echo "  Lib:     C:\\msvc6\\lib"
echo "  Bin:     C:\\msvc6\\bin"
