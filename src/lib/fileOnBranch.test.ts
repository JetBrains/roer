import { beforeEach, describe, expect, it, vi } from "vitest";

import { fileOnBranch } from "./fileOnBranch";
import { listWorktrees, type Worktree } from "./worktrees";

vi.mock("./worktrees", () => ({ listWorktrees: vi.fn() }));

const tree = (path: string, branch: string | null, over: Partial<Worktree> = {}): Worktree => ({
  path,
  branch,
  commit: "abc1234",
  main: false,
  base: null,
  locked: false,
  missing: false,
  ...over,
});

beforeEach(() => {
  vi.mocked(listWorktrees).mockResolvedValue([
    tree("/repo", "main", { main: true }),
    tree("/repo-wt/feature", "feature"),
    tree("/repo-wt/gone", "gone", { missing: true }),
  ]);
});

describe("fileOnBranch", () => {
  it("opens the worktree at root as it is without a branch", async () => {
    expect(await fileOnBranch("/repo-wt/feature", "a.ts", 3, undefined)).toEqual({
      kind: "file",
      root: "/repo-wt/feature",
      path: "a.ts",
      line: 3,
    });
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it("opens the worktree that has the branch checked out, from whichever checkout the view is in", async () => {
    expect(await fileOnBranch("/repo", "a.ts", undefined, "feature")).toEqual({
      kind: "file",
      root: "/repo-wt/feature",
      path: "a.ts",
    });
  });

  it("reads a branch no worktree has from git, in the main checkout", async () => {
    expect(await fileOnBranch("/repo-wt/feature", "a.ts", undefined, "other")).toEqual({
      kind: "file",
      root: "/repo",
      path: "a.ts",
      branch: "other",
    });
  });

  it("does not open a worktree whose folder is gone", async () => {
    expect(await fileOnBranch("/repo", "a.ts", undefined, "gone")).toMatchObject({ root: "/repo", branch: "gone" });
  });
});
