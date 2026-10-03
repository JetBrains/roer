import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../api";
import { gitCurrentBranch, gitRoot } from "../../lib/git";
import { ChangesView } from "./ChangesView";
import { storeComments, storedComments } from "./local";
import type { DiffBrowserViewProps } from "./DiffBrowserView";
import type { ReviewViewProps } from "./ReviewView";

// The two views have tests of their own; here they only say what they were given.
vi.mock("./DiffBrowserView", () => ({
  DiffBrowserView: ({ active }: DiffBrowserViewProps) => <p>by commit {active ? "active" : "idle"}</p>,
}));
vi.mock("./ReviewView", () => ({
  ReviewView: ({ active, scope, onScope }: ReviewViewProps) => (
    <div>
      <p>
        review {scope} {active ? "active" : "idle"}
      </p>
      <button type="button" onClick={() => onScope?.("local")}>
        Show them
      </button>
    </div>
  ),
}));

vi.mock("../../lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git")>()),
  gitRoot: vi.fn(),
  gitCurrentBranch: vi.fn(),
}));
vi.mock("../../lib/session", () => ({ resolveDir: vi.fn(async (cwd?: string) => cwd ?? "") }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(gitRoot).mockResolvedValue("/repo");
  vi.mocked(gitCurrentBranch).mockResolvedValue("feat");
});

const session = { pane: "%1", cwd: "/repo", root: "/repo", branch: "feat", busy: false, changed: null } as unknown as Session;

describe("ChangesView", () => {
  it("opens by commit, and hands the keyboard only to the view on screen", () => {
    render(<ChangesView session={session} active />);
    expect(screen.getByRole("button", { name: "By commit", pressed: true })).toBeInTheDocument();
    expect(screen.getByText("by commit active")).toBeVisible();
    expect(screen.getByText("review local idle")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Whole branch" }));
    expect(screen.getByText("by commit idle")).not.toBeVisible();
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
    expect(screen.getByText("by commit idle")).toBeInTheDocument();
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
