#!/bin/bash
# Setup case-insensitive MSVC6 include/lib overlay for Wine on Linux.
# Linux filesystems are case-sensitive, but MSVC headers use mixed-case #includes.
# This script creates a mirror with both upper and lowercase copies.
set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MSVC_ROOT="$PROJECT_ROOT/VC/VC98"
DEST="$HOME/.wine/drive_c/msvc6"

if [ ! -d "$MSVC_ROOT" ]; then
    echo "ERROR: MSVC6 directory not found at $MSVC_ROOT"
    exit 1
fi

for required in INCLUDE LIB BIN; do
    if [ ! -d "$MSVC_ROOT/$required" ]; then
        echo "ERROR: $MSVC_ROOT/$required is missing; the overlay would be incomplete"
        exit 1
    fi
done

echo "Setting up case-insensitive MSVC6 overlay at $DEST ..."

mkdir -p "$DEST/include" "$DEST/lib" "$DEST/bin"

failures=0

# Copy $1 into $2 under each of the names in $3 onward, counting any that fail
# so a partial overlay is reported instead of silently produced.
copy_as() {
    local src=$1 dest_dir=$2
    shift 2
    local name
    for name in "$@"; do
        if ! cp -f -- "$src" "$dest_dir/$name"; then
            echo "ERROR: cannot copy $src to $dest_dir/$name" >&2
            failures=$((failures + 1))
        fi
    done
}

# Copy $1 into $2 under its own name plus its lower- and upper-case spellings.
# Every name is written even when it duplicates the source, so the overlay
# mirrors the case-insensitive layout CL.EXE expects.
copy_variants() {
    local src=$1 dest_dir=$2
    local base lower upper
    base=$(basename "$src")
    lower=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')
    upper=$(printf '%s' "$base" | tr '[:lower:]' '[:upper:]')
    copy_as "$src" "$dest_dir" "$base" "$lower" "$upper"
}

# Copy all include files, skipping subdirs, which are handled below.
echo "Copying INCLUDE files..."
for f in "$MSVC_ROOT/INCLUDE/"*; do
    [ -d "$f" ] && continue
    copy_variants "$f" "$DEST/include"
done

# Handle subdirectories (GL/, SYS/, OBJMODEL/)
for dir in "$MSVC_ROOT/INCLUDE/GL" "$MSVC_ROOT/INCLUDE/SYS" "$MSVC_ROOT/INCLUDE/OBJMODEL"; do
    if [ -d "$dir" ]; then
        base=$(basename "$dir")
        lower=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')
        mkdir -p "$DEST/include/$base" "$DEST/include/$lower"
        for f in "$dir/"*; do
            [ -d "$f" ] && continue
            copy_variants "$f" "$DEST/include/$base"
            copy_variants "$f" "$DEST/include/$lower"
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

for truncated in $(printf '%s\n' "${!STL_MAP[@]}" | sort); do
    full="${STL_MAP[$truncated]}"
    if [ -f "$DEST/include/$truncated" ]; then
        full_upper=$(printf '%s' "$full" | tr '[:lower:]' '[:upper:]')
        copy_as "$DEST/include/$truncated" "$DEST/include" "$full" "$full_upper"
        echo "  $truncated -> $full"
    fi
done

echo "Copying LIB files..."
for f in "$MSVC_ROOT/LIB/"*; do
    [ -d "$f" ] && continue
    copy_variants "$f" "$DEST/lib"
done

echo "Copying BIN files..."
for f in "$MSVC_ROOT/BIN/"*; do
    [ -d "$f" ] && continue
    copy_variants "$f" "$DEST/bin"
done

if [ "$failures" -gt 0 ]; then
    echo "ERROR: $failures file(s) could not be copied; the overlay at $DEST is incomplete" >&2
    exit 1
fi

echo "Done. MSVC6 overlay created at $DEST"
printf '  Include: %s\n' 'C:\msvc6\include'
printf '  Lib:     %s\n' 'C:\msvc6\lib'
printf '  Bin:     %s\n' 'C:\msvc6\bin'
