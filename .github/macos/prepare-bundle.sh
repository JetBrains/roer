#!/usr/bin/env bash
# Stages what Roer.app carries besides itself where tauri.macos-cli.conf.json
# expects it: the roer command and the tmux it drives, both universal, the
# config, and the licences of what is linked into tmux. With them in the
# bundle, installing the .dmg is the whole install, and the app puts roer on
# PATH itself (src-tauri/src/cli_link.rs). Run from the repository root before
# `tauri build`.
set -euo pipefail
export MACOSX_DEPLOYMENT_TARGET=15.0
stage=src-tauri/macos-cli
rm -rf "$stage"
mkdir -p "$stage"

# One universal binary, like the app: both slices built on this arm64 runner
# and joined with lipo.
for target in aarch64-apple-darwin x86_64-apple-darwin; do
    cargo build --release --locked --manifest-path cli/Cargo.toml --target "$target"
done
lipo -create -output "$stage/roer" \
    cli/target/aarch64-apple-darwin/release/roer \
    cli/target/x86_64-apple-darwin/release/roer
chmod 755 "$stage/roer"

bash .github/macos/fetch-tmux.sh "$stage"
cp scripts/roer-tmux.conf "$stage/roer-tmux.conf"

# Ad hoc, as tauri.conf.json signs the app: the linker signs only arm64
# slices, and a bundle holding code with no signature at all cannot be sealed.
# The CodeSign service re-signs both with the Developer ID.
codesign --force --sign - --options runtime "$stage/roer" "$stage/tmux"

# Laid out as the bundle will be, roer has to find both without any help: a
# release build has no checkout to fall back on, and nothing on PATH is
# asked when tmux sits beside it.
layout=$(mktemp -d)/Roer.app/Contents
mkdir -p "$layout/MacOS" "$layout/Resources"
cp "$stage/roer" "$stage/tmux" "$layout/MacOS/"
cp "$stage/roer-tmux.conf" "$layout/Resources/"
"$layout/MacOS/roer" help > /dev/null
ROER_SOCKET="prepare-$$" ROER_HOME="$(dirname "$layout")/home" PATH=/usr/bin:/bin "$layout/MacOS/roer" list
rm -rf "$(dirname "$(dirname "$layout")")"
ls -l "$stage"
