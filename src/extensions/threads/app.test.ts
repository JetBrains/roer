import { fileRead, gitRoot, gitSnapshot, resolveDir } from "roer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { allThreads, startThread } from "../../lib/threads";
import { Registry } from "../registry";
import threads from "./app";

vi.mock("roer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("roer")>()),
  fileRead: vi.fn(),
  gitRoot: vi.fn(),
  gitSnapshot: vi.fn(),
  resolveDir: vi.fn(),
}));

const tool = (name: string) => {
  const registry = new Registry();
  registry.load("threads", threads, { bundled: true });
  return registry.tool("threads", name)!;
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(resolveDir).mockResolvedValue("/repo/src");
  vi.mocked(gitRoot).mockResolvedValue("/repo");
  vi.mocked(gitSnapshot).mockResolvedValue("c".repeat(40));
  vi.mocked(fileRead).mockResolvedValue({ text: "a\nb\nc\n", lines: 3, truncated: false, binary: false, bytes: 6 });
});

describe("the threads tools", () => {
  it("answers in a thread by its id, and pins one with no session to whoever answers", async () => {
    const thread = startThread({ root: "/repo", anchors: [{ kind: "part", id: "x" }], text: "Hm?" });
    expect(await tool("answer").run({ thread: thread.id, text: "Because.", author: "Claude" }, { pane: "%7" })).toContain(
      "Added your answer",
    );
    expect(allThreads()[0]).toMatchObject({ replies: [{ author: "Claude", text: "Because." }], session: { pane: "%7" } });
    await expect(tool("answer").run({ thread: "nope", text: "x" }, {})).rejects.toThrow('No thread "nope"');
  });

  it("answers with a view drawn in the thread, and refuses one that is not A2UI messages", async () => {
    const thread = startThread({ root: "/repo", anchors: [{ kind: "part", id: "x" }], text: "Show me?" });
    const ui = [{ version: "v1.0", createSurface: { surfaceId: "hi", components: [{ id: "root", component: "Text", text: "Hi" }] } }];
    expect(await tool("answer").run({ thread: thread.id, text: "Here.", ui }, {})).toContain("with its view");
    expect(allThreads()[0].replies).toEqual([{ author: "Agent", text: "Here.", ui }]);
    await expect(tool("answer").run({ thread: thread.id, text: "x", ui: [{ html: "<b>" }] }, {})).rejects.toThrow("A2UI v1.0");
    await expect(
      tool("answer").run({ thread: thread.id, text: "x", ui: [{ version: "v1.0", deleteSurface: { surfaceId: "hi" } }] }, {}),
    ).rejects.toThrow("createSurface");
    expect(allThreads()[0].replies).toHaveLength(1);
  });

  it("lets an agent start a thread on a range of a file's lines, with its own session", async () => {
    expect(await tool("comment").run({ path: "./a.ts", line: 2, end: 3, text: "These?", author: "Claude" }, { pane: "%4" })).toContain(
      "a.ts:2-3",
    );
    expect(allThreads()[0]).toMatchObject({
      root: "/repo",
      anchors: [{ kind: "line", path: "a.ts", line: 2, end: 3, code: "b\nc", blob: "c".repeat(40) }],
      author: "Claude",
      session: { pane: "%4", cwd: "/repo/src" },
    });
    await expect(tool("comment").run({ path: "a.ts", line: 9, text: "x" }, {})).rejects.toThrow("has 3 lines");
  });

  it("lets an agent start a thread on parts of a view it drew", async () => {
    await tool("comment").run({ surface: "arch", parts: ["api", "db"], text: "Look at these" }, { pane: "%4" });
    expect(allThreads()[0]).toMatchObject({
      view: "ui:arch",
      anchors: [
        { kind: "part", id: "api" },
        { kind: "part", id: "db" },
      ],
    });
  });
});
