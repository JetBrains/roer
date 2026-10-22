#!/usr/bin/env bash
# Installs the given Ubuntu packages, giving up on a mirror that crawls.
#
# The runners' package mirror usually serves these in well under a minute, but
# now and then one sends at tens of kB/s and a plain install sits there for
# twenty minutes. Each try here gets three minutes and fresh connections, and
# apt keeps what it had fetched, so a retry carries on rather than starting
# over. Three slow tries fail the step, which is quicker to re-run than to wait.
set -euo pipefail
sudo apt-get update
for try in 1 2 3; do
  if sudo timeout 180 apt-get install -y "$@"; then
    exit 0
  fi
  echo "::warning::apt-get install try $try of 3 failed or ran out of time"
done
exit 1
