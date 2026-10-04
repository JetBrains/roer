import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiffBrowserView } from "./DiffBrowserView";
import type { LocalComment } from "./local";
import { parseDiff } from "../../lib/diff";
import { type FilesChanged } from "../../lib/files";
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
} from "../../lib/git";
import { listSessions } from "../../lib/pty";

vi.mock("../../lib/git", async (importOriginal) => ({
  // The helpers are pure and worth exercising for real; only the calls that
  // reach the backend are stubbed.
  ...(await importOriginal<typeof import("../../lib/git")>()),
  gitChanges: vi.fn(),
  gitDiff: vi.fn(),
  gitRoot: vi.fn(),
  gitBranches: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitBranchCommits: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitCommitDiff: vi.fn(),
}));

vi.mock("../../lib/pty", () => ({ listSessions: vi.fn() }));

// Called through, not stubbed: the point is how often, not what it answers.
vi.mock("../../lib/diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/diff")>();
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
    body: "",
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

  it("shows a commit's whole message, and cuts a long body until it is asked for", async () => {
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitCurrentBranch).mockResolvedValue("main");
    const body = ["Why.", "Two.", "Three.", "Four.", "Five.", "Six."].join("\n");
    vi.mocked(gitBranchCommits).mockResolvedValue([
      commit("A subject an agent wrote that runs on well past what one line of the header could hold", { body }),
    ]);
    // Another branch than the one checked out: its commits alone, the first one on screen.
    render(<DiffBrowserView cwd="/work/roer/src" active branch="feature" />);
    expect(await screen.findByText(/runs on well past what one line/)).toBeInTheDocument();
    expect(screen.getByText(/Four\.…$/)).toBeInTheDocument();
    expect(screen.queryByText(/Six\./)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 6 lines" }));
    expect(screen.getByText(/Six\.$/)).toBeInTheDocument();
  });

  it("puts its controls in the bar it is handed, and none of its own", async () => {
    const bar = document.createElement("div");
    document.body.append(bar);
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("only change")]);
    const { container } = render(<DiffBrowserView cwd="/work/roer/src" active branch="feature" toolbar={bar} />);
    await waitFor(() => expect(bar.querySelector("select")).not.toBeNull());
    expect(container.querySelector(".branch-diff-pickers")).toBeNull();
    // The branch is the bar's to pick, so only the base is offered here.
    expect(bar.querySelectorAll("select")).toHaveLength(1);
    bar.remove();
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

describe("DiffBrowserView — comments", () => {
  /** The view with comments kept the way the tab keeps them, readable afterwards. */
  let kept: LocalComment[] = [];
  function Commented({ initial = [] }: { initial?: LocalComment[] }) {
    const [comments, setComments] = useState<LocalComment[]>(initial);
    kept = comments;
    return (
      <DiffBrowserView
        cwd="/work/roer/src"
        active
        comments={comments}
        onComments={(update) => setComments(update)}
        agent="Claude"
      />
    );
  }

  async function write(index: number, line: number, text: string) {
    fireEvent.click(screen.getAllByRole("button", { name: `Comment on line ${line}` })[index]);
    fireEvent.change(screen.getByRole("textbox", { name: `Comment on line ${line}` }), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument());
  }

  beforeEach(() => {
    kept = [];
    vi.mocked(gitBranches).mockResolvedValue(["main", "feature"]);
    vi.mocked(gitBranchCommits).mockResolvedValue([commit("only change")]);
    vi.mocked(gitCommitFiles).mockResolvedValue([file("a.txt")]);
    vi.mocked(gitCommitDiff).mockResolvedValue("@@ -1,1 +1,1 @@ h\n-old\n+new\n");
  });

  async function toCommit() {
    await waitFor(() => expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("a.txt");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Comment on line 1" })).toHaveLength(2));
  }

  it("leaves a comment on a commit, with the commit and the line's code, and shows it only there", async () => {
    render(<Commented />);
    await toCommit();
    // The removed line is first, the added one second.
    await write(1, 1, "Why new?");
    expect(kept).toEqual([
      expect.objectContaining({
        path: "a.txt",
        line: 1,
        side: "new",
        text: "Why new?",
        code: "new",
        commit: { hash: "hash-only change", short: "only ch", subject: "only change" },
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("git.ts");
    expect(screen.queryByText("Why new?")).toBeNull();
  });

  it("leaves a comment on what is not committed without a commit, and keeps it off the commits", async () => {
    render(<Commented />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Comment on line 1" })).toHaveLength(2));
    await write(0, 1, "Keep one?");
    expect(kept).toEqual([expect.objectContaining({ path: "src/lib/git.ts", side: "old", code: "one" })]);
    expect(kept[0].commit).toBeUndefined();

    await toCommit();
    expect(screen.queryByText("Keep one?")).toBeNull();
  });

  it("heads its file with a comment whose line the diff does not show", async () => {
    render(
      <Commented
        initial={[{ id: "c1", path: "src/lib/git.ts", line: 50, side: "new", text: "Far down", code: "x" }]}
      />,
    );
    expect(await screen.findByText("Far down")).toBeInTheDocument();
    expect(screen.getByText("line 50")).toBeInTheDocument();
  });

  it("deletes a comment from its card", async () => {
    render(<Commented initial={[{ id: "c1", path: "src/lib/git.ts", line: 1, side: "new", text: "Drop me", code: "ONE" }]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(kept).toEqual([]));
  });
});

describe("DiffBrowserView — the file tree", () => {
  beforeEach(() => localStorage.clear());

  it("hides and shows the changed files, still stepping through them, and remembers it", async () => {
    const { unmount } = view();
    await screen.findByRole("list", { name: "Changed files" });
    fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
    expect(screen.queryByRole("list", { name: "Changed files" })).toBeNull();
    // The keys still go from file to file, which the diff's own header names.
    await press("ArrowRight");
    expect(await screen.findByText("src/lib/tree.ts")).toBeInTheDocument();
    unmount();

    view();
    await screen.findByRole("button", { name: "Show files" });
    expect(screen.queryByRole("list", { name: "Changed files" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(screen.getByRole("list", { name: "Changed files" })).toBeInTheDocument();
  });
});
