import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../api";
import { gitBranches, gitCurrentBranch, gitRoot } from "../../lib/git";
import { ChangesView } from "./ChangesView";
import { storeComments, storedComments } from "./local";
import type { DiffBrowserViewProps } from "./DiffBrowserView";
import type { ReviewViewProps } from "./ReviewView";

// The two views have tests of their own; here they only say what they were given.
vi.mock("./DiffBrowserView", () => ({
  DiffBrowserView: ({ active, branch }: DiffBrowserViewProps) => (
    <p>
      by commit {active ? "active" : "idle"} on {branch ?? "nothing"}
    </p>
  ),
}));
vi.mock("./ReviewView", () => ({
  ReviewView: ({ active, scope, onScope, branch }: ReviewViewProps) => (
    <div>
      <p>
        review {scope} {active ? "active" : "idle"}
      </p>
      <p>review of {branch ?? "the checked-out branch"}</p>
      <button type="button" onClick={() => onScope?.("local")}>
        Show them
      </button>
    </div>
  ),
}));

vi.mock("../../lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git")>()),
  gitRoot: vi.fn(),
  gitBranches: vi.fn(),
  gitCurrentBranch: vi.fn(),
}));
vi.mock("../../lib/session", () => ({ resolveDir: vi.fn(async (cwd?: string) => cwd ?? "") }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(gitRoot).mockResolvedValue("/repo");
  vi.mocked(gitCurrentBranch).mockResolvedValue("feat");
  vi.mocked(gitBranches).mockResolvedValue(["feat", "main", "spec"]);
});

const session = { pane: "%1", cwd: "/repo", root: "/repo", branch: "feat", busy: false, changed: null } as unknown as Session;

describe("ChangesView", () => {
  it("opens by commit, and hands the keyboard only to the view on screen", () => {
    render(<ChangesView session={session} active />);
    expect(screen.getByRole("button", { name: "By commit", pressed: true })).toBeInTheDocument();
    expect(screen.getByText(/by commit active/)).toBeVisible();
    expect(screen.getByText("review local idle")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Whole branch" }));
    expect(screen.getByText(/by commit idle/)).not.toBeVisible();
    expect(screen.getByText("review local active")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Pull request" }));
    expect(screen.getByText("review pr active")).toBeVisible();
  });

  it("goes where the review view asks", () => {
    render(<ChangesView session={session} active />);
    fireEvent.click(screen.getByRole("button", { name: "Pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByRole("button", { name: "Whole branch", pressed: true })).toBeInTheDocument();
  });

  it("takes no keyboard while the tab is not on top", () => {
    render(<ChangesView session={session} active={false} />);
    expect(screen.getByText(/by commit idle/)).toBeInTheDocument();
  });

  it("shows another branch in every view once it is picked, until the session changes", async () => {
    const { rerender } = render(<ChangesView session={session} active />);
    const picker = await screen.findByRole("combobox", { name: "Branch" });
    await waitFor(() => expect(picker).toHaveValue("feat"));
    // The checked-out one heads the list under its own heading, the closed picker showing just its name.
    expect(screen.getByRole("group", { name: "Checked out here" })).toHaveTextContent("feat");
    expect(screen.getByText("by commit active on feat")).toBeInTheDocument();
    expect(screen.getByText("review of the checked-out branch")).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: "spec" } });
    expect(screen.getByText("by commit active on spec")).toBeInTheDocument();
    expect(screen.getByText("review of spec")).toBeInTheDocument();
    expect(screen.getByText("not checked out")).toBeInTheDocument();

    // Picking the checked-out one again is following it again.
    fireEvent.change(picker, { target: { value: "feat" } });
    expect(screen.getByText("review of the checked-out branch")).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: "spec" } });
    rerender(<ChangesView session={{ ...session, pane: "%2" }} active />);
    expect(await screen.findByText("review of the checked-out branch")).toBeInTheDocument();
  });

  it("offers a detached HEAD as itself, and every view follows it", async () => {
    vi.mocked(gitCurrentBranch).mockResolvedValue("");
    render(<ChangesView session={{ ...session, branch: null }} active />);
    const picker = await screen.findByRole("combobox", { name: "Branch" });
    await waitFor(() => expect(screen.getByRole("option", { name: "HEAD (detached)" })).toBeInTheDocument());
    expect(picker).toHaveValue("");
    expect(screen.getByText("by commit active on HEAD")).toBeInTheDocument();
    expect(screen.getByText("review of the checked-out branch")).toBeInTheDocument();
  });

  it("looks the repository up again after a cd into another one", async () => {
    const { rerender } = render(<ChangesView session={session} active />);
    await waitFor(() => expect(screen.getByRole("option", { name: "spec" })).toBeInTheDocument());
    vi.mocked(gitRoot).mockResolvedValue("/other");
    vi.mocked(gitBranches).mockResolvedValue(["feat", "trunk"]);
    rerender(<ChangesView session={{ ...session, root: "/other" }} active />);
    expect(await screen.findByRole("option", { name: "trunk" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "spec" })).toBeNull();
  });

  it("hands nothing to a plain shell", async () => {
    storeComments("/repo", "feat", [{ id: "c1", path: "a.ts", line: 2, side: "new", text: "On feat.", code: "x" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    render(<ChangesView session={{ ...session, agent: null, send }} active />);
    expect(await screen.findByRole("button", { name: "Send 1 to the agent" })).toBeDisabled();
  });

  it("tells the agent when the comments are on a branch it does not have checked out", async () => {
    storeComments("/repo", "spec", [{ id: "c1", path: "a.ts", line: 2, side: "new", text: "On spec.", code: "x" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    render(<ChangesView session={{ ...session, agent: "claude", send }} active />);
    const picker = await screen.findByRole("combobox", { name: "Branch" });
    await waitFor(() => expect(picker).toHaveValue("feat"));
    fireEvent.change(picker, { target: { value: "spec" } });
    fireEvent.click(await screen.findByRole("button", { name: "Send 1 to Claude" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toMatch(/^This is about the branch `spec`, which is not the one checked out here\.[\s\S]*On spec\./);
  });

  it("sends every comment, by commit or on the whole branch, with one button, then clears them", async () => {
    storeComments("/repo", "feat", [
      { id: "c1", path: "a.ts", line: 2, side: "new", text: "On the branch.", code: "x" },
      { id: "c2", path: "a.ts", line: 5, side: "new", text: "On a commit.", code: "y", commit: { hash: "h1", short: "h1", subject: "Add y" } },
      // An agent's comment nobody has decided on yet stays behind.
      { id: "c3", path: "a.ts", line: 7, side: "new", text: "Undecided.", code: "z", author: "Claude" },
    ]);
    const send = vi.fn().mockResolvedValue(undefined);
    const onSent = vi.fn();
    render(<ChangesView session={{ ...session, agent: "claude", send }} active onSent={onSent} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send 2 to Claude" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toMatch(/On the branch\.[\s\S]*in commit h1 \("Add y"\)[\s\S]*On a commit\./);
    expect(await screen.findByText("Sent 2 comments to Claude.")).toBeInTheDocument();
    expect(storedComments("/repo", "feat").map((c) => c.id)).toEqual(["c3"]);
    expect(onSent).toHaveBeenCalled();
  });
});
