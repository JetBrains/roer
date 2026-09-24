#!/usr/bin/env bash
# Downloads psmux, roer's session engine on Windows, into $1 and checks it.
#
# Pinned by version and checksum in this one place, which CI, Nightly bundles
# and the release all read: psmux ships inside roer's Windows CLI, so the
# version tested is the version released, and moving it is a reviewed change.
set -euo pipefail
PSMUX_VERSION=3.3.8
PSMUX_SHA256=1ad127ba937194a890b933a73d9b023e297bd73dc742abd841bf159984c2effe

dest=${1:?usage: fetch-psmux.sh <directory>}
zip="psmux-v${PSMUX_VERSION}-windows-x64.zip"
mkdir -p "$dest"
curl -fsSL --retry 3 -o "$dest/$zip" \
    "https://github.com/psmux/psmux/releases/download/v${PSMUX_VERSION}/${zip}"
echo "${PSMUX_SHA256}  $dest/$zip" | sha256sum -c -
unzip -q -o "$dest/$zip" psmux.exe LICENSE -d "$dest"
rm "$dest/$zip"
"$dest/psmux.exe" -V
