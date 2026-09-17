import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangesView } from "./ChangesView";
import { gitChanges, gitDiff, type Changes, type FileChange } from "./lib/git";
import { listSessions } from "./lib/pty";

vi.mock("./lib/git", async (importOriginal) => ({
  // The helpers are pure and worth exercising for real; only the two calls
  // that reach the backend are stubbed.
  ...(await importOriginal<typeof import("./lib/git")>()),
  gitChanges: vi.fn(),
  gitDiff: vi.fn(),
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

const changes: Changes = {
  root: "/work/roer",
  branch: "changes-view",
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

const selectedFile = () => document.querySelector(".tree-row.selected .name")?.textContent ?? null;

beforeEach(() => {
  vi.mocked(gitChanges).mockReset().mockResolvedValue(changes);
  vi.mocked(gitDiff)
    .mockReset()
    .mockImplementation((_root, path) =>
      Promise.resolve(path === "README.md" ? oneHunk : twoHunks),
    );
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
});

const view = () => render(<ChangesView cwd="/work/roer/src" active />);

describe("ChangesView", () => {
  it("groups the changed files into a folder tree", async () => {
    view();
    await waitFor(() => expect(screen.getByText("src/lib")).toBeInTheDocument());
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

  it("crosses into the next file once the last change is behind it", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    await press("ArrowDown");
    await press("ArrowDown");

    await waitFor(() => expect(selectedFile()).toBe("tree.ts"));
    expect(position()).toBe("change 1 of 2");
  });

  it("steps back into the last change of the file above", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    await press("ArrowRight");
    await waitFor(() => expect(selectedFile()).toBe("tree.ts"));

    await press("ArrowUp");

    await waitFor(() => expect(selectedFile()).toBe("git.ts"));
    // Backwards means the end of the previous file, not its beginning.
    expect(position()).toBe("change 2 of 2");
  });

  it("stays put at the last change of the last file", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    for (let i = 0; i < 8; i += 1) await press("ArrowDown");

    await waitFor(() => expect(selectedFile()).toBe("README.md"));
    expect(position()).toBe("change 1 of 1");
  });

  it("walks whole files with the left and right keys", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    await press("ArrowRight");
    await waitFor(() => expect(selectedFile()).toBe("tree.ts"));

    await press("ArrowLeft");
    await waitFor(() => expect(selectedFile()).toBe("git.ts"));
  });

  it("opens a collapsed folder rather than hiding the selection in it", async () => {
    view();
    await waitFor(() => expect(screen.getByText("src/lib")).toBeInTheDocument());

    fireEvent.click(screen.getByText("src/lib"));
    expect(screen.queryByText("tree.ts")).not.toBeInTheDocument();

    // The keys still walk every change; landing on one reopens its folder.
    await press("ArrowRight");

    await waitFor(() => expect(screen.getByText("tree.ts")).toBeInTheDocument());
    expect(selectedFile()).toBe("tree.ts");
  });

  it("asks about the directory the session is in now, not the one it opened in", async () => {
    // A `cd` in the terminal is how you change repository, so the pane's live
    // directory is the one that matters.
    vi.mocked(listSessions).mockResolvedValue([
      { session: "roer-1", pane: "%3", attached: true, cwd: "/work/other", command: "zsh" },
    ]);

    render(<ChangesView cwd="/work/roer/src" pane="%3" active />);

    await waitFor(() => expect(gitChanges).toHaveBeenCalledWith("/work/other"));
  });

  it("says so when the session is not in a repository", async () => {
    vi.mocked(gitChanges).mockRejectedValue("not a git repository");

    view();

    await waitFor(() => expect(screen.getByText(/not a git repository/)).toBeInTheDocument());
  });

  it("has nothing to show for a clean worktree", async () => {
    vi.mocked(gitChanges).mockResolvedValue({ ...changes, files: [] });

    view();

    await waitFor(() => expect(screen.getByText(/No local changes/)).toBeInTheDocument());
    expect(gitDiff).not.toHaveBeenCalled();
  });

  it("reports a binary file instead of an empty diff", async () => {
    vi.mocked(gitChanges).mockResolvedValue({
      ...changes,
      files: [file("icon.png", { binary: true, added: 0, deleted: 0, counted: false })],
    });
    vi.mocked(gitDiff).mockResolvedValue("Binary files a/icon.png and b/icon.png differ\n");

    view();

    await waitFor(() => expect(screen.getByText(/Binary file/)).toBeInTheDocument());
  });

  it("shows a change as two sides, the old one beside the new", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    const [pair] = document.querySelectorAll(".hunk.current .pair");
    expect(pair.querySelector(".side.del .text")?.textContent).toBe("one");
    expect(pair.querySelector(".side.add .text")?.textContent).toBe("ONE");
    expect(pair.querySelectorAll(".side.gap")).toHaveLength(0);
  });

  it("switches to the diff a terminal would print", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    fireEvent.click(screen.getByText("Unified"));

    expect(document.querySelectorAll(".pair")).toHaveLength(0);
    const marks = [...document.querySelectorAll(".hunk.current .line .mark")].map(
      (mark) => mark.textContent,
    );
    expect(marks).toEqual(["-", "+"]);
  });

  it("keeps the keys on the same change across a switch of layout", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));
    await press("ArrowDown");

    fireEvent.click(screen.getByText("Unified"));

    expect(position()).toBe("change 2 of 2");
    expect(document.querySelector(".hunk.current .line .text")?.textContent).toBe("two");
  });

  /** Darcula, as `theme-darcula.ts` sets it and as jsdom reports it back. */
  const KEYWORD = "rgb(207, 142, 109)";
  const COMMENT = "rgb(122, 126, 133)";

  const coloured = (side: string) =>
    [...document.querySelectorAll<HTMLElement>(`${side} .text span`)].map(
      (span) => `${span.style.color}:${span.textContent}`,
    );

  it("colours the code with the language's own grammar", async () => {
    vi.mocked(gitDiff).mockResolvedValue(
      "@@ -1 +1 @@\n-const n = 1; // count\n+const n = 2; // count\n",
    );

    view();
    await waitFor(() => expect(position()).toBe("change 1 of 1"));
    // The grammar for `git.ts` is fetched, so the first paint is the painter's
    // and the one worth asserting on arrives after it.
    await waitFor(() => expect(coloured(".side.del")).toContain(`${KEYWORD}:const`));

    expect(coloured(".side.del")).toContain(`${COMMENT}:// count`);
    const comment = [...document.querySelectorAll<HTMLElement>(".side.del .text span")].find(
      (span) => span.textContent === "// count",
    );
    expect(comment?.style.fontStyle).toBe("italic");
  });

  it("falls back to the painter for a language it carries no grammar for", async () => {
    vi.mocked(gitChanges).mockResolvedValue({ ...changes, files: [file("run.pl")] });
    vi.mocked(gitDiff).mockResolvedValue("@@ -1 +1 @@\n-my $n = 1;\n+my $n = 2;\n");

    view();
    await waitFor(() => expect(position()).toBe("change 1 of 1"));

    const painted = [...document.querySelectorAll(".side.del .text span")].map(
      (span) => `${span.className}:${span.textContent}`,
    );
    // The digit is both the number and the whole of the edit.
    expect(painted).toContain("t-number ink:1");
    expect(painted).toContain("t-plain:my");
    // Nothing is coloured inline, because no grammar answered.
    expect(coloured(".side.del").every((entry) => entry.startsWith(":"))).toBe(true);
  });

  it("picks out only the run that changed", async () => {
    vi.mocked(gitDiff).mockResolvedValue(
      "@@ -1 +1 @@\n-const n = 1; // count\n+const n = 2; // count\n",
    );

    view();
    await waitFor(() => expect(position()).toBe("change 1 of 1"));
    await waitFor(() => expect(coloured(".side.add")).toContain(`${KEYWORD}:const`));

    // The lines differ in one digit, so that is the only thing picked out.
    const ink = document.querySelectorAll(".side.add .ink");
    expect([...ink].map((span) => span.textContent)).toEqual(["2"]);
  });

  it("says what happened to the file above its diff", async () => {
    view();
    await waitFor(() => expect(position()).toBe("change 1 of 2"));

    expect(document.querySelector(".diff-head .kind")?.textContent).toBe("modified");
  });

  it("says nothing about the size of a change nobody could measure", async () => {
    vi.mocked(gitChanges).mockResolvedValue({
      ...changes,
      files: [file("generated.sql", { unstaged: "?", counted: false, added: 0, deleted: 0 })],
    });

    view();

    await waitFor(() => expect(screen.getByText("generated.sql")).toBeInTheDocument());
    // Zero added and zero deleted would be a claim about the file; there is
    // none to make.
    expect(document.querySelector(".counts")).toBeNull();
  });

  it("selects the first change the tree shows, not the first git listed", async () => {
    // Git lists by path, and a folder sorts after a file at the root; the
    // tree puts the folder first, and that is the row the keys start on.
    vi.mocked(gitChanges).mockResolvedValue({
      ...changes,
      files: [file("README.md"), file("src/lib/git.ts")],
    });

    view();

    await waitFor(() => expect(selectedFile()).toBe("git.ts"));
  });

  it("re-reads the diff of the file it is on when the changes come back", async () => {
    view();
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(1));

    // A tab left and returned to re-reads git without anything else moving;
    // the file may have been edited in the terminal in between.
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
});
