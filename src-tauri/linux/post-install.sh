#!/bin/sh
# Puts the roer command the package ships on PATH as /usr/bin/roer. It lives
# in /usr/lib/Roer/cli beside its config and skills (see
# tauri.linux-cli.conf.json), and finds them through the link. A
# /usr/bin/roer that is not a link is someone's own install and is left
# alone. Shared by the .deb and the .rpm.
set -e
cli=/usr/lib/Roer/cli/roer
link=/usr/bin/roer
if [ -L "$link" ] || [ ! -e "$link" ]; then
    ln -sfn "$cli" "$link"
fi
