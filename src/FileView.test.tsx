import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileView } from "./FileView";
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
});
