#!/usr/bin/env bash
# Stages roer's Windows CLI where tauri.windows-cli.conf.json expects it, so
# an installer built with that config ships roer.exe and psmux.exe beside the
# app. Run from the repository root before `tauri build`.
set -euo pipefail
# The page roer mcp serves to apps that draw MCP Apps, built into roer (cli/build.rs); without it, fail here.
npm run build:mcp-app
export ROER_REQUIRE_MCP_APP=1
cargo build --release --locked --manifest-path cli/Cargo.toml
psmux="${RUNNER_TEMP:-$(mktemp -d)}/psmux"
bash .github/windows/fetch-psmux.sh "$psmux"
rm -rf src-tauri/windows-cli
bash .github/windows/stage-cli.sh cli/target/release/roer.exe "$psmux" src-tauri/windows-cli
ls -l src-tauri/windows-cli
