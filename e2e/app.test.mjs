// The app as a person uses it, end to end: a real window, the real `roer`
// and tmux (psmux on Windows) behind it, and a fake `claude` in place of the
// agent, so nothing here needs an account or costs a request.
//
// One app for the whole file, since it is a single instance and slow to
// start: the tests run in order and each picks up where the last left off.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { Key, Roer } from "./harness.mjs";

const app = new Roer();

before(async () => {
  await app.start();
});

beforeEach(async (t) => {
  await app.caption(t.name);
});

afterEach(async (t) => {
  // node:test gives no pass/fail flag here yet, so every test keeps a screen;
  // only failures' are worth reading.
  await app.keep(t.name);
});

after(async () => {
  await app.stop();
});

test("the first launch asks about Claude Code, and Not now is remembered", async () => {
  // roer finds the fake as Claude Code.
  await app.waitForText("Not now");
  await app.click("Not now");
  await app.until("the setup dialog to close", async () => !(await app.text()).includes("Not now"));
  assert.ok(existsSync(join(app.roerHome, "claude-setup-asked")), "the answer is recorded");
});

test("opens on the session list, with nothing running", async () => {
  await app.waitForText("Nothing running in this Workspace's projects yet.", ".sessions-view");
  await app.tab("Terminal");
  await app.waitForText("Pick a session, or start a new one with");
});

test("New session starts the default agent in a terminal", async () => {
  await app.click("New session");
  try {
    await app.waitForTerminal("fake-claude ready");
  } catch (e) {
    e.message += await app.whyNoAgent();
    throw e;
  }
  // roer typed Claude Code's command line into the shell, flags and all.
  await app.waitForTerminal("args)");

  const rows = await app.untilSessions("roer list to show the session", (rows) =>
    rows.length === 1 && rows[0].attached === "attached" ? rows : null,
  );
  assert.equal(rows[0].cwd.replace(/\\/g, "/"), app.home.replace(/\\/g, "/"), "a new session starts at home");
});

test("what is typed in the terminal reaches the agent", async () => {
  await app.type(`hello from e2e${Key.ENTER}`);
  await app.waitForTerminal("echo: hello from e2e");
});

test("the agent's Generative UI shows in the panel, and a click goes back to it", async () => {
  await app.type(`/ui${Key.ENTER}`);
  await app.waitForTerminal("ui shown");
  // The panel opens itself for a live surface.
  await app.waitForText("E2E surface", ".generative-panel");
  await app.click("Press me");

  // Read back by the agent through `roer plugin-ui-actions`.
  await app.type(`/actions${Key.ENTER}`);
  await app.waitForTerminal('"pressed"');
  await app.click("Hide Generative UI panel");
});

test("roer app hands a terminal's session to the app", async () => {
  app.roer(["app"]);
  const pane = await app.untilSessions("the project's session in roer list", (rows) =>
    rows.find((row) => row.cwd?.replace(/\\/g, "/").endsWith("/e2e-project") && row.attached === "attached")?.pane,
  );
  // Typed into the pane by roer, the way the Pull Request tab sends prompts.
  app.roer(["send", "--pane", pane], "echo handed-over-ok");
  await app.waitForTerminal("handed-over-ok");

  // The session it replaced keeps running, with no client, once the app has
  // let go of it.
  await app.untilSessions("the replaced session to be detached", (rows) =>
    rows.find((row) => row.pane !== pane)?.attached === "detached",
  );
});

test("Changes shows the project's local edits", async () => {
  await app.tab("Changes");
  // Each file by hand: which one opens first differs between platforms.
  for (const [file, line] of [["README.md", "An e2e change."], ["notes.txt", "not committed yet"]]) {
    await (await app.find(".branch-diff button.file .name", file)).click();
    await app.pause();
    await app.waitForText(line, ".branch-diff");
  }
});

test("Sessions lists both, and picking the other one brings it back", async () => {
  await app.tab("Sessions");
  await app.waitForText("open here", ".sessions-view");
  await app.waitForText("detached", ".sessions-view");
  // Named by what the agent titled its terminal; the plain shell by nothing
  // it did not set, not the console's own title (the shell's path) on Windows.
  await app.waitForText("Fake task", ".sessions-view");
  assert.doesNotMatch(await app.text(".sessions-view"), /\.exe\b/i);

  const idle = await app.until("the detached session's row", () =>
    app.driver.executeScript(
      "return Array.from(document.querySelectorAll('.sessions-view button.row')).find((row) => row.innerText.includes('detached')) ?? null",
    ),
  );
  await idle.click();
  await app.pause();
  // The agent is still running in it, with what it printed earlier.
  await app.waitForTerminal("echo: hello from e2e");
  await app.untilSessions(
    "one of the two sessions attached",
    (rows) => rows.length === 2 && rows.filter((row) => row.attached === "attached").length === 1,
  );
});

test("an agent out of sight that stops to ask is shown as needing you", async () => {
  // The agent on the stage now goes out of sight behind a new session.
  const [hidden] = await app.untilSessions("one session attached", (rows) => {
    const held = rows.filter((row) => row.attached === "attached");
    return held.length === 1 ? held : null;
  });
  await app.click("New session");
  await app.waitForTerminal("fake-claude ready");
  await app.untilSessions("the agent to be detached", (rows) =>
    rows.find((row) => row.pane === hidden.pane)?.attached === "detached",
  );

  // Asking through `roer status`, as Claude Code's hooks do: the app sends a
  // system notification, which nothing here can see, and marks it waiting.
  app.roer(["send", "--pane", hidden.pane], "/work 1 Run the test suite");
  // Each step on its own, so a failure says which: roer knows the agent is
  // there, then hears it ask, then the app shows it.
  await app.untilPane("roer to know the agent", hidden.pane, (row) => row?.agent === "claude");
  await app.untilPane("roer to hear the agent ask", hidden.pane, (row) => row?.state === "waiting");
  await app.until("a dot on the Sessions tab", () =>
    app.driver.executeScript("return !!document.querySelector('.tab-dot.waiting')"),
  );
  await app.tab("Sessions");
  const asking = await app.until("the row that needs you", () =>
    app.driver.executeScript(
      "return Array.from(document.querySelectorAll('.sessions-view button.row')).find((row) => row.innerText.includes('needs you')) ?? null",
    ),
  );
  await asking.click();
  await app.waitForTerminal("Allow this command?");
  await app.type(`y${Key.ENTER}`);
  await app.waitForTerminal("128 passed");
  // Seen, so no longer waiting.
  await app.until("the dot to go", () =>
    app.driver.executeScript("return !document.querySelector('.tab-dot.waiting')"),
  );
});
