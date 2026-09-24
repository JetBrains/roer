#!/usr/bin/env bash
# Stages roer's Windows CLI and zips it: roer.exe, the psmux.exe it drives,
# psmux's licence, and roer-tmux.conf, all in one directory.
#
# They must stay together. roer looks for roer-tmux.conf beside itself, and
# runs the psmux beside itself before any on PATH: a psmux pane starts with
# the machine's PATH, so the one a user's shell found may not be reachable
# from inside a session.
#
# usage: package-cli.sh <roer.exe> <directory with psmux.exe and LICENSE> <out.zip>
set -euo pipefail
roer=${1:?roer.exe} psmux=${2:?psmux directory} out=${3:?output zip}
# Absolute before anything changes directory: 7z runs inside the stage.
mkdir -p "$(dirname "$out")"
out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"

stage=$(mktemp -d)
cp "$roer" "$stage/roer.exe"
cp "$psmux/psmux.exe" "$stage/psmux.exe"
cp "$psmux/LICENSE" "$stage/psmux-LICENSE.txt"
cp scripts/roer-tmux.conf "$stage/roer-tmux.conf"

# A release build has no checkout to fall back on, so this proves it finds
# the config beside itself, as it will once installed.
"$stage/roer.exe" help > /dev/null

rm -f "$out"
(cd "$stage" && 7z a -tzip -bso0 -bsp0 "$(cygpath -w "$out")" roer.exe psmux.exe psmux-LICENSE.txt roer-tmux.conf)
7z l "$out" | tail -8
rm -rf "$stage"
