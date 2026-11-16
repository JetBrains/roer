import { beforeEach, describe, expect, it, vi } from "vitest";

import { GONE_FOR, sweepThreads, type Probe } from "./threadSweep";
import { allThreads, forYou, startThread } from "./threads";

beforeEach(() => localStorage.clear());

const DAY = 24 * 60 * 60 * 1000;

/** A disk where only `roots` are repositories, each with the branches (local or a remote's) that have a.ts. */
const disk = (roots: Record<string, string[]>): Probe => ({
  root: vi.fn(async (dir: string) => (dir in roots ? dir : null)),
  onBranch: vi.fn(async (dir: string, branch: string) => (roots[dir] ?? []).includes(branch)),
});

const onFile = (root: string, branch?: string) =>
  startThread({
    root,
    author: "claude",
    anchors: [{ kind: "line", path: "a.ts", line: 1, code: "x", ...(branch ? { branch } : {}) }],
    text: "Look",
  });

describe("sweepThreads", () => {
  it("marks a thread whose worktree is gone, takes it off Needs you, and deletes it once gone long enough", async () => {
    const kept = onFile("/repo");
    const gone = onFile("/worktrees/done");
    const probe = disk({ "/repo": ["main"] });

    expect(await sweepThreads(1000, probe)).toBe(0);
    const marked = allThreads().find((one) => one.id === gone.id)!;
    expect(marked.goneSince).toBe(1000);
    expect(forYou(marked)).toBe(false);
    expect(allThreads().find((one) => one.id === kept.id)!.goneSince).toBeUndefined();

    // Still within the wait: kept, and still marked from the first time.
    expect(await sweepThreads(1000 + 6 * DAY, probe)).toBe(0);
    expect(allThreads().find((one) => one.id === gone.id)!.goneSince).toBe(1000);

    expect(await sweepThreads(1000 + GONE_FOR, probe)).toBe(1);
    expect(allThreads().map((one) => one.id)).toEqual([kept.id]);
  });

  it("unmarks a thread whose worktree came back", async () => {
    const thread = onFile("/disk/repo");
    await sweepThreads(1000, disk({}));
    expect(allThreads()[0].goneSince).toBe(1000);
    await sweepThreads(2000, disk({ "/disk/repo": [] }));
    expect(allThreads()[0].goneSince).toBeUndefined();
    expect(forYou(allThreads()[0])).toBe(true);
    expect(allThreads()[0].id).toBe(thread.id);
  });

  it("marks a thread left on a branch that was deleted, not one on a branch still there, a remote's too", async () => {
    const deleted = onFile("/repo", "old-feature");
    const there = onFile("/repo", "main");
    const remote = onFile("/repo", "origin/review");
    await sweepThreads(1000, disk({ "/repo": ["main", "origin/review"] }));
    expect(allThreads().find((one) => one.id === deleted.id)!.goneSince).toBe(1000);
    expect(allThreads().find((one) => one.id === there.id)!.goneSince).toBeUndefined();
    expect(allThreads().find((one) => one.id === remote.id)!.goneSince).toBeUndefined();
  });

  it("keeps a thread left in a tab showing a thread as written, which has no branch", async () => {
    startThread({
      root: "/repo",
      anchors: [{ kind: "line", path: "a.ts", line: 1, code: "x", blob: "a".repeat(40) }],
      text: "On the old content",
    });
    const probe = disk({ "/repo": ["main"] });
    await sweepThreads(1000, probe);
    expect(allThreads()[0].goneSince).toBeUndefined();
    expect(probe.onBranch).not.toHaveBeenCalled();
  });

  it("leaves everything as it is when git cannot be asked, and writes nothing when nothing changed", async () => {
    onFile("/repo");
    const failing: Probe = { root: vi.fn().mockRejectedValue(new Error("no git")), onBranch: vi.fn() };
    await sweepThreads(1000, failing);
    expect(allThreads()[0].goneSince).toBeUndefined();

    const write = vi.spyOn(Storage.prototype, "setItem");
    await sweepThreads(2000, disk({ "/repo": [] }));
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
