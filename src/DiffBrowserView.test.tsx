import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiffBrowserView } from "./DiffBrowserView";
import { parseDiff } from "./lib/diff";
import { type FilesChanged } from "./lib/files";
import {
  gitBranchCommits,
  gitBranches,
  gitChanges,
  gitCommitDiff,
  gitCommitFiles,
  gitCurrentBranch,
  gitDiff,
  gitRoot,
  type Changes,
  type Commit,
  type FileChange,
} from "./lib/git";
import { listSessions } from "./lib/pty";

vi.mock("./lib/git", async (importOriginal) => ({
  // The helpers are pure and worth exercising for real; only the calls that
  // reach the backend are stubbed.
  ...(await importOriginal<typeof import("./lib/git")>()),
  gitChanges: vi.fn(),
  gitDiff: vi.fn(),
  gitRoot: vi.fn(),
  gitBranches: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitBranchCommits: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitCommitDiff: vi.fn(),
}));

vi.mock("./lib/pty", () => ({ listSessions: vi.fn() }));

// Called through, not stubbed: the point is how often, not what it answers.
vi.mock("./lib/diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/diff")>();
  return { ...actual, parseDiff: vi.fn(actual.parseDiff) };
});

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

const changes: Changes = {
  root: "/work/roer",
  branch: "feature",
  commit: "ab3d7d1",
  files: [file("src/lib/git.ts"), file("src/lib/tree.ts"), file("README.md")],
};

/** Two hunks, so stepping within a file and across files both have a case. */
const twoHunks = [
  "@@ -1,2 +1,2 @@ first",
  "-one",
  "+ONE",
  "@@ -9,2 +9,2 @@ second",
  "-two",
  "+TWO",
  "",
].join("\n");

const oneHunk = "@@ -1,1 +1,1 @@ only\n-a\n+A\n";

/**
 * One keystroke, and a turn of the loop for the diff it asks for. Crossing
 * into a file needs its diff before the next key can know where its edges
 * are, which is why holding a key down is not the same as pressing it twice.
 */
async function press(key: string) {
  fireEvent.keyDown(screen.getByTestId("changes"), { key });
  await act(async () => {});
}

/** Which hunk the view says the keys are on, out of how many. */
const position = () => screen.getByText(/change \d+ of \d+/).textContent;

const selectedFile = () =>
  document.querySelector(".tree-row.selected .name")?.textContent ?? null;

beforeEach(() => {
  vi.mocked(gitChanges).mockReset().mockResolvedValue(changes);
  vi.mocked(gitDiff)
    .mockReset()
    .mockImplementation((_root, path) =>
      Promise.resolve(path === "README.md" ? oneHunk : twoHunks),
    );
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
  vi.mocked(gitRoot).mockReset().mockResolvedValue("/work/roer");
  // No branch ahead of its base, and the session sits on that same branch —
  // the local-changes slot is the only entry, exactly the shape a plain
  // "local changes" view used to have.
  vi.mocked(gitBranches).mockReset().mockResolvedValue(["feature"]);
  vi.mocked(gitCurrentBranch).mockReset().mockResolvedValue("feature");
  vi.mocked(gitBranchCommits).mockReset().mockResolvedValue([]);
  vi.mocked(gitCommitFiles).mockReset().mockResolvedValue([]);
  vi.mocked(gitCommitDiff).mockReset().mockResolvedValue("");
});

const view = () => render(<DiffBrowserView cwd="/work/roer/src" active />);

/** One batch from the worktree watch, as the backend reports it. */
const batch = (paths: string[], over: Partial<FilesChanged> = {}): FilesChanged => ({
  root: "/work/roer",
  paths,
  broad: false,
  ...over,
});

describe("DiffBrowserView — outside a repository", () => {
  it("says the folder is not a git repository instead of showing nothing", async () => {
    vi.mocked(gitRoot).mockResolvedValue(null);
    view();
    expect(await screen.findByText(/not a git repository/)).toBeInTheDocument();
  });
});

describe("DiffBrowserView — local changes (the merged tab's default view)", () => {
  it("groups the changed files into a folder tree", async () => {
    view();
    await waitFor(() =>
      expect(screen.getByText("src/lib")).toBeInTheDocument(),
    );
    // `src` holds nothing but `lib`, so the two rows are folded into one.
    const rows = [...document.querySelectorAll(".tree-row")].map(
      (row) => row.querySelector(".name")?.textContent,
    );
    expect(rows).toEqual(["src/lib", "git.ts", "tree.ts", "README.md"]);
  });

  it("shows the first change of the first file without being asked", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));
    expect(selectedFile()).toBe("git.ts");
    expect(screen.getByText("ONE")).toBeInTheDocument();
  });

  it("steps to the next change in the same file", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    await press("ArrowDown");

    expect(position()).toBe("change 2 of 2");
    expect(selectedFile()).toBe("git.ts");
  });

  it("does not reparse the diff to step within one file", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));
    const parses = vi.mocked(parseDiff).mock.calls.length;

    await press("ArrowDown");

    expect(position()).toBe("change 2 of 2");
    expect(vi.mocked(parseDiff).mock.calls.length).toBe(parses);
  });

  it("has nothing to show for a clean worktree", async () => {
    vi.mocked(gitChanges).mockResolvedValue({ ...changes, files: [] });

    view();

    await waitFor(() =>
      expect(screen.getByText(/No local changes/)).toBeInTheDocument(),
    );
    expect(gitDiff).not.toHaveBeenCalled();
  });

  it("reports a binary file instead of an empty diff", async () => {
    vi.mocked(gitChanges).mockResolvedValue({
      ...changes,
      files: [
        file("icon.png", { binary: true, added: 0, deleted: 0, counted: false }),
      ],
    });
    vi.mocked(gitDiff).mockResolvedValue(
      "Binary files a/icon.png and b/icon.png differ\n",
    );

    view();

    await waitFor(() =>
      expect(screen.getByText(/Binary file/)).toBeInTheDocument(),
    );
  });

  it("re-reads the diff of the file it is on when Refresh is clicked", async () => {
    view();
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(1));

    vi.mocked(gitDiff).mockResolvedValue("@@ -1,1 +1,1 @@ later\n-old\n+new\n");
    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => expect(screen.getByText("new")).toBeInTheDocument());
  });

  it("re-reads git when asked to refresh", async () => {
    view();
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(2));
  });

  it("reloads when the watch says this repository changed", async () => {
    const props = { cwd: "/work/roer/src", active: true };
    const { rerender } = render(<DiffBrowserView {...props} />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(1));

    rerender(<DiffBrowserView {...props} changed={batch(["src/lib/git.ts"])} />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(2));

    rerender(
      <DiffBrowserView {...props} changed={batch(["a.ts"], { root: "/work/elsewhere" })} />,
    );
    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(2);
  });

  it("queues one reload behind a slow one, not a reload per batch", async () => {
    const props = { cwd: "/work/roer/src", active: true };
    const { rerender } = render(<DiffBrowserView {...props} />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(1));

    let release: ((next: Changes) => void) | undefined;
    vi.mocked(gitChanges).mockImplementationOnce(
      () =>
        new Promise<Changes>((resolve) => {
          release = resolve;
        }),
    );

    rerender(<DiffBrowserView {...props} changed={batch(["src/one.ts"])} />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(2));

    rerender(<DiffBrowserView {...props} changed={batch(["src/two.ts"])} />);
    rerender(<DiffBrowserView {...props} changed={batch(["src/three.ts"])} />);
    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(2);

    await act(async () => {
      release?.(changes);
    });
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(3));

    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(3);
  });

  it("leaves a hidden view to reload on its way back to the front", async () => {
    const props = { cwd: "/work/roer/src" };
    const { rerender } = render(<DiffBrowserView {...props} active />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(1));

    const slept = batch(["src/x.ts"]);
    rerender(<DiffBrowserView {...props} active={false} />);
    rerender(<DiffBrowserView {...props} active={false} changed={slept} />);
    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(1);

    rerender(<DiffBrowserView {...props} active changed={slept} />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(2);
  });

  it("does not carry a queued reload across being hidden", async () => {
    const props = { cwd: "/work/roer/src" };
    const { rerender } = render(<DiffBrowserView {...props} active />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(1));

    let release: ((next: Changes) => void) | undefined;
    vi.mocked(gitChanges).mockImplementationOnce(
      () =>
        new Promise<Changes>((resolve) => {
          release = resolve;
        }),
    );
    rerender(<DiffBrowserView {...props} active changed={batch(["src/one.ts"])} />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(2));
    rerender(<DiffBrowserView {...props} active changed={batch(["src/two.ts"])} />);
    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(2);

    rerender(<DiffBrowserView {...props} active={false} />);
    await act(async () => {
      release?.(changes);
    });
    rerender(<DiffBrowserView {...props} active />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(3);
  });

  it("checks a change that landed while the opening load was out", async () => {
    let release: ((next: Changes) => void) | undefined;
    vi.mocked(gitChanges).mockImplementationOnce(
      () =>
        new Promise<Changes>((resolve) => {
          release = resolve;
        }),
    );

    const props = { cwd: "/work/roer/src", active: true };
    const { rerender } = render(<DiffBrowserView {...props} />);
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(1));

    rerender(<DiffBrowserView {...props} changed={batch(["src/lib/git.ts"])} />);
    await act(async () => {});
    expect(gitChanges).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.(changes);
    });
    await waitFor(() => expect(gitChanges).toHaveBeenCalledTimes(2));
  });
});

describe("DiffBrowserView — commits and the local-changes slot together", () => {
  it("defaults the branch picker to the session's own branch and the base to main", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);

    view();

    await waitFor(() =>
      expect(gitBranchCommits).toHaveBeenCalledWith("/work/roer", "feature", "main"),
    );
  });

  it("puts local changes before the branch's own commits, and selects it by default", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("first"), commit("second")]);
    vi.mocked(gitCommitFiles).mockResolvedValue([file("committed.txt")]);

    view();

    await waitFor(() => expect(screen.getByText("Local changes")).toBeInTheDocument());
    expect(screen.getByText("git.ts")).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(screen.getByText("commit 1 of 2")).toBeInTheDocument());
    await waitFor(() => expect(selectedFile()).toBe("committed.txt"));
    expect(gitCommitFiles).toHaveBeenCalledWith("/work/roer", "hash-first");
  });

  it("hides the local-changes slot entirely once the branch picker moves off the checked-out branch", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitBranchCommits).mockImplementation(async (_root, branch) =>
      branch === "feature" ? [commit("only")] : [commit("a"), commit("b")],
    );
    vi.mocked(gitCommitFiles).mockResolvedValue([file("committed.txt")]);

    view();

    // feature has one commit plus local changes: two slots, local selected.
    await waitFor(() => expect(screen.getByText("Local changes")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "main" } });

    // main is not checked out, so only its own two commits show — no
    // local-changes slot, and the default lands on the first of them.
    await waitFor(() => expect(screen.getByText("commit 1 of 2")).toBeInTheDocument());
    expect(screen.queryByText(/No local changes/)).not.toBeInTheDocument();
  });

  it("falls back to another branch as the base when the repository has no main", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["trunk", "feature"]);

    view();

    await waitFor(() =>
      expect(gitBranchCommits).toHaveBeenCalledWith("/work/roer", "feature", "trunk"),
    );
  });

  it("says plainly when the branch has nothing over its base and there is no local slot either", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitCurrentBranch).mockResolvedValue("main");

    view();

    fireEvent.change(await screen.findByLabelText("Branch"), {
      target: { value: "feature" },
    });

    expect(
      await screen.findByText(/feature has no commits main does not already have/),
    ).toBeInTheDocument();
  });

  it("diffs a selected commit against its own parent, not against the worktree", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("only change")]);
    vi.mocked(gitCommitFiles).mockResolvedValue([file("a.txt")]);
    vi.mocked(gitCommitDiff).mockResolvedValue("@@ -1,1 +1,1 @@ h\n-old\n+new\n");

    view();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("a.txt");
    await waitFor(() =>
      expect(gitCommitDiff).toHaveBeenCalledWith("/work/roer", "hash-only change", "a.txt"),
    );
  });

  it("steps across commits and local changes with Cmd+Left and Cmd+Right", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("only change")]);
    vi.mocked(gitCommitFiles).mockResolvedValue([file("a.txt")]);

    view();

    await waitFor(() => expect(screen.getByText("git.ts")).toBeInTheDocument());
    // Waits for the commit to be counted, not just the local-changes slot —
    // otherwise the key below can race a render that still thinks there is
    // nothing to step forward into.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled(),
    );

    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    expect(await screen.findByText("a.txt")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft", metaKey: true });
    expect(await screen.findByText("git.ts")).toBeInTheDocument();
  });
});
