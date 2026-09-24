#!/usr/bin/env bash
# Puts roer's Windows CLI in one directory: roer.exe, the psmux.exe it
# drives, psmux's licence, and roer-tmux.conf. The CLI zip is this directory
# zipped; the installer ships it as `roer\` beside the app.
#
# They must stay together. roer looks for roer-tmux.conf beside itself, and
# runs the psmux beside itself before any on PATH: a psmux pane starts with
# the machine's PATH, so the one a user's shell found may not be reachable
# from inside a session.
#
# usage: stage-cli.sh <roer.exe> <directory with psmux.exe and LICENSE> <destination>
set -euo pipefail
roer=${1:?roer.exe} psmux=${2:?psmux directory} dest=${3:?destination}

mkdir -p "$dest"
cp "$roer" "$dest/roer.exe"
cp "$psmux/psmux.exe" "$dest/psmux.exe"
cp "$psmux/LICENSE" "$dest/psmux-LICENSE.txt"
cp scripts/roer-tmux.conf "$dest/roer-tmux.conf"

# A release build has no checkout to fall back on, so this proves it finds
# the config beside itself, as it will once installed.
"$dest/roer.exe" help > /dev/null
