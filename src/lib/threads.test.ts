import { beforeEach, describe, expect, it } from "vitest";

import { allThreads, askPrompt, forYou, markSeen, pickSession, placeOf, replyPrompt, replyToThread, startThread } from "./threads";

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

