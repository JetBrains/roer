import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiffPane, type DiffPaneProps } from "./DiffPane";
import type { FileChange } from "./lib/git";
import type { DiffNote } from "./lib/diff";

const files = [{ path: "a.ts", status: "M", added: 2, deleted: 1, counted: true }] as unknown as FileChange[];
const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@", " one", "-two", "+TWO", " three", "+four", ""].join("\n");

const note = (line: number, text: string, more: Partial<DiffNote> = {}): DiffNote => ({ id: `n${line}`, path: "a.ts", line, author: "You", text, ...more });

function pane(props: Partial<DiffPaneProps> = {}) {
  return render(
    <DiffPane
      files={files}
      error={null}
      active
      loadDiff={() => Promise.resolve(patch)}
      resetKey="k"
      title="feat"
      emptyMessage="nothing"
      {...props}
    />,
  );
}

beforeEach(() => localStorage.clear());

describe("DiffPane comments", () => {
  it("hides the comments behind a switch, a count at the end of each line that has some showing them", async () => {
    pane({ notes: [note(2, "Why upper case?"), note(4, "And this one.")] });
    expect(await screen.findByText("Why upper case?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide comments" }));
    expect(screen.queryByText("Why upper case?")).toBeNull();
    expect(screen.queryByText("And this one.")).toBeNull();

    // One line's dot shows that line's alone, and hides it again.
    fireEvent.click(screen.getByRole("button", { name: "Show 1 comment on line 2" }));
    expect(screen.getByText("Why upper case?")).toBeInTheDocument();
    expect(screen.queryByText("And this one.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide 1 comment on line 2" }));
    expect(screen.queryByText("Why upper case?")).toBeNull();

    // Kept across views, like the layout.
    expect(localStorage.getItem("roer:diff-notes-hidden")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Show comments" }));
    expect(screen.getByText("And this one.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /comment on line 2$/ })).toBeNull();
  });

  it("shows a hidden comment once it is stepped to", async () => {
    localStorage.setItem("roer:diff-notes-hidden", "1");
    pane({ notes: [note(2, "Why upper case?"), note(4, "And this one.")] });
    await screen.findByRole("button", { name: "Show 1 comment on line 2" });
    fireEvent.click(screen.getByRole("button", { name: "Next comment" }));
    expect(screen.getByText("Why upper case?")).toBeInTheDocument();
    expect(screen.queryByText("And this one.")).toBeNull();
  });

  it("folds a comment that is done with to one line, which opens it", async () => {
    pane({ notes: [note(2, "Why upper case?\nIt was lower before.", { folded: "resolved" })] });
    const folded = await screen.findByRole("button", { name: "Show You's comment: resolved" });
    expect(folded).toHaveTextContent("Why upper case?");
    expect(screen.queryByText("It was lower before.", { exact: false })).toBeNull();
    fireEvent.click(folded);
    expect(screen.getByText(/It was lower before\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fold" }));
    expect(screen.getByRole("button", { name: "Show You's comment: resolved" })).toBeInTheDocument();
  });

  it("draws a note the owner draws itself in place of its card", async () => {
    pane({
      notes: [note(2, "card text")],
      renderNote: (one) => (one.id === "n2" ? <p>drawn by the owner</p> : undefined),
    });
    expect(await screen.findByText("drawn by the owner")).toBeInTheDocument();
    expect(screen.queryByText("card text")).toBeNull();
  });

  it("offers each way to submit a comment, the first on ⌘↵, and says which was picked", async () => {
    const onAddNote = vi.fn();
    pane({
      onAddNote,
      composeActions: [
        { label: "Add to review", value: "review" },
        { label: "Ask", value: "ask" },
      ],
    });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Comment on line 4" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Comment on line 4" })[0]);
    const box = screen.getByRole("group", { name: "New comment on line 4" });
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Why?" } });
    fireEvent.click(within(box).getByRole("button", { name: "Ask" }));
    expect(onAddNote).toHaveBeenLastCalledWith({ path: "a.ts", line: 4, side: "new", text: "Why?", action: "ask" });

    fireEvent.click(screen.getAllByRole("button", { name: "Comment on line 4" })[0]);
    const again = screen.getByRole("textbox", { name: "Comment on line 4" });
    fireEvent.change(again, { target: { value: "Rename it." } });
    fireEvent.keyDown(again, { key: "Enter", metaKey: true });
    expect(onAddNote).toHaveBeenLastCalledWith({ path: "a.ts", line: 4, side: "new", text: "Rename it.", action: "review" });
  });
});
