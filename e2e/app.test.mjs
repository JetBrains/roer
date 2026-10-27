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

test("opens on the session list, with nothing running, and says what a project is", async () => {
  await app.waitForText("Nothing running in this Workspace's projects yet.", ".sessions-view");
  await app.waitForText("No project yet: add the folder you work in", ".sessions-view");
  await app.tab("Terminal");
  await app.waitForText("Start with the folder you work in");
});

test("New session starts the default agent in a terminal", async () => {
  // With no project New session asks for a folder, in the system's own
  // picker, which a test cannot drive; the empty stage starts in home too.
  await app.click("start in your home folder");
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
  // Typed into the pane by roer, the way the Changes tab sends prompts.
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

test("Workspace lists both, and picking the other one brings it back", async () => {
  await app.tab("Workspace");
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
  await app.untilPane("roer to know the agent", hidden.pane, (row) => Boolean(row?.agent));
  await app.untilPane("roer to hear the agent ask", hidden.pane, (row) => row?.state === "waiting");
  await app.until("a dot on the Workspace tab", () =>
    app.driver.executeScript("return !!document.querySelector('.tab-dot.waiting')"),
  );
  await app.tab("Workspace");
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

/** A conversation as Claude Code 2.x writes it: the queued prompt and its
 * attachments first, pushing the first prompt well into the file, and the
 * title Claude gave it last. */
function conversation(cwd, { prompt, reply = "Done.", title, entrypoint = "cli", cwdInHead = true }) {
  const filler = "x".repeat(5000);
  const where = (event) => (cwdInHead ? { ...event, cwd } : event);
  return [
    { type: "queue-operation", operation: "enqueue", content: prompt },
    ...Array.from({ length: 4 }, () => where({ type: "attachment", attachment: { content: filler } })),
    ...(cwdInHead ? [] : Array.from({ length: 16 }, () => ({ type: "attachment", attachment: { content: filler } }))),
    { type: "user", cwd, entrypoint, gitBranch: "main", message: { role: "user", content: prompt } },
    { type: "assistant", cwd, message: { role: "assistant", content: [{ type: "text", text: reply }] } },
    ...(title ? [{ type: "ai-title", aiTitle: title }] : []),
  ];
}

test("past conversations are all listed by name, and found by what was said", async () => {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // A minute apart, the first the oldest, so which ten come first never
  // rests on a tie: 36 down to 27, the SDK run, newest, left out. All today
  // by the local calendar, even in a run just after midnight, when the
  // older ones would otherwise be put under Yesterday.
  const latest = Math.max(Date.now(), new Date().setHours(0, 41, 0, 0));
  const at = (n) => new Date(latest - (40 - n) * 60_000);
  for (let n = 1; n <= 34; n += 1) {
    app.transcript(app.project, id(n), conversation(app.project, { prompt: `Task number ${n}`, title: `Seeded conversation ${n}` }), at(n));
  }
  app.transcript(app.project, id(35), conversation(app.project, {
    prompt: "Look at the importer",
    reply: "The quokka migration drops every second row.",
    title: "Importer drops rows",
  }), at(35));
  // In a folder under the project, with its cwd only near the end.
  const sub = join(app.project, "packages", "api");
  app.transcript(sub, id(36), conversation(sub, { prompt: "Tidy the API package", title: "API package tidy-up", cwdInHead: false }), at(36));
  // A pipeline's run through the Agent SDK, which nobody comes back to.
  app.transcript(app.project, id(37), conversation(app.project, { prompt: "Summarize", title: "Automated run", entrypoint: "sdk-cli" }), at(37));

  await app.tab("Workspace");
  await app.click("Refresh");
  await app.waitForText("Seeded conversation 34", ".conversations");
  const count = () => app.driver.executeScript("return document.querySelector('.conversations-count')?.textContent");
  await app.until("all 36 counted", async () => (await count()) === "36");
  const listed = await app.text(".conversations");
  assert.doesNotMatch(listed, /00000000-0000-4000/, "named, not by id");
  assert.doesNotMatch(listed, /Automated run/);

  await app.click("Show 26 more");
  await app.waitForText("API package tidy-up", ".conversations");
  await app.waitForText("Importer drops rows", ".conversations");

  const filter = await app.find("input", "Filter conversations");
  await filter.sendKeys("quokka");
  await app.until("only the conversation that said it", async () => (await count()) === "1 of 36");
  await app.waitForText("The quokka migration drops every second row.", ".conversations");
  assert.match(await app.text(".conversations"), /Importer drops rows/);

  // Read before resuming: the panel shows what was said, and starts nothing.
  const panes = app.sessions().length;
  await app.click("Preview Importer drops rows");
  await app.waitForText("Look at the importer", ".conversation-preview");
  await app.waitForText("The quokka migration drops every second row.", ".conversation-preview");
  assert.equal(app.sessions().length, panes, "a preview starts no claude");
  await app.click("Close the preview");
  assert.equal(app.sessions().length, panes, "nor did closing it");

  // The search popup finds it by what was said, too.
  await app.click("Search sessions and files");
  await (await app.find("input.popup-input", "Search")).sendKeys("quokka");
  await app.waitForText("Importer drops rows", ".popup");
  await app.waitForText("quokka migration", ".popup");
  await (await app.find("input.popup-input", "Search")).sendKeys(Key.ESCAPE);
});
