import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { allThreads, askPrompt, forYou, markSeen, pickSession, placeByCode, placeOf, placeThrough, replyPrompt, replyToThread, startThread, useFileThreads } from "./threads";

beforeEach(() => localStorage.clear());

const onLine = () =>
  startThread({ root: "/repo", anchors: [{ kind: "line", path: "src/a.ts", line: 3, code: "const x = 1;" }], text: "Why one?" });

describe("threads", () => {
  it("asks about a file's line with its code, and names the tool and the thread to answer with", () => {
    const thread = onLine();
    const prompt = askPrompt(thread);
    expect(prompt).toContain("`src/a.ts` line 3");
    expect(prompt).toContain("const x = 1;");
    expect(prompt).toContain("Why one?");
    expect(prompt).toContain(`threads__answer tool, thread "${thread.id}"`);
    expect(prompt).toContain("find the spot by the quoted code");
  });

  it("asks about several parts of a view together, by their labels and ids", () => {
    const thread = startThread({
      root: "/repo",
      view: "ui:arch",
      viewTitle: "Architecture",
      anchors: [
        { kind: "part", id: "api", label: "API" },
        { kind: "part", id: "db", label: "Database" },
      ],
      text: "How do these talk?",
    });
    const prompt = askPrompt(thread);
    expect(prompt).toContain('These, together in my Roer view "Architecture" (`ui:arch`)');
    expect(prompt).toContain('- "API" (`api`)');
    expect(prompt).toContain('- "Database" (`db`)');
    expect(prompt).not.toContain("quoted code");
  });

  it("tells a session new to a thread the whole of it", () => {
    const thread = onLine();
    replyToThread(thread.id, "Claude", "It is one.", false);
    const whole = replyPrompt({ ...allThreads()[0], replies: [...allThreads()[0].replies, { author: "You", text: "Why?" }] }, "Why?", true);
    expect(whole).toContain("I wrote: Why one?");
    expect(whole).toContain("Claude wrote: It is one.");
    expect(replyPrompt(thread, "Why?")).not.toContain("Why one?");
  });

  it("keeps whether an answer is still due", () => {
    const thread = onLine();
    replyToThread(thread.id, "You", "More?", true);
    expect(allThreads()[0].awaiting).toBe(true);
    replyToThread(thread.id, "Claude", "Yes.", false);
    expect(allThreads()[0]).toMatchObject({ awaiting: false, state: "open" });
    expect(replyToThread("nope", "Claude", "x", false)).toBe(false);
  });

  it("hands a new thread to a session in its repository first, then the stage's", () => {
    const live = (pane: string, cwd: string) => ({ pane, id: `id${pane}`, agent: "claude", cwd });
    const sessions = [live("%1", "/other"), live("%2", "/repo/sub")];
    expect(pickSession("/repo", { pane: "%1", root: "/other" }, sessions)).toMatchObject({ pane: "%2" });
    expect(pickSession("/repo", { pane: "%2", root: "/repo" }, sessions)).toMatchObject({ pane: "%2" });
    expect(pickSession("/elsewhere", { pane: "%1", root: "/other" }, sessions)).toMatchObject({ pane: "%1" });
    expect(pickSession("/elsewhere", null, sessions)).toBeUndefined();
  });

  it("waits on the person once an agent speaks, until they have seen it or replied", () => {
    const mine = onLine();
    expect(forYou(allThreads()[0])).toBe(false);
    replyToThread(mine.id, "Claude", "Because.", false);
    expect(forYou(allThreads()[0])).toBe(true);
    markSeen(mine.id);
    expect(forYou(allThreads()[0])).toBe(false);
    replyToThread(mine.id, "Claude", "Also this.", false);
    expect(forYou(allThreads()[0])).toBe(true);
    replyToThread(mine.id, "You", "Thanks", true);
    expect(forYou(allThreads()[0])).toBe(false);
  });

  it("waits on the person with a thread an agent started, and says where it is", () => {
    const theirs = startThread({ root: "/repo", anchors: [{ kind: "line", path: "src/a.ts", line: 3, end: 5, code: "" }], text: "Hm?", author: "Claude" });
    expect(forYou(theirs)).toBe(true);
    expect(placeOf(theirs)).toBe("a.ts:3–5");
  });
});


describe("a thread left in Changes", () => {
  it("asks a question as one: answered in the thread, with no file changed for it", () => {
    const thread = startThread({ ...onLine(), intent: "ask" });
    const prompt = askPrompt(thread);
    expect(prompt).toContain("This is a question");
    expect(prompt).toContain("Don't change any files for it");
    expect(prompt).not.toContain("Do what it asks");
  });

  it("names a removed line, and a commit's line as that commit left it", () => {
    const removed = startThread({ root: "/repo", anchors: [{ kind: "line", path: "a.ts", line: 4, code: "gone", side: "old" }], text: "Why?" });
    expect(askPrompt(removed)).toContain("`a.ts` removed line 4");
    const commit = { hash: "abc1234def", short: "abc1234", subject: "Add y" };
    const onCommit = startThread({ root: "/repo", anchors: [{ kind: "line", path: "a.ts", line: 9, code: "y", commit }], text: "Why?" });
    expect(askPrompt(onCommit)).toContain('`a.ts` line 9 as commit abc1234 ("Add y") left it');
  });

  it("starts with the person's decision under an agent's comment, which is theirs and seen", () => {
    const thread = startThread({ ...onLine(), author: "Codex", replies: [{ author: "You", text: "Keep it." }] });
    expect(thread.replies).toEqual([{ author: "You", text: "Keep it." }]);
    expect(forYou(thread)).toBe(false);
    replyToThread(thread.id, "Claude", "Kept.", false);
    expect(forYou(allThreads().find((one) => one.id === thread.id)!)).toBe(true);
  });

  it("keeps a removed line's thread, and a commit's, out of the file's own tab", () => {
    onLine();
    startThread({ root: "/repo", anchors: [{ kind: "line", path: "src/a.ts", line: 3, code: "x", side: "old" }], text: "Removed." });
    startThread({
      root: "/repo",
      anchors: [{ kind: "line", path: "src/a.ts", line: 3, code: "x", commit: { hash: "h", short: "h", subject: "s" } }],
      text: "On a commit.",
    });
    const { result } = renderHook(() => useFileThreads("/repo", "src/a.ts", undefined));
    expect(result.current.map((t) => t.text)).toEqual(["Why one?"]);
  });
});

describe("placing a thread", () => {
  it("moves lines no hunk touched by what was added and removed above them", () => {
    expect(placeThrough("@@ -0,0 +1,2 @@\n+a\n+b\n", 5, 6)).toEqual({ line: 7, end: 8, outdated: false });
    expect(placeThrough("@@ -2 +1,0 @@\n-x\n", 5, 5)).toEqual({ line: 4, end: 4, outdated: false });
    expect(placeThrough("@@ -9 +9 @@\n-x\n+y\n", 5, 6)).toEqual({ line: 5, end: 6, outdated: false });
  });

  it("is outdated when a hunk changed its lines, or put lines between them", () => {
    expect(placeThrough("@@ -5 +5 @@\n-x\n+y\n", 4, 6).outdated).toBe(true);
    expect(placeThrough("@@ -4,0 +5 @@\n+between\n", 4, 6).outdated).toBe(true);
    // Added right after its last line, or right before its first: still its lines.
    expect(placeThrough("@@ -6,0 +7 @@\n+after\n", 4, 6).outdated).toBe(false);
    expect(placeThrough("@@ -3,0 +4 @@\n+before\n", 4, 6)).toEqual({ line: 5, end: 7, outdated: false });
  });

  it("finds lines by their words, nearest first, when there is nothing to diff", () => {
    const lines = ["a", "x", "y", "b", "x", "y"];
    expect(placeByCode("x\ny", lines, 5, 6)).toEqual({ line: 5, end: 6, outdated: false });
    expect(placeByCode("x\ny", lines, 3, 4)).toEqual({ line: 2, end: 3, outdated: false });
    expect(placeByCode("gone", lines, 3, 3)).toEqual({ line: 3, end: 3, outdated: true });
  });
});
