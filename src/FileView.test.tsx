import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileView } from "./FileView";
import type { Session } from "./extensions/api";
import { allThreads, replyToThread, startThread } from "./lib/threads";
import { sendToSession } from "./lib/github";
import { fileRead, type FilesChanged, type FileText } from "./lib/files";
import {
  gitBlob,
  gitBranchCommits,
  gitBranchDiff,
  gitChanges,
  gitCommitDiff,
  gitCommitFiles,
  gitCurrentBranch,
  gitDefaultBase,
  gitDiff,
  type Commit,
} from "./lib/git";

vi.mock("./lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/github")>()),
  sendToSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/files")>()),
  fileRead: vi.fn(),
}));
vi.mock("./lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/git")>()),
  gitBlob: vi.fn(),
  gitBranchCommits: vi.fn(),
  gitBranchDiff: vi.fn(),
  gitChanges: vi.fn(),
  gitCommitDiff: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitDefaultBase: vi.fn(),
  gitDiff: vi.fn(),
}));

const read = vi.mocked(fileRead);

const text = (over: Partial<FileText> = {}): FileText => ({
  text: "",
  lines: 0,
  truncated: false,
  binary: false,
  bytes: 0,
  ...over,
});

/**
 * A file of `count` numbered lines.
 *
 * One bare word per line, deliberately: the colourer splits `line 3` into a
 * word and a number, which are two elements, and then no query can match the
 * row by its text.
 */
const numbered = (count: number): FileText => {
  const body = Array.from({ length: count }, (_, i) => `row${i + 1}`).join(
    "\n",
  );
  return text({ text: `${body}\n`, lines: count, bytes: body.length + 1 });
};

const show = (props: Partial<Parameters<typeof FileView>[0]> = {}) =>
  render(
    <FileView
      root="/Users/test/project"
      path="src/App.tsx"
      active
      {...props}
    />,
  );

const commit = (hash: string, subject: string): Commit => ({
  hash,
  short: hash.slice(0, 7),
  author: "A",
  date: 0,
  subject,
  body: "",
});

/** A `git diff` of src/App.tsx that adds line 2 and replaces line 3, as the branch diff has it. */
const branchPatch =
  "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,3 @@\n row1\n+row2\n-old3\n+row3\n";

const row = (text: string) => screen.getByText(text).closest(".file-line");

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(numbered(3));
  vi.mocked(gitDefaultBase).mockResolvedValue("main");
  vi.mocked(gitCurrentBranch).mockResolvedValue("feature");
  vi.mocked(gitBranchCommits).mockResolvedValue([]);
  vi.mocked(gitCommitFiles).mockResolvedValue([]);
  vi.mocked(gitBranchDiff).mockResolvedValue({ root: "/Users/test/project", base: "main", commits: 0, diff: "", from: "HEAD" });
  vi.mocked(gitChanges).mockResolvedValue({ root: "/Users/test/project", branch: "feature", commit: "abc", files: [] });
  vi.mocked(gitDiff).mockResolvedValue("");
  vi.mocked(gitCommitDiff).mockResolvedValue("");
});

describe("FileView", () => {
  it("shows a picture as one, read from the worktree", async () => {
    vi.mocked(gitBlob).mockResolvedValue("iVBORw0K");
    show({ path: "docs/shot.png" });
    expect(await screen.findByRole("img", { name: "docs/shot.png" })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0K",
    );
    expect(gitBlob).toHaveBeenCalledWith("/Users/test/project", "docs/shot.png");
    expect(read).not.toHaveBeenCalled();
  });

  it("shows the pictures a Markdown file names, from beside it, and links the ones on the web", async () => {
    read.mockResolvedValue(text({ text: "![Shot](shots/a.png)\n\n![Badge](https://example.com/b.svg)\n", lines: 3 }));
    vi.mocked(gitBlob).mockResolvedValue("iVBORw0K");
    show({ path: "docs/guide.md" });
    expect(await screen.findByRole("img", { name: "Shot" })).toHaveAttribute("src", "data:image/png;base64,iVBORw0K");
    expect(gitBlob).toHaveBeenCalledWith("/Users/test/project", "docs/shots/a.png");
    expect(screen.getByRole("link", { name: "[image: Badge]" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Badge" })).toBeNull();
  });

  it("reads the file the tab is about", async () => {
    show();
    await waitFor(() =>
      expect(read).toHaveBeenCalledWith("/Users/test/project", "src/App.tsx"),
    );
  });

  it("numbers the lines", async () => {
    show();
    await screen.findByText("row1");

    // Read off the attribute, because that is where the number is: the
    // gutter holds no text, so that a selection over the code cannot copy it.
    const gutter = document.querySelectorAll(".file-no");
    expect([...gutter].map((one) => one.getAttribute("data-no"))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("shows the path it is reading", async () => {
    show({ path: "src/lib/tabs.ts" });
    expect(await screen.findByText("src/lib/tabs.ts")).toBeInTheDocument();
  });

  it("counts the lines in the header", async () => {
    show();
    expect(await screen.findByText("3 lines")).toBeInTheDocument();
  });

  it("does not count a trailing newline as a line of its own", async () => {
    read.mockResolvedValue(text({ text: "one\n", lines: 1, bytes: 4 }));
    show();
    await screen.findByText("one");
    expect(document.querySelectorAll(".file-no")).toHaveLength(1);
  });

  it("says when the file is empty", async () => {
    read.mockResolvedValue(text());
    show();
    expect(await screen.findByText("Empty file.")).toBeInTheDocument();
  });

  it("says when the file is binary rather than drawing it", async () => {
    read.mockResolvedValue(text({ binary: true, bytes: 900 }));
    show();
    expect(
      await screen.findByText("Binary file — nothing to show."),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".file-no")).toHaveLength(0);
  });

  it("says when only the start of the file was read", async () => {
    read.mockResolvedValue({
      ...numbered(3),
      truncated: true,
      bytes: 3 * 1024 * 1024,
    });
    show();
    expect(
      await screen.findByText(/Showing the first 1024 KB of a 3072 KB file/),
    ).toBeInTheDocument();
  });

  it("reports a file it could not read", async () => {
    read.mockRejectedValue(
      "could not read src/App.tsx: No such file or directory",
    );
    show();
    expect(
      await screen.findByText(/No such file or directory/),
    ).toBeInTheDocument();
  });

  it("refuses nothing the backend allowed, and says what it refused", async () => {
    read.mockRejectedValue("../etc/passwd is outside the repository");
    show();
    expect(
      await screen.findByText(/outside the repository/),
    ).toBeInTheDocument();
  });

  it("puts only the window in the DOM, not the whole file", async () => {
    read.mockResolvedValue(numbered(10_000));
    show();
    await screen.findByText("row1");

    // A screenful and its overscan, not ten thousand rows.
    const drawn = document.querySelectorAll(".file-line").length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(200);
  });

  it("draws the lines a scroll brings into view", async () => {
    read.mockResolvedValue(numbered(10_000));
    show();
    await screen.findByText("row1");

    const body = document.querySelector(".file-body") as HTMLElement;
    // 18px a line, so this is somewhere around line 300.
    fireEvent.scroll(body, { target: { scrollTop: 5400 } });

    await waitFor(() => expect(screen.getByText("row301")).toBeInTheDocument());
    expect(screen.queryByText("row1")).not.toBeInTheDocument();
  });

  it("keeps the scrollbar honest about a file it is not all drawing", async () => {
    read.mockResolvedValue(numbered(1000));
    show();
    await screen.findByText("row1");

    // The spacers stand in for the rows that are not there, so the two of
    // them plus the drawn rows account for every line in the file.
    const body = document.querySelector(".file-body") as HTMLElement;
    const spacers = [...body.children].filter(
      (one) => !one.classList.contains("file-lines"),
    );
    const spaced = spacers.reduce(
      (sum, one) => sum + parseInt((one as HTMLElement).style.height),
      0,
    );
    const drawn = document.querySelectorAll(".file-line").length;

    // 22 is the row height the view guesses before it has measured one: the diff's.
    expect(spaced / 22 + drawn).toBe(1000);
  });

  it("colours the code with the language's own grammar", async () => {
    read.mockResolvedValue(
      text({ text: "const x = 1;\n", lines: 1, bytes: 13 }),
    );
    show();

    // A grammar names the colour outright; the regex fallback sets a class and
    // lets CSS decide, so an inline colour is proof of which one ran.
    await waitFor(() =>
      expect(screen.getByText("const").getAttribute("style")).toMatch(/color/),
    );
  });

  it("falls back to the regex colourer where there is no grammar", async () => {
    read.mockResolvedValue(
      text({ text: "const x = 1;\n", lines: 1, bytes: 13 }),
    );
    show({ path: "notes.unknownext" });

    expect(await screen.findByText("const")).toHaveClass("t-keyword");
  });

  it("says when a file is too long to colour, and still draws it", async () => {
    read.mockResolvedValue(numbered(6000));
    show();
    await screen.findByText("row1");

    // Tokenising is not a drawing cost, so windowing does not make a
    // generated file affordable; it falls back to the regex painter.
    expect(screen.getByText(/too long to colour fully/)).toBeInTheDocument();
    expect(document.querySelectorAll(".file-line").length).toBeGreaterThan(0);
  });

  it("re-reads when the tab is pointed at another file", async () => {
    const { rerender } = show();
    await screen.findByText("row1");

    read.mockResolvedValue(text({ text: "other\n", lines: 1, bytes: 6 }));
    rerender(
      <FileView root="/Users/test/project" path="src/other.ts" active />,
    );

    expect(await screen.findByText("other")).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith(
      "/Users/test/project",
      "src/other.ts",
    );
  });

  it("re-reads the file whenever the tab comes to the front", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx" };
    const { rerender } = render(<FileView {...props} active={false} />);
    // Nothing to read while it is behind another tab.
    expect(read).not.toHaveBeenCalled();

    rerender(<FileView {...props} active />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    rerender(<FileView {...props} active={false} />);
    rerender(<FileView {...props} active />);

    // The session has been editing files the whole time it was hidden.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("keeps the old text on screen while it re-reads the same file", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx" };
    const { rerender } = render(<FileView {...props} active />);
    await screen.findByText("row1");

    rerender(<FileView {...props} active={false} />);
    rerender(<FileView {...props} active />);

    // No blink through "Reading…", which would take the scroll with it.
    expect(screen.queryByText("Reading…")).not.toBeInTheDocument();
    expect(screen.getByText("row1")).toBeInTheDocument();
  });

  it("scrolls to the line a path:42 query asked for", async () => {
    read.mockResolvedValue(numbered(1000));
    show({ line: 400 });

    // Opened around line 400, rather than at the top of the file.
    expect(await screen.findByText("row400")).toBeInTheDocument();
    expect(screen.queryByText("row1")).not.toBeInTheDocument();
  });

  describe("Markdown", () => {
    it("renders a Markdown file as Preview by default", async () => {
      read.mockResolvedValue(
        text({ text: "# Title\n\n- one\n- two\n", lines: 4, bytes: 20 }),
      );
      show({ path: "README.md" });

      expect(await screen.findByRole("heading", { name: "Title" })).toBeInTheDocument();
      expect(screen.getByText("one")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("switches to Raw and shows the line-numbered source", async () => {
      read.mockResolvedValue(
        text({ text: "# Title\n\nrow1\n", lines: 3, bytes: 14 }),
      );
      show({ path: "README.md" });
      await screen.findByRole("heading", { name: "Title" });

      fireEvent.click(screen.getByRole("button", { name: "Raw" }));

      expect(await screen.findByText("# Title")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Title" })).not.toBeInTheDocument();
    });

    it("shows no Preview/Raw toggle for a non-Markdown file", async () => {
      show({ path: "src/App.tsx" });
      await screen.findByText("row1");

      expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    });

    it("opens a Markdown file at a line in Raw view, not Preview", async () => {
      read.mockResolvedValue(numbered(1000));
      show({ path: "NOTES.md", line: 400 });

      expect(await screen.findByText("row400")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("re-reads when the watch names this file, and not when it names another", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx", active: true };
    const changed = (paths: string[], over: Partial<FilesChanged> = {}): FilesChanged => ({
      root: props.root,
      paths,
      broad: false,
      ...over,
    });

    const { rerender } = render(<FileView {...props} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    // The tab was never left: an agent wrote the file and the text follows.
    rerender(<FileView {...props} changed={changed(["src/App.tsx"])} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    // Its neighbours are not its business.
    rerender(<FileView {...props} changed={changed(["src/other.ts"])} />);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);

    // Nor is another repository, however this file is named there.
    rerender(
      <FileView
        {...props}
        changed={changed(["src/App.tsx"], { root: "/Users/test/other" })}
      />,
    );
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);

    // A batch that gave up naming paths makes everything on screen suspect.
    rerender(<FileView {...props} changed={changed([], { broad: true })} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });

  it("keeps the old text on screen while the watch's re-read is out", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx", active: true };
    const { rerender } = render(<FileView {...props} />);
    await screen.findByText("row1");

    read.mockImplementation(() => new Promise(() => undefined));
    rerender(
      <FileView
        {...props}
        changed={{ root: props.root, paths: ["src/App.tsx"], broad: false }}
      />,
    );
    await act(async () => {});

    // No blink through "Reading…", which would take the scroll with it.
    expect(screen.queryByText("Reading…")).not.toBeInTheDocument();
    expect(screen.getByText("row1")).toBeInTheDocument();
  });

  describe("change marks", () => {
    it("marks what the whole branch changed, by default", async () => {
      vi.mocked(gitBranchDiff).mockResolvedValue({ root: "/Users/test/project", base: "main", commits: 1, diff: branchPatch, from: "f0" });
      show();
      await waitFor(() => expect(row("row2")).toHaveClass("add"));
      expect(row("row3")).toHaveClass("add");
      expect(row("row1")).not.toHaveClass("add");
      // What the branch took out is drawn where it was, above the line that replaced it, and not as file text.
      const removed = document.querySelector(".file-line.del");
      expect(removed?.querySelector("[data-text]")).toHaveAttribute("data-text", "old3");
      expect(removed?.nextElementSibling).toBe(row("row3"));
      expect(removed?.textContent).toBe("");
      expect(gitBranchDiff).toHaveBeenCalledWith("/Users/test/project", undefined, undefined);
      expect(screen.getByRole("combobox", { name: "Changes to mark" })).toHaveValue("all");
    });

    it("marks only what is not committed under Local changes", async () => {
      vi.mocked(gitChanges).mockResolvedValue({
        root: "/Users/test/project",
        branch: "feature",
        commit: "abc",
        files: [{ path: "src/App.tsx", staged: ".", unstaged: "M", added: 1, deleted: 0, binary: false, counted: true }],
      });
      vi.mocked(gitDiff).mockResolvedValue("@@ -1,2 +1,3 @@\n row1\n row2\n+row3\n");
      show();
      await screen.findByText("row1");
      fireEvent.change(screen.getByRole("combobox", { name: "Changes to mark" }), { target: { value: "local" } });
      await waitFor(() => expect(row("row3")).toHaveClass("add"));
      expect(gitDiff).toHaveBeenCalledWith("/Users/test/project", "src/App.tsx", false);
    });

    it("lists the branch's commits that touched the file, and shows the file as one left it", async () => {
      vi.mocked(gitBranchCommits).mockResolvedValue([commit("aaaaaaa1", "Touch it"), commit("bbbbbbb2", "Elsewhere")]);
      vi.mocked(gitCommitFiles).mockImplementation(async (_root, hash) =>
        hash === "aaaaaaa1"
          ? [{ path: "src/App.tsx", staged: "M", unstaged: ".", added: 1, deleted: 0, binary: false, counted: true }]
          : [],
      );
      vi.mocked(gitBlob).mockResolvedValue(btoa("then1\nthen2\n"));
      vi.mocked(gitCommitDiff).mockResolvedValue("@@ -1 +1,2 @@\n then1\n+then2\n");
      show();
      const picker = screen.getByRole("combobox", { name: "Changes to mark" });
      expect(await screen.findByRole("option", { name: "aaaaaaa Touch it" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "bbbbbbb Elsewhere" })).not.toBeInTheDocument();
      expect(gitBranchCommits).toHaveBeenCalledWith("/Users/test/project", "feature", "main");

      fireEvent.change(picker, { target: { value: "aaaaaaa1" } });
      await waitFor(() => expect(row("then2")).toHaveClass("add"));
      expect(gitBlob).toHaveBeenCalledWith("/Users/test/project", "src/App.tsx", "aaaaaaa1");
      expect(gitCommitDiff).toHaveBeenCalledWith("/Users/test/project", "aaaaaaa1", "src/App.tsx");
    });

    it("steps through the changes with the arrow keys, as the Changes view does, and scrolls without any", async () => {
      read.mockResolvedValue(numbered(5));
      vi.mocked(gitBranchDiff).mockResolvedValue({
        root: "/Users/test/project",
        base: "main",
        commits: 1,
        diff: "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,5 +1,5 @@\n row1\n+row2\n-was\n row3\n row4\n+row5\n-was5\n",
        from: "f0",
      });
      show();
      await waitFor(() => expect(row("row2")).toHaveClass("add"));
      expect(screen.getByText("↑↓ change")).toBeInTheDocument();
      const body = document.querySelector(".file-body")!;
      expect(body).toHaveFocus();

      fireEvent.keyDown(body, { key: "ArrowDown" });
      expect(row("row2")).toHaveClass("current");
      // Only the change itself, not the unchanged lines after it.
      expect(row("row3")).not.toHaveClass("current");
      fireEvent.keyDown(body, { key: "ArrowDown" });
      expect(row("row5")).toHaveClass("current");
      expect(row("row2")).not.toHaveClass("current");
      // The last change is as far as Down goes.
      fireEvent.keyDown(body, { key: "ArrowDown" });
      expect(row("row5")).toHaveClass("current");
      fireEvent.keyDown(body, { key: "ArrowUp" });
      expect(row("row2")).toHaveClass("current");
    });

    it("leaves the arrow keys to scroll a file with no changes", async () => {
      show();
      await screen.findByText("row1");
      const body = document.querySelector(".file-body")!;
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("↑↓ change")).not.toBeInTheDocument();
    });

    it("reads a branch no worktree has from git, read only, with no local changes to pick", async () => {
      vi.mocked(gitBlob).mockResolvedValue(btoa("there1\n"));
      show({ branch: "other" });
      expect(await screen.findByText("there1")).toBeInTheDocument();
      expect(read).not.toHaveBeenCalled();
      expect(gitBlob).toHaveBeenCalledWith("/Users/test/project", "src/App.tsx", "other");
      expect(screen.getByText("other · read only")).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "Local changes" })).not.toBeInTheDocument();
      await waitFor(() => expect(gitBranchDiff).toHaveBeenCalledWith("/Users/test/project", undefined, "other"));
      expect(gitBranchCommits).toHaveBeenCalledWith("/Users/test/project", "other", "main");
    });
  });

  describe("threads", () => {
    const session = (over: Partial<Session> = {}): Session => ({
      pane: "%1",
      root: "/Users/test/project",
      branch: "feature",
      agent: "claude",
      busy: false,
      changed: null,
      send: vi.fn().mockResolvedValue(undefined),
      ...over,
    });

    beforeEach(() => localStorage.clear());

    it("sends a comment on a line to the session's agent, and shows the agent's answer under the line", async () => {
      const staged = session();
      show({ session: staged });
      await screen.findByText("row2");
      fireEvent.click(screen.getByRole("button", { name: "Comment on line 2" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 2" }), { target: { value: "Why row2?" } });
      fireEvent.click(screen.getByRole("button", { name: "Send to claude" }));

      await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
      const prompt = vi.mocked(staged.send).mock.calls[0][0];
      expect(prompt).toContain("`src/App.tsx` line 2");
      expect(prompt).toContain("threads__answer");
      expect(prompt).toContain("row2");
      expect(prompt).toContain("Why row2?");
      const id = allThreads()[0].id;
      expect(prompt).toContain(`thread "${id}"`);
      expect(await screen.findByText("claude · waiting for an answer")).toBeInTheDocument();

      // The agent's tool answers.
      act(() => void replyToThread(id, "Claude", "It is the second row.", false));
      expect(await screen.findByText("It is the second row.")).toBeInTheDocument();
      expect(screen.queryByText("claude · waiting for an answer")).not.toBeInTheDocument();

      // A reply goes to it too.
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Reply on line 2" }), { target: { value: "Thanks" } });
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(2));
      expect(vi.mocked(staged.send).mock.calls[1][0]).toContain("Thanks");

      fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
      expect(allThreads()[0].state).toBe("resolved");
    });

    const live = (pane: string, id: string, cwd: string, over: object = {}) => ({ pane, id, agent: "claude", cwd, ...over });

    it("starts a thread with the session working in the file's worktree, and keeps it there when the stage moves", async () => {
      const stage = session({ pane: "%9", root: "/Users/test/other" });
      const sessions = [live("%9", "s9", "/Users/test/other"), live("%2", "s2", "/Users/test/project/src")];
      const { rerender } = show({ session: stage, sessions });
      await screen.findByText("row1");
      fireEvent.click(screen.getByRole("button", { name: "Comment on line 1" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 1" }), { target: { value: "Here?" } });
      fireEvent.click(screen.getByRole("button", { name: "Send to claude · src" }));
      await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%2", expect.stringContaining("Here?")));
      expect(stage.send).not.toHaveBeenCalled();
      expect(allThreads()[0].session).toMatchObject({ pane: "%2", id: "s2" });

      // The stage shows another session now; the reply still goes to the thread's.
      const other = session({ pane: "%9", root: "/Users/test/project" });
      rerender(<FileView root="/Users/test/project" path="src/App.tsx" active session={other} sessions={sessions} />);
      act(() => void replyToThread(allThreads()[0].id, "Claude", "Yes.", false));
      fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Reply on line 1" }), { target: { value: "Sure?" } });
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%2", expect.stringContaining("Sure?")));
      expect(other.send).not.toHaveBeenCalled();
    });

    it("shows an agent's own thread as waiting on the person, and sends the reply back to that agent's session", async () => {
      const sessions = [live("%4", "s4", "/Users/test/project")];
      startThread({
        root: "/Users/test/project",
        anchors: [{ kind: "line", path: "src/App.tsx", line: 2, code: "row2" }],
        text: "Is row2 right?",
        author: "Claude",
        session: { pane: "%4" },
      });
      show({ session: session({ pane: "%9" }), sessions });
      expect(await screen.findByText("Is row2 right?")).toBeInTheDocument();
      expect(screen.getByText("claude · project · for you")).toBeInTheDocument();
      // Its id is kept once it is seen live.
      await waitFor(() => expect(allThreads()[0].session).toMatchObject({ pane: "%4", id: "s4" }));

      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Reply on line 2" }), { target: { value: "Yes" } });
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%4", expect.stringContaining("Yes")));
    });

    it("moves a thread whose session ended to a live one, telling it the whole thread", async () => {
      const sessions = [live("%5", "s5", "/Users/test/project")];
      startThread({
        root: "/Users/test/project",
        anchors: [{ kind: "line", path: "src/App.tsx", line: 1, code: "row1" }],
        text: "First",
        session: { pane: "%3", id: "gone" },
      });
      const staged = session({ pane: "%5" });
      show({ session: staged, sessions });
      expect(await screen.findByText("agent · ended: a reply goes to claude · project")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Reply on line 1" }), { target: { value: "Again" } });
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
      expect(allThreads()[0].session).toMatchObject({ pane: "%5", id: "s5" });
      // New to that session, so it is told the thread from the start.
      const prompt = vi.mocked(staged.send).mock.calls[0][0];
      expect(prompt).toContain("This is Roer's thread");
      expect(prompt).toContain("I wrote: First");
      expect(prompt).toContain("Again");
      expect(sendToSession).not.toHaveBeenCalled();
    });

    it("comments on a range of lines, Shift-clicking its end, and quotes them all", async () => {
      const staged = session();
      show({ session: staged });
      await screen.findByText("row1");
      fireEvent.click(screen.getByRole("button", { name: "Comment on line 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Comment on line 3" }), { shiftKey: true });
      expect(row("row2")).toHaveClass("in-thread");
      fireEvent.change(screen.getByRole("textbox", { name: "Comment on lines 1–3" }), { target: { value: "All three?" } });
      fireEvent.click(screen.getByRole("button", { name: "Send to claude" }));
      await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
      expect(vi.mocked(staged.send).mock.calls[0][0]).toContain("lines 1–3");
      expect(vi.mocked(staged.send).mock.calls[0][0]).toContain("row1\nrow2\nrow3");
      expect(allThreads()[0].anchors[0]).toMatchObject({ kind: "line", line: 1, end: 3 });
      // Drawn under its last line.
      expect(row("row3")?.nextElementSibling).toHaveClass("file-notes");
    });

    it("holds a comment until the agent is free", async () => {
      const busy = session({ busy: true });
      const { rerender } = show({ session: busy });
      await screen.findByText("row1");
      fireEvent.click(screen.getByRole("button", { name: "Comment on line 1" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 1" }), { target: { value: "Look" } });
      fireEvent.click(screen.getByRole("button", { name: "Send to claude" }));
      expect(await screen.findByText("claude · waiting for it to be free")).toBeInTheDocument();
      expect(busy.send).not.toHaveBeenCalled();

      const free = { ...busy, busy: false };
      rerender(<FileView root="/Users/test/project" path="src/App.tsx" active session={free} />);
      await waitFor(() => expect(free.send).toHaveBeenCalledTimes(1));
    });
  });
});

