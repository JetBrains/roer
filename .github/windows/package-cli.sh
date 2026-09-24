#!/usr/bin/env bash
# roer's Windows CLI as a zip, for anyone not using the installer, which
# ships the same files itself. See stage-cli.sh for what is in it and why.
#
# usage: package-cli.sh <roer.exe> <directory with psmux.exe and LICENSE> <out.zip>
set -euo pipefail
roer=${1:?roer.exe} psmux=${2:?psmux directory} out=${3:?output zip}
# Absolute before anything changes directory: 7z runs inside the stage.
mkdir -p "$(dirname "$out")"
out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"

stage=$(mktemp -d)
bash "$(dirname "$0")/stage-cli.sh" "$roer" "$psmux" "$stage"
rm -f "$out"
(cd "$stage" && 7z a -tzip -bso0 -bsp0 "$(cygpath -w "$out")" roer.exe psmux.exe psmux-LICENSE.txt roer-tmux.conf)
7z l "$out" | tail -8
rm -rf "$stage"
