#!/usr/bin/env bash
# Downloads psmux, roer's session engine on Windows, into $1 and checks it.
#
# Pinned by version and checksum in this one place, which CI, Nightly bundles
# and the release all read: psmux ships inside roer's Windows CLI, so the
# version tested is the version released, and moving it is a reviewed change.
set -euo pipefail
PSMUX_VERSION=3.4.0
PSMUX_SHA256=a66b6be7c13c6fa0dc3660a267b9e34eaa91a4eb7f07fbd55a0468018bd0f721

dest=${1:?usage: fetch-psmux.sh <directory>}
zip="psmux-v${PSMUX_VERSION}-windows-x64.zip"
mkdir -p "$dest"
curl -fsSL --retry 3 -o "$dest/$zip" \
    "https://github.com/psmux/psmux/releases/download/v${PSMUX_VERSION}/${zip}"
echo "${PSMUX_SHA256}  $dest/$zip" | sha256sum -c -
unzip -q -o "$dest/$zip" psmux.exe LICENSE -d "$dest"
rm "$dest/$zip"
"$dest/psmux.exe" -V
