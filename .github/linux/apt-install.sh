#!/usr/bin/env bash
# Installs the given Ubuntu packages, moving off a mirror that crawls.
#
# The runners fetch from their own Azure mirror first, listed ahead of
# Ubuntu's archive in apt-mirrors.txt, and it usually serves these in well
# under a minute. Now and then it sends at tens of kB/s instead, and apt only
# moves down that list on errors, never because a mirror is slow. So the first
# try gets ninety seconds there; if it runs out, the Azure mirror is dropped
# from the list and the rest go to Ubuntu's archive, three minutes each. apt
# keeps what it had fetched, so a retry carries on rather than starting over.
set -euo pipefail
MIRRORS=/etc/apt/apt-mirrors.txt
sudo apt-get update
for seconds in 90 180 180; do
  if sudo timeout "$seconds" apt-get install -y "$@"; then
    exit 0
  fi
  echo "::warning::apt-get install failed or ran out of its ${seconds}s"
  if [ -f "$MIRRORS" ] && grep -q 'azure\.archive\.ubuntu\.com' "$MIRRORS"; then
    sudo sed -i '/azure\.archive\.ubuntu\.com/d' "$MIRRORS"
    echo "Fetching from the next mirror instead:"
    cat "$MIRRORS"
    sudo apt-get update
  fi
done
exit 1
