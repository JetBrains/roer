#!/bin/sh
# Takes away the /usr/bin/roer that post-install.sh made, if it is still that
# link. Only when the package is removed: an upgrade runs this too, as
# "upgrade" (.deb) or 1 (.rpm), and the new package wants the link kept.
# Shared by the .deb and the .rpm.
set -e
case "$1" in
    remove | purge | 0) ;;
    *) exit 0 ;;
esac
if [ "$(readlink /usr/bin/roer 2>/dev/null)" = /usr/lib/Roer/roer/roer ]; then
    rm -f /usr/bin/roer
fi
