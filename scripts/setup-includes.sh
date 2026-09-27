#!/bin/bash
# Setup case-insensitive MSVC6 include/lib overlay for Wine on Linux.
# Linux filesystems are case-sensitive, but MSVC headers use mixed-case #includes.
# This script creates a mirror with both upper and lowercase copies.
set -euo pipefail
shopt -s nullglob

usage() {
    cat <<'EOF'
Usage: setup-includes.sh [--dest DIR] [--help]

Mirrors VC/VC98 into a Wine prefix directory, writing every file under its own
name and its lowercase name, because MSVC headers use mixed-case #include lines
that do not resolve on a case-sensitive filesystem.

  --dest DIR   target directory (default: $WINEPREFIX/drive_c/msvc6, else
               $HOME/.wine/drive_c/msvc6)
  -h, --help   print this help and exit

Exits 0 on success, 1 when the MSVC 6.0 tree is missing, 2 on a bad argument or
when neither WINEPREFIX nor HOME is set.
EOF
}

DEST=""

while [ $# -gt 0 ]; do
    case "$1" in
    -h | --help)
        usage
        exit 0
        ;;
    --dest)
        if [ $# -lt 2 ]; then
            echo "setup-includes.sh: --dest needs a directory" >&2
            usage >&2
            exit 2
        fi
        DEST="$2"
        shift 2
        ;;
    --dest=*)
        DEST="${1#--dest=}"
        shift
        ;;
    *)
        echo "setup-includes.sh: unknown argument '$1'" >&2
        usage >&2
        exit 2
        ;;
    esac
done

if [ -z "$DEST" ]; then
    WINE_PREFIX="${WINEPREFIX:-${HOME:-}}"
    if [ -z "$WINE_PREFIX" ]; then
        echo "ERROR: HOME is unset, so the Wine prefix cannot be located; pass --dest DIR or set WINEPREFIX" >&2
        exit 2
    fi
    DEST="$WINE_PREFIX/drive_c/msvc6"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MSVC_ROOT="$PROJECT_ROOT/VC/VC98"

if [ ! -d "$MSVC_ROOT" ]; then
    echo "ERROR: MSVC6 directory not found at $MSVC_ROOT" >&2
    exit 1
fi

for required in INCLUDE LIB BIN; do
    if [ ! -d "$MSVC_ROOT/$required" ]; then
        echo "ERROR: $MSVC_ROOT/$required is missing; the overlay would be incomplete" >&2
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
    # Read the source from the MSVC tree, not from $DEST: the overlay is this
    # script's own output, so aliasing from it would make a rerun regenerate
    # headers from a previous run's leftovers, which no removal from the
    # source tree can ever reclaim.
    if [ -f "$MSVC_ROOT/INCLUDE/$truncated" ]; then
        full_upper=$(printf '%s' "$full" | tr '[:lower:]' '[:upper:]')
        copy_as "$MSVC_ROOT/INCLUDE/$truncated" "$DEST/include" "$full" "$full_upper"
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
