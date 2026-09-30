#!/usr/bin/env bash
# Runs the Linux e2e tests in a container, from any machine with Docker: how
# to see them on a Mac, where there is no WebDriver for the app's webview.
#
# The checkout is copied in rather than mounted, so the host's node_modules
# (built for the host) never meet the container's; the builds are cached in
# volumes between runs. Artifacts of the run land in e2e/artifacts.
#
# usage: e2e/docker.sh [--record]
#   --record  also leaves e2e/artifacts/e2e-linux.mp4, the run in slow motion
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
record=()
if [ "${1:-}" = --record ]; then
    record=(-e ROER_E2E_RECORD=/roer/e2e/artifacts/e2e-linux.mp4 -e ROER_E2E_PAUSE=800)
fi
docker build -q -t roer-e2e -f "$repo/e2e/Dockerfile" "$repo/e2e" >/dev/null

rm -rf "$repo/e2e/artifacts"
cd "$repo"
# What git would commit, edits included, and nothing it ignores: a tracked
# file deleted but not yet committed is left out, as tar would fail on it.
# Without COPYFILE_DISABLE, macOS's tar adds a ._ file beside each one.
export COPYFILE_DISABLE=1
git ls-files -z --cached --others --exclude-standard | grep -z -v '^e2e/artifacts/' |
    while IFS= read -r -d '' f; do if [ -e "$f" ]; then printf '%s\0' "$f"; fi; done |
    tar --null -T - -cf - |
    docker run --rm -i ${record[@]+"${record[@]}"} -e HOST_ID="$(id -u):$(id -g)" \
        -v roer-e2e-src-tauri-target:/roer/src-tauri/target \
        -v roer-e2e-cli-target:/roer/cli/target \
        -v roer-e2e-node-modules:/roer/node_modules \
        -v roer-e2e-e2e-modules:/roer/e2e/node_modules \
        -v roer-e2e-cargo-registry:/opt/cargo/registry \
        -v "$repo/e2e/artifacts:/artifacts" \
        roer-e2e bash -c '
            set -euo pipefail
            tar -xf - -C /roer
            npm ci --no-audit --no-fund
            npx tauri build --debug --no-bundle
            cargo build --manifest-path cli/Cargo.toml
            cd e2e && npm ci --no-audit --no-fund
            status=0
            dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" npm test || status=$?
            cp -r artifacts/. /artifacts/ 2>/dev/null || true
            # Owned by the host user, not root: on a Linux host the next run
            # must be able to delete them.
            chown -R "$HOST_ID" /artifacts 2>/dev/null || true
            exit $status
        '
