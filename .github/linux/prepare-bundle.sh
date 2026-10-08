#!/usr/bin/env bash
# Stages what the Linux packages carry besides the app where
# tauri.linux-cli.conf.json expects it: the roer command, its config and the
# skills. The .deb and .rpm install them in /usr/lib/Roer/roer and link roer
# as /usr/bin/roer (src-tauri/linux/post-install.sh), so installing the
# package is the whole install; the AppImage carries the same files and the
# app puts them on PATH itself (src-tauri/src/cli_link.rs). tmux is the
# packages' dependency, not bundled. Run from the repository root before
# `tauri build`.
set -euo pipefail
stage=src-tauri/linux-cli
cargo build --release --locked --manifest-path cli/Cargo.toml
rm -rf "$stage"
mkdir -p "$stage"
install -m 755 cli/target/release/roer "$stage/roer"
install -m 644 scripts/roer-tmux.conf "$stage/roer-tmux.conf"
cp -R .claude/skills "$stage/skills"

# tauri.linux-cli.conf.json names each file it bundles, so a skill, or a file
# of one, added without a line there would be left out of the packages
# unnoticed.
(cd "$stage" && find skills -type f) | while read -r file; do
    grep -qF "\"linux-cli/$file\"" src-tauri/tauri.linux-cli.conf.json || {
        echo "$file is not in src-tauri/tauri.linux-cli.conf.json" >&2
        exit 1
    }
done

# A release build has no checkout to fall back on, so this proves it finds
# the config beside itself, as it will once installed.
"$stage/roer" help > /dev/null
ls -lR "$stage"
