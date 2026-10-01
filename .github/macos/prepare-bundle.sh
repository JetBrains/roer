#!/usr/bin/env bash
# Stages what Roer.app carries besides itself where tauri.macos-cli.conf.json
# expects it: the roer command and the tmux it drives, both universal, the
# config, the skills, and the licences of what is linked into tmux. With them in the
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
cp -R .claude/skills "$stage/skills"

# tauri.macos-cli.conf.json names each file it bundles, so a skill, or a file
# of one, added without a line there would be left out of the app unnoticed.
(cd "$stage" && find skills -type f) | while read -r file; do
    grep -qF "\"Resources/$file\"" src-tauri/tauri.macos-cli.conf.json || {
        echo "$file is not in src-tauri/tauri.macos-cli.conf.json" >&2
        exit 1
    }
done

# Ad hoc, as tauri.conf.json signs the app: the linker signs only arm64
# slices, and a bundle holding code with no signature at all cannot be sealed.
# Developer ID signing, done outside this repository, re-signs both.
codesign --force --sign - --options runtime "$stage/roer" "$stage/tmux"

# Laid out as the bundle will be, roer has to find both without any help: a
# release build has no checkout to fall back on, and nothing on PATH is
# asked when tmux sits beside it.
layout=$(mktemp -d)/Roer.app/Contents
mkdir -p "$layout/MacOS" "$layout/Resources"
cp "$stage/roer" "$stage/tmux" "$layout/MacOS/"
cp -R "$stage/roer-tmux.conf" "$stage/skills" "$layout/Resources/"
"$layout/MacOS/roer" help > /dev/null
# The skills the app links for Claude Code are found in Resources too.
mkdir -p "$(dirname "$layout")/claude"
CLAUDE_CONFIG_DIR="$(dirname "$layout")/claude" ROER_HOME="$(dirname "$layout")/home" \
    "$layout/MacOS/roer" skills install
ROER_SOCKET="prepare-$$" ROER_HOME="$(dirname "$layout")/home" PATH=/usr/bin:/bin "$layout/MacOS/roer" list
rm -rf "$(dirname "$(dirname "$layout")")"
ls -l "$stage"
