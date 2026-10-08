#!/bin/sh
# Puts the roer command the package ships on PATH as /usr/bin/roer. It lives
# in /usr/lib/Roer/cli beside its config and skills (see
# tauri.linux-cli.conf.json), and finds them through the link. Shared by the
# .deb and the .rpm.
#
# Only a roer that is Roer's is replaced: a link whose target has
# roer-tmux.conf beside it, as every Roer install has, or a link to nothing.
# Anything else at /usr/bin/roer, a file or a link, belongs to another tool
# and is left alone.
set -e
cli=/usr/lib/Roer/cli/roer
link=/usr/bin/roer
if [ -L "$link" ] && [ ! -e "$link" ]; then
    ln -sfn "$cli" "$link"
elif [ ! -e "$link" ]; then
    ln -s "$cli" "$link"
elif [ -L "$link" ] && [ -f "$(dirname "$(readlink -f "$link")")/roer-tmux.conf" ]; then
    ln -sfn "$cli" "$link"
elif [ "$(readlink -f "$link")" != "$cli" ]; then
    echo "Roer: $link is another program's and was left alone; Roer's roer is $cli" >&2
fi
