# End-to-end tests

The Roer app driven as a person uses it: a real window, the real `roer` and
tmux (psmux on Windows) behind it, over WebDriver. `app.test.mjs` has the
scenarios; `harness.mjs` starts the app with everything it touches under one
temporary directory (a home, `$ROER_HOME`, a tmux socket, a git project).

No agent is ever called. `fake-agent/agent.mjs` goes first on `PATH` as
`claude` (on Windows through `fake-agent`'s tiny `claude.exe`, since psmux's
panes call `claude.exe` by name), so Roer finds Claude Code, the New session button starts it, and roer
types its full command line into the session as usual. The fake echoes what it
is typed, and on `/ui` and `/actions` shows a surface in the Generative UI panel
and reads the clicks back, through `roer plugin-ui` like a real agent.

WebDriver for a Tauri app is [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/),
which fronts WebKitWebDriver on Linux and msedgedriver on Windows. macOS has no
WebDriver for WKWebView, so these run on Linux and Windows only. CI runs them in
the `E2E` jobs.

## Running them

On a Mac, or anywhere with Docker, `e2e/docker.sh` runs the Linux suite in a
container. A failed run leaves a screenshot, the page source and the app's log
per test in `e2e/artifacts`.

On Linux or Windows directly:

```sh
cargo install tauri-driver --locked
npx tauri build --debug --no-bundle          # the app, src-tauri/target/debug/roer-app
cargo build --manifest-path cli/Cargo.toml   # roer, cli/target/debug/roer
cd e2e && npm ci && npm test                 # on Linux under a display: xvfb-run -a npm test
```

Linux needs `webkit2gtk-driver` and `tmux`. Windows needs `psmux.exe` beside
`roer.exe` (`.github/windows/fetch-psmux.sh cli/target/debug`), the fake
`claude.exe` (`cargo build --manifest-path e2e/fake-agent/Cargo.toml`), and an
`msedgedriver.exe` of the installed WebView2's exact version, found through
`ROER_E2E_EDGEDRIVER` or the `EDGEWEBDRIVER` directory GitHub's runners set.
A pane there takes its PATH from the registry, not from the app, so
`ROER_E2E_BIN` must name a folder on the user PATH for the fake to go in.
CI runs Windows on `windows-2022`: on the 2025 image msedgedriver never gets
a DevTools port from WebView2 (actions/runner-images#14738).
`ROER_E2E_APP`, `ROER_E2E_ROER` and `ROER_E2E_TAURI_DRIVER` point at builds
elsewhere.

`ROER_E2E_RECORD=<file>.mp4` records the screen with ffmpeg while the tests
run, captioned with each test's name, and `ROER_E2E_PAUSE=<ms>` holds after each
step so the recording can be followed. CI does both and uploads the video with
the rest of the artifacts; `e2e/docker.sh --record` does it locally.

Quit any other Roer first: the app is a single instance, and a second launch
only focuses the first.
