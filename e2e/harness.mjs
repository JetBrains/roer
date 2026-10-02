// Starts the real Roer app under WebDriver, with everything it touches kept
// in a directory of its own: a home, a `$ROER_HOME`, a tmux (psmux) socket, a
// git project, and a fake `claude` first on PATH (fake-agent/agent.mjs).
//
// WebDriver for a Tauri app is `tauri-driver`, which fronts the platform's
// own driver: WebKitWebDriver on Linux, msedgedriver on Windows. There is
// none for WKWebView, which is why this runs on Linux and Windows only.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, Capabilities, Key, until } from "selenium-webdriver";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const windows = process.platform === "win32";
const exe = windows ? ".exe" : "";

/** The app and the CLI as `npx tauri build --debug --no-bundle` and
 * `cargo build --manifest-path cli/Cargo.toml` leave them. */
export const APP = process.env.ROER_E2E_APP || join(repo, "src-tauri/target/debug", `roer-app${exe}`);
export const ROER = process.env.ROER_E2E_ROER || join(repo, "cli/target/debug", `roer${exe}`);
/** Windows only: `cargo build --manifest-path e2e/fake-agent/Cargo.toml`. */
const CLAUDE_EXE = join(here, "fake-agent/target/debug/claude.exe");
/** Screenshots, the page source and the app's log from a failed run. */
export const ARTIFACTS = join(here, "artifacts");

const PORT = 4444;
/** `ROER_E2E_RECORD`: a file to record the screen into, with ffmpeg. */
const RECORD = process.env.ROER_E2E_RECORD;
/** `ROER_E2E_PAUSE`: milliseconds to hold after each step, so a recording
 * can be followed. */
const PAUSE = Number(process.env.ROER_E2E_PAUSE) || 0;

export { By, Key, until };

/** Runs a program and fails with what it said if it fails. */
export function must(program, args, options = {}) {
  const out = spawnSync(program, args, { encoding: "utf8", ...options });
  if (out.error) throw out.error;
  if (out.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} exited ${out.status}: ${out.stderr || out.stdout}`);
  }
  return out.stdout;
}

/** The fake agent, as `claude` on PATH: a shell script on Linux, and on
 * Windows fake-agent's claude.exe (see its main.rs for why an .exe), which
 * finds agent.mjs and node through `env`. The script has the paths written
 * into it instead, since a pane's shell need not have everything the app was
 * started with. */
function fakeClaude(bin, env) {
  mkdirSync(bin, { recursive: true });
  const agent = join(here, "fake-agent/agent.mjs");
  const node = process.execPath;
  if (windows) {
    if (!existsSync(CLAUDE_EXE)) throw new Error(`no fake claude.exe at ${CLAUDE_EXE}: build it first (see e2e/README.md)`);
    copyFileSync(CLAUDE_EXE, join(bin, "claude.exe"));
    Object.assign(env, { ROER_E2E_AGENT: agent, ROER_E2E_NODE: node });
    return join(bin, "claude.exe");
  } else {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    const sets = Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`).join("\n");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\n${sets}\nexec ${q(node)} ${q(agent)} "$@"\n`, { mode: 0o755 });
  }
}

/** A repository with one commit and, on top of it, one edited file and one
 * new one, for the Changes view to show. */
function project(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => must("git", args, { cwd: dir });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "user.email", "e2e@example.invalid");
  git("config", "user.name", "Roer E2E");
  writeFileSync(join(dir, "README.md"), "# E2E project\n\nFirst line.\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Start");
  writeFileSync(join(dir, "README.md"), "# E2E project\n\nFirst line.\nAn e2e change.\n");
  writeFileSync(join(dir, "notes.txt"), "not committed yet\n");
}

export class Roer {
  /** Everything the run makes, under one temporary directory. */
  constructor() {
    for (const [what, path] of [["app", APP], ["roer", ROER]]) {
      if (!existsSync(path)) throw new Error(`no ${what} at ${path}: build it first (see e2e/README.md)`);
    }
    // Resolved: on Windows the temp folder can come as an 8.3 short name
    // (RUNNER~1), where panes report the long one.
    this.root = realpathSync.native(mkdtempSync(join(tmpdir(), "roer-e2e-")));
    this.home = join(this.root, "home");
    this.roerHome = join(this.home, ".roer");
    this.project = join(this.root, "e2e-project");
    this.socket = `roer-e2e-${process.pid}`;
    // Claude Code's own directory: roer counts it as installed only with one.
    mkdirSync(join(this.home, ".claude"), { recursive: true });
    project(this.project);

    const own = {
      ROER_SOCKET: this.socket,
      ROER_HOME: this.roerHome,
      ROER_E2E_ROER: ROER,
    };
    // On Windows a pane's PATH is the registry's, not the app's: psmux builds
    // each pane's environment afresh. So there the fake goes into a folder CI
    // has put on the user PATH, as an installer would.
    const bin = process.env.ROER_E2E_BIN || join(this.root, "bin");
    // Removed again in stop(): on Windows it sits in a folder on the user's
    // PATH, where it would stand in for the real claude from then on.
    this.fake = fakeClaude(bin, own);
    this.env = {
      ...process.env,
      ...own,
      [windows ? "USERPROFILE" : "HOME"]: this.home,
      // The fake first, then the CLI, so a pane's `roer` is the one built.
      PATH: [bin, dirname(ROER), process.env.PATH].join(delimiter),
      ROER_BIN: ROER,
      // The running app picks every handoff up; a second one must not start.
      ROER_APP: join(this.root, "no-such-app"),
    };
    // A terminal the app was started from, or a CI step's, is no session.
    delete this.env.TMUX;
    delete this.env.TMUX_PANE;
    if (!windows) this.env.SHELL = "/bin/bash";
  }

  /** `roer`, as a terminal in the project runs it. */
  roer(args, input) {
    return must(ROER, args, { cwd: this.project, env: this.env, input });
  }

  /** Waits for `roer list` to satisfy `check`, and says what it showed if
   * it never does. */
  async untilSessions(what, check, timeout) {
    let rows = [];
    try {
      return await this.until(what, () => check((rows = this.sessions())), timeout);
    } catch (e) {
      e.message += `\n--- roer list ---\n${JSON.stringify(rows, null, 1)}`;
      throw e;
    }
  }

  /** Waits for `roer list --json`'s row for `pane` to satisfy `check`, and
   * says what it and the pane's screen showed if it never does. */
  async untilPane(what, pane, check, timeout) {
    let row = null;
    try {
      return await this.until(
        what,
        () => check((row = this.roer(["list", "--json"]).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((r) => r.pane === pane) ?? null)),
        timeout,
      );
    } catch (e) {
      const engine = windows ? join(dirname(ROER), "psmux.exe") : "tmux";
      const screen = spawnSync(engine, ["-L", this.socket, "capture-pane", "-p", "-t", pane], { env: this.env, encoding: "utf8" });
      e.message += `\n--- roer list --json, ${pane} ---\n${JSON.stringify(row, null, 1)}`;
      e.message += `\n--- its screen ---\n${screen.stdout}${screen.stderr}`;
      throw e;
    }
  }

  /** `roer list`, a row per pane, by column. */
  sessions() {
    const columns = ["id", "session", "pane", "attached", "cwd", "command", "agent", "title"];
    return this.roer(["list"])
      .split("\n")
      .filter(Boolean)
      .map((row) => Object.fromEntries(row.split("\t").map((value, i) => [columns[i], value])));
  }

  async start() {
    this.record();
    const args = [];
    if (windows) {
      // It must be WebView2's own version: CI fetches that one, and the
      // runner image's (in EDGEWEBDRIVER) follows Edge instead.
      const native = process.env.ROER_E2E_EDGEDRIVER || join(process.env.EDGEWEBDRIVER ?? "", "msedgedriver.exe");
      // Through a wrapper that has it log verbosely into the artifacts:
      // tauri-driver passes it nothing but a port, and a refused session
      // says little more than that it was refused.
      mkdirSync(ARTIFACTS, { recursive: true });
      const wrapper = join(this.root, "msedgedriver-verbose.cmd");
      const log = join(ARTIFACTS, "msedgedriver.log");
      writeFileSync(wrapper, `@echo off\r\n"${native}" --verbose "--log-path=${log}" %*\r\n`);
      args.push("--native-driver", wrapper);
    }
    const tauriDriver = process.env.ROER_E2E_TAURI_DRIVER || "tauri-driver";
    this.driverProcess = spawn(tauriDriver, args, { env: this.env, stdio: ["ignore", "inherit", "inherit"] });
    this.driverProcess.on("error", (e) => console.error(`could not start ${tauriDriver}: ${e.message}`));

    const capabilities = new Capabilities();
    capabilities.set("tauri:options", { application: APP });
    capabilities.setBrowserName("wry");
    // tauri-driver takes a moment to listen: only that is worth retrying. A
    // session the driver refused is an answer, and asking again relaunches
    // the app for another minute's wait.
    for (let attempt = 0; ; attempt++) {
      try {
        this.driver = await new Builder()
          .withCapabilities(capabilities)
          .usingServer(`http://127.0.0.1:${PORT}/`)
          .build();
        break;
      } catch (e) {
        const refused = e.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(e.message));
        if (!refused || attempt >= 40) throw e;
        await sleep(500);
      }
    }
    await this.driver.wait(until.elementLocated(By.css(".app-frame")), 30_000, "the app never drew its frame");
    // Room for the stage beside the Generative UI panel, whatever the default.
    await this.driver.manage().window().setRect({ width: 1280, height: 800 });
  }

  async stop() {
    await sleep(PAUSE * 3);
    try {
      await this.driver?.quit();
    } catch {
      /* The app may be gone already. */
    }
    this.driverProcess?.kill();
    await this.stopRecording();
    // The sessions' server, which outlives the app on purpose.
    const engine = windows ? join(dirname(ROER), "psmux.exe") : "tmux";
    spawnSync(engine, ["-L", this.socket, "kill-server"], { env: this.env });
    // What the run leaves behind: the fake, wherever it went, and the
    // directory everything else is in. Best effort: a process still holding
    // a file on Windows only means it stays in the temp folder.
    for (const path of [this.fake, this.root]) {
      try {
        if (path) rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        console.error(`could not remove ${path}: ${e.message}`);
      }
    }
  }

  /** Records the whole screen, the app's launch included: gdigrab is the
   * Windows desktop, x11grab the display xvfb-run gives Linux. */
  record() {
    if (!RECORD) return;
    mkdirSync(dirname(RECORD), { recursive: true });
    const input = windows
      ? ["-f", "gdigrab", "-framerate", "15", "-i", "desktop"]
      : ["-f", "x11grab", "-framerate", "15", "-i", process.env.DISPLAY];
    // Even dimensions, which yuv420p (what every player takes) needs; and
    // fragmented, so a run killed mid-way (a hang, a cancel) still plays.
    const output = [
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof", RECORD,
    ];
    this.recorder = spawn("ffmpeg", ["-y", "-loglevel", "error", ...input, ...output], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    this.recorder.on("error", (e) => console.error(`could not record the screen: ${e.message}`));
  }

  /** `q` is ffmpeg's own quit, which finishes the file; a kill leaves it
   * unplayable. */
  async stopRecording() {
    const recorder = this.recorder;
    if (!recorder || recorder.exitCode !== null) return;
    const exited = new Promise((done) => recorder.once("exit", done));
    recorder.stdin.end("q");
    await Promise.race([exited, sleep(15_000)]);
    recorder.kill();
  }

  /** Puts the step on screen for a recording to show, outside <body> so no
   * test finds its text there. */
  async caption(text) {
    if (!RECORD) return;
    await this.driver.executeScript(
      `let el = document.getElementById("roer-e2e-caption");
       if (!el) {
         el = document.createElement("div");
         el.id = "roer-e2e-caption";
         el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
           "padding:6px 12px;font:600 13px system-ui,sans-serif;color:#fff;background:rgba(20,20,20,.8)";
         document.documentElement.appendChild(el);
       }
       el.textContent = arguments[0];`,
      text,
    );
    await sleep(PAUSE);
  }

  // --- Finding things on screen ---------------------------------------------

  /** Waits for `check` to return something truthy, and returns it. */
  async until(what, check, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        const value = await check();
        if (value) return value;
        last = undefined;
      } catch (e) {
        last = e;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
      }
      await sleep(250);
    }
  }

  /** The visible text of the page, or of what `css` finds. */
  async text(css = "body") {
    // innerText, as drawn; WebKitWebDriver's getText leaves some of it out.
    return this.driver.executeScript(
      "return Array.from(document.querySelectorAll(arguments[0]), (el) => el.innerText).join('\\n')",
      css,
    );
  }

  async waitForText(needle, css = "body", timeout) {
    return this.until(`"${needle}" in ${css}`, async () => (await this.text(css)).includes(needle), timeout);
  }

  /** What the stage's terminal shows: xterm draws its rows as DOM. */
  async terminal() {
    return this.driver.executeScript(
      "return Array.from(document.querySelectorAll('.xterm-rows > div')).map(r => r.textContent).join('\\n')",
    );
  }

  async waitForTerminal(needle, timeout = 30_000) {
    let seen = "";
    try {
      return await this.until(
        `"${needle}" in the terminal`,
        // Also across rows, for a line longer than the terminal is wide.
        async () => (seen = await this.terminal()).includes(needle) || seen.replaceAll("\n", "").includes(needle),
        timeout,
      );
    } catch (e) {
      e.message += `\n--- terminal ---\n${seen}`;
      throw e;
    }
  }

  /** What the session's own shell makes of `claude`, typed into it through
   * roer: for a failure message, when the fake agent did not start. */
  async whyNoAgent() {
    const pane = this.sessions()[0]?.pane;
    if (!pane) return "\n(no session to ask)";
    const ask = windows
      ? "'PATH=' + $env:PATH; Get-Command claude -All | Format-List CommandType,Source,Definition | Out-String -Width 400"
      : "echo PATH=$PATH; type -a claude";
    this.roer(["send", "--pane", pane], ask);
    await sleep(4000);
    return `\n--- the pane, asked about claude ---\n${await this.terminal()}`;
  }

  /** Types into the stage's terminal, as a person at the keyboard would. */
  async type(text) {
    const input = await this.driver.findElement(By.css(".xterm-helper-textarea"));
    await input.sendKeys(text);
    await sleep(PAUSE);
  }

  /** The first element `css` finds that is drawn and whose accessible name
   * or text is `name`, or starts with it followed by more (a hotkey hint, a
   * badge). Looked up in the page, since getText misses text in WebKit. */
  async find(css, name) {
    return this.until(`${css} "${name}"`, () =>
      this.driver.executeScript(
        `const [css, name] = arguments;
         return Array.from(document.querySelectorAll(css)).find((el) => {
           if (!el.getClientRects().length) return false;
           const label = (el.getAttribute("aria-label") || el.innerText).trim();
           return label === name || label.startsWith(name + " ") || label.startsWith(name + "\\n");
         }) ?? null;`,
        css,
        name,
      ),
    );
  }

  async button(name) {
    return this.find("button", name);
  }

  /** Holds for `ROER_E2E_PAUSE`, after a step the harness did not take. */
  async pause() {
    await sleep(PAUSE);
  }

  async click(name) {
    await (await this.button(name)).click();
    await sleep(PAUSE);
  }

  async tab(name) {
    await this.click(name);
    await this.until(`the ${name} tab`, async () => {
      const tab = await this.button(name);
      return (await tab.getAttribute("aria-selected")) === "true";
    });
  }

  /** Keeps what there is to see of a failed test, for CI to upload. */
  async keep(name) {
    mkdirSync(ARTIFACTS, { recursive: true });
    const base = join(ARTIFACTS, name.replace(/[^\w-]+/g, "-"));
    try {
      writeFileSync(`${base}.png`, await this.driver.takeScreenshot(), "base64");
      writeFileSync(`${base}.html`, await this.driver.getPageSource());
    } catch (e) {
      console.error(`could not keep the screen: ${e.message}`);
    }
    const logs = join(this.roerHome, "logs");
    if (existsSync(logs)) {
      for (const file of readdirSync(logs)) copyFileSync(join(logs, file), join(ARTIFACTS, file));
    }
  }
}

export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
