#!/usr/bin/env bash
# Downloads tmux, roer's session engine, into $1 as one universal binary,
# with the licences of what is linked into it.
#
# Roer.app ships this tmux beside the roer command, as the Windows installer
# ships psmux, so installing the .dmg is the whole install: no Homebrew. These
# are tmux's own builds (github.com/tmux/tmux-builds), one per architecture,
# joined here with lipo. Their libraries are linked in statically, so they
# depend on nothing outside macOS itself; they need macOS 15, which is why
# Roer does too.
#
# Pinned by version and checksum in this one place, so the tmux released is
# the one reviewed, and moving it is a change of its own.
set -euo pipefail
TMUX_VERSION=3.7c
TMUX_ARM64_SHA256=0a763dd0380aa980d239509654da1bc7455843706a3c050f6709c8cd2e13d12d
TMUX_X86_64_SHA256=1c21f9ade964e4a539be05ffe3a4e95854ab76a0a9c4c05d0ffbe7fc6c4d783f
LICENSES_SHA256=094905d3ba42397c65fecd817dc29736dd14bd35e75600441403a365125f47d1
# The app's own floor, from tauri.conf.json: a tmux needing more would not
# start on a Mac the app runs on.
MIN_MACOS=15.0

dest=${1:?usage: fetch-tmux.sh <directory>}
mkdir -p "$dest"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() { # file sha256 -> unpacked into $work/<file without .tar.gz>
    local dir="$work/${1%.tar.gz}"
    curl -fsSL --retry 3 -o "$work/$1" \
        "https://github.com/tmux/tmux-builds/releases/download/v${TMUX_VERSION}/$1"
    echo "$2  $work/$1" | shasum -a 256 -c - >/dev/null
    mkdir -p "$dir"
    tar -xzf "$work/$1" -C "$dir"
}
fetch "tmux-${TMUX_VERSION}-macos-arm64.tar.gz" "$TMUX_ARM64_SHA256"
fetch "tmux-${TMUX_VERSION}-macos-x86_64.tar.gz" "$TMUX_X86_64_SHA256"
fetch LICENSES.tar.gz "$LICENSES_SHA256"

lipo -create -output "$dest/tmux" \
    "$work/tmux-${TMUX_VERSION}-macos-arm64/tmux" \
    "$work/tmux-${TMUX_VERSION}-macos-x86_64/tmux"
chmod 755 "$dest/tmux"
# The archive is shared with the Linux builds; musl is in those alone.
cp "$work/LICENSES/COPYING.tmux" "$dest/tmux-LICENSE.txt"
cp "$work/LICENSES/LICENSE.libevent" "$dest/libevent-LICENSE.txt"
cp "$work/LICENSES/LICENSE.utf8proc" "$dest/utf8proc-LICENSE.txt"
cp "$work/LICENSES/COPYING.ncurses" "$dest/ncurses-LICENSE.txt"

# What makes it installable on any Mac Roer supports: both slices, nothing
# linked from outside /usr/lib and /System, and no newer macOS required.
ARCHS="$(lipo -archs "$dest/tmux")"
[ "$ARCHS" = "x86_64 arm64" ] || [ "$ARCHS" = "arm64 x86_64" ] || {
    echo "tmux is not universal: $ARCHS" >&2
    exit 1
}
# otool prints a header per slice; the libraries are the indented lines.
if otool -L "$dest/tmux" | grep -E '^[[:space:]]' | grep -vE '^[[:space:]]+/(usr/lib|System)/'; then
    echo "tmux links a library macOS does not have" >&2
    exit 1
fi
for arch in arm64 x86_64; do
    minos=$(otool -arch "$arch" -l "$dest/tmux" | awk '/LC_BUILD_VERSION/ { found = 1 } found && $1 == "minos" { print $2; exit }')
    [ "$(printf '%s\n%s\n' "$minos" "$MIN_MACOS" | sort -V | tail -1)" = "$MIN_MACOS" ] || {
        echo "tmux ($arch) needs macOS $minos, more than Roer's $MIN_MACOS" >&2
        exit 1
    }
done
"$dest/tmux" -V
