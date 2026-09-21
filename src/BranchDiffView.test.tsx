import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BranchDiffView } from "./BranchDiffView";
import {
  gitBranchCommits,
  gitBranches,
  gitCommitDiff,
  gitCommitFiles,
  gitCurrentBranch,
  gitRoot,
  type Commit,
  type FileChange,
} from "./lib/git";
import { listSessions } from "./lib/pty";

vi.mock("./lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/git")>()),
  gitBranches: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitRoot: vi.fn(),
  gitBranchCommits: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitCommitDiff: vi.fn(),
}));

vi.mock("./lib/pty", () => ({ listSessions: vi.fn() }));

function file(path: string, extra: Partial<FileChange> = {}): FileChange {
  return {
    path,
    staged: ".",
    unstaged: "M",
    added: 1,
    deleted: 1,
    binary: false,
    counted: true,
    ...extra,
  };
}

function commit(subject: string, extra: Partial<Commit> = {}): Commit {
  return {
    hash: `hash-${subject}`,
    short: subject.slice(0, 7),
    author: "Roer Test",
    date: 1_700_000_000,
    subject,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
  vi.mocked(gitRoot).mockReset().mockResolvedValue("/work/roer");
  vi.mocked(gitBranches).mockReset().mockResolvedValue(["main", "feature"]);
  vi.mocked(gitCurrentBranch).mockReset().mockResolvedValue("feature");
  vi.mocked(gitBranchCommits).mockReset().mockResolvedValue([]);
  vi.mocked(gitCommitFiles).mockReset().mockResolvedValue([]);
  vi.mocked(gitCommitDiff).mockReset().mockResolvedValue("");
});

function view(cwd = "/work/roer") {
  return render(<BranchDiffView cwd={cwd} active />);
}

describe("BranchDiffView", () => {
  it("defaults the branch picker to the session's own branch and the base to main", async () => {
    view();

    await waitFor(() => expect(gitBranchCommits).toHaveBeenCalledWith("/work/roer", "feature", "main"));
  });

  it("shows the first commit of the range and steps through them with Next", async () => {
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("first change"), commit("second change")]);
    vi.mocked(gitCommitFiles).mockImplementation(async (_root, hash) =>
      hash === "hash-first change" ? [file("a.txt")] : [file("b.txt")],
    );

    view();

    expect(await screen.findByText(/first change/)).toBeInTheDocument();
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("commit 1 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(await screen.findByText(/second change/)).toBeInTheDocument();
    expect(await screen.findByText("b.txt")).toBeInTheDocument();
    expect(screen.getByText("commit 2 of 2")).toBeInTheDocument();
  });

  it("steps through commits with Cmd+Right and Cmd+Left", async () => {
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("first change"), commit("second change")]);
    vi.mocked(gitCommitFiles).mockImplementation(async (_root, hash) =>
      hash === "hash-first change" ? [file("a.txt")] : [file("b.txt")],
    );

    view();

    expect(await screen.findByText("a.txt")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    expect(await screen.findByText("b.txt")).toBeInTheDocument();
    expect(screen.getByText("commit 2 of 2")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft", metaKey: true });
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("commit 1 of 2")).toBeInTheDocument();
  });

  it("does not step through commits when the view is not the active tab", async () => {
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("first change"), commit("second change")]);
    vi.mocked(gitCommitFiles).mockImplementation(async (_root, hash) =>
      hash === "hash-first change" ? [file("a.txt")] : [file("b.txt")],
    );

    const { rerender } = render(<BranchDiffView cwd="/work/roer" active />);
    expect(await screen.findByText("a.txt")).toBeInTheDocument();

    rerender(<BranchDiffView cwd="/work/roer" active={false} />);

    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    expect(screen.queryByText("commit 2 of 2")).not.toBeInTheDocument();
  });

  it("says plainly when the branch has nothing over its base", async () => {
    vi.mocked(gitBranchCommits).mockResolvedValue([]);

    view();

    expect(
      await screen.findByText(/feature has no commits main does not already have/),
    ).toBeInTheDocument();
  });

  it("diffs the selected commit against its own parent, not the base branch", async () => {
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("only change")]);
    vi.mocked(gitCommitFiles).mockResolvedValue([file("a.txt")]);
    vi.mocked(gitCommitDiff).mockResolvedValue("@@ -1,1 +1,1 @@ h\n-old\n+new\n");

    view();

    await screen.findByText("a.txt");
    await waitFor(() =>
      expect(gitCommitDiff).toHaveBeenCalledWith("/work/roer", "hash-only change", "a.txt"),
    );
  });
});
