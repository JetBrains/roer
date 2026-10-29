import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../api";
import { HostProvider, type AgentSession, type StartSession } from "../context";
import { gitBranches, gitCurrentBranch, gitRoot } from "../../lib/git";
import { sendToSession } from "../../lib/github";
import { ChangesView } from "./ChangesView";
import { storeComments, storedComments, storedRoles, updateRoles } from "./local";
import type { DiffBrowserViewProps } from "./DiffBrowserView";
import type { ReviewViewProps } from "./ReviewView";

// The two views have tests of their own; here they only say what they were given.
vi.mock("./DiffBrowserView", () => ({
  DiffBrowserView: ({ active, branch, showComment }: DiffBrowserViewProps) => (
    <>
      <p>
        by commit {active ? "active" : "idle"} on {branch ?? "nothing"}
      </p>
      {showComment ? <p>showing {showComment.id}</p> : null}
    </>
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
  gitDefaultBase: vi.fn(async () => ""),
}));
vi.mock("../../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/github")>()),
  sendToSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/session", () => ({ resolveDir: vi.fn(async (cwd?: string) => cwd ?? "") }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(sendToSession).mockClear();
  vi.mocked(gitRoot).mockResolvedValue("/repo");
  vi.mocked(gitCurrentBranch).mockResolvedValue("feat");
  vi.mocked(gitBranches).mockResolvedValue(["feat", "main", "spec"]);
});

const session = { pane: "%1", cwd: "/repo", root: "/repo", branch: "feat", busy: false, changed: null } as unknown as Session;

/** The tab inside a host with these live sessions and, when given, a way to start one. */
function hosted(staged: Session, sessions: AgentSession[], startSession?: StartSession, showSession = vi.fn()) {
  return render(
    <HostProvider
      value={{ extension: "changes", session: staged, scope: null, active: true, focused: true, openFile: vi.fn(), activateTab: vi.fn(), startSession, sessions, showSession }}
    >
      <ChangesView session={staged} active />
    </HostProvider>,
  );
}

/** Opens the chevron beside Send and picks `item`. */
async function sendVia(item: string) {
  const chevron = await screen.findByRole("button", { name: "Send to…" });
  await waitFor(() => expect(chevron).toBeEnabled());
  fireEvent.keyDown(chevron, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("ChangesView", () => {
  it("opens on the branch, and hands the keyboard only to the view on screen", () => {
    render(<ChangesView session={session} active />);
    expect(screen.getByRole("button", { name: "Branch", pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "By commit" })).toBeNull();
    expect(screen.getByText(/by commit active/)).toBeVisible();
    expect(screen.getByText("review pr idle")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Pull request" }));
    expect(screen.getByText(/by commit idle/)).not.toBeVisible();
    expect(screen.getByText("review pr active")).toBeVisible();
  });

  it("goes where the review view asks", () => {
    render(<ChangesView session={session} active />);
    fireEvent.click(screen.getByRole("button", { name: "Pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByRole("button", { name: "Branch", pressed: true })).toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: "Send 1" })).toBeDisabled();
  });

  it("starts each view over for another branch, so the last one's work is never shown under its name", async () => {
    render(<ChangesView session={session} active />);
    const picker = await screen.findByRole("combobox", { name: "Branch" });
    await waitFor(() => expect(picker).toHaveValue("feat"));
    const before = { commits: screen.getByText(/^by commit/), review: screen.getByText(/^review of/) };
    fireEvent.change(picker, { target: { value: "spec" } });
    // New elements, not the old ones relabelled: whatever they held for feat is gone.
    expect(screen.getByText(/^by commit/)).not.toBe(before.commits);
    expect(screen.getByText(/^review of/)).not.toBe(before.review);
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
    expect(await screen.findByText("Sent 2 comments to this session, with Claude.")).toBeInTheDocument();
    expect(storedComments("/repo", "feat").map((c) => c.id)).toEqual(["c3"]);
    expect(onSent).toHaveBeenCalled();
  });

  it("accepts what is undecided without sending it, the decisions already made kept", async () => {
    storeComments("/repo", "feat", [
      { id: "c1", path: "a.ts", line: 2, side: "new", text: "Declined one.", code: "x", author: "Claude", verdict: { kind: "decline" } },
      { id: "c2", path: "a.ts", line: 5, side: "new", text: "Undecided one.", code: "y", author: "Claude" },
      { id: "c3", path: "a.ts", line: 7, side: "new", text: "Undecided two.", code: "z", author: "Claude" },
    ]);
    const send = vi.fn().mockResolvedValue(undefined);
    render(<ChangesView session={{ ...session, agent: "claude", send }} active />);
    expect(await screen.findByText("2 to decide")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send 1 to Claude" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept the rest" }));
    expect(await screen.findByRole("button", { name: "Send 3 to Claude" })).toBeEnabled();
    expect(send).not.toHaveBeenCalled();
    expect(storedComments("/repo", "feat").map((c) => c.verdict?.kind)).toEqual(["decline", "accept", "accept"]);
    expect(screen.queryByText(/to decide/)).toBeNull();
  });

  it("shows Send as soon as a review lands, with nothing to send until something is decided", async () => {
    storeComments("/repo", "feat", [{ id: "c1", path: "a.ts", line: 2, side: "new", text: "New.", code: "x", author: "Claude" }]);
    render(<ChangesView session={{ ...session, agent: "claude", send: vi.fn() }} active />);
    expect(await screen.findByRole("button", { name: "Accept the rest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send 0 to Claude" })).toBeDisabled();
  });

  it("goes from the count still to decide to the first of them, in the tree's order, on the branch before a commit", async () => {
    storeComments("/repo", "feat", [
      { id: "on-commit", path: "a.ts", line: 1, side: "new", text: "x", code: "x", author: "Codex", commit: { hash: "h1", short: "h1", subject: "s" } },
      { id: "readme", path: "README.md", line: 1, side: "new", text: "x", code: "x", author: "Codex" },
      { id: "deep-low", path: "src/lib/b.ts", line: 9, side: "new", text: "x", code: "x", author: "Codex" },
      { id: "deep-top", path: "src/lib/b.ts", line: 2, side: "new", text: "x", code: "x", author: "Codex" },
      { id: "decided", path: "src/a.ts", line: 1, side: "new", text: "x", code: "x", author: "Codex", verdict: { kind: "accept" } },
    ]);
    render(<ChangesView session={{ ...session, agent: "claude", send: vi.fn() }} active />);
    fireEvent.click(await screen.findByRole("button", { name: "4 to decide" }));
    // The tree lists folders before files, so src/lib/b.ts comes before README.md, and its top line first.
    expect(screen.getByText("showing deep-top")).toBeInTheDocument();
  });

  it("offers the sessions there are when none is on screen, rather than looking for a repository in no folder", async () => {
    const showSession = vi.fn();
    const activateTab = vi.fn();
    render(
      <HostProvider
        value={{
          extension: "changes",
          session: null,
          scope: null,
          active: true,
          focused: true,
          openFile: vi.fn(),
          activateTab,
          sessions: [{ pane: "%4", id: "s4", agent: "codex", cwd: "/work/roer" }],
          showSession,
        }}
      >
        <ChangesView session={null} active />
      </HostProvider>,
    );
    expect(screen.getByText("No session on screen")).toBeInTheDocument();
    expect(screen.queryByText(/by commit/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Codex in roer" }));
    expect(showSession).toHaveBeenCalledWith("%4");
    fireEvent.click(screen.getByRole("button", { name: "Pick another in Workspace" }));
    expect(activateTab).toHaveBeenCalledWith("sessions");
    expect(gitRoot).not.toHaveBeenCalled();
  });

  describe("where the decisions go", () => {
    const accepted = () =>
      storeComments("/repo", "feat", [
        { id: "c1", path: "a.ts", line: 2, side: "new", text: "Fix it.", code: "x", author: "Codex", verdict: { kind: "accept" } },
      ]);

    it("goes back to the session that asked for the review, not the reviewer now on the stage", async () => {
      accepted();
      updateRoles("/repo", "feat", () => ({ asker: { pane: "%1", id: "s1" }, reviewer: { pane: "%2", id: "s2" } }));
      const send = vi.fn().mockResolvedValue(undefined);
      const onStage = { ...session, pane: "%2", agent: "codex", send };
      hosted(onStage, [
        { pane: "%1", id: "s1", agent: "claude", cwd: "/repo" },
        { pane: "%2", id: "s2", agent: "codex", cwd: "/repo" },
      ]);
      const button = await screen.findByRole("button", { name: "Send 1 to the asking session" });
      expect(button).toHaveAttribute("title", "Send 1 comment to the session that asked for the review, with Claude");
      fireEvent.click(button);
      await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%1", expect.stringMatching(/Fix it\./)));
      // Where that session is now cannot be read here, so it is told which repository and branch.
      expect(vi.mocked(sendToSession).mock.calls[0][1]).toMatch(/^This is about the branch `feat` of the repository at `\/repo`/);
      expect(send).not.toHaveBeenCalled();
      expect(await screen.findByText("Sent 1 comment to the session that asked for the review, with Claude.")).toBeInTheDocument();
      expect(storedComments("/repo", "feat")).toEqual([]);
    });

    it("offers only the other places from the chevron, and brings the one it went to up", async () => {
      accepted();
      updateRoles("/repo", "feat", () => ({ asker: { pane: "%1", id: "s1" }, reviewer: { pane: "%2", id: "s2" } }));
      const send = vi.fn().mockResolvedValue(undefined);
      const showSession = vi.fn();
      hosted({ ...session, agent: "claude", send }, [
        { pane: "%1", id: "s1", agent: "claude", cwd: "/repo" },
        { pane: "%2", id: "s2", agent: "codex", cwd: "/repo" },
      ], undefined, showSession);
      expect(await screen.findByRole("button", { name: "Send 1 to Claude" })).toBeEnabled();
      fireEvent.keyDown(screen.getByRole("button", { name: "Send to…" }), { key: "Enter" });
      // Only the other place: the button is this session already.
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["The session that reviewed it, with Codex"]);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await sendVia("The session that reviewed it, with Codex");
      await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%2", expect.any(String)));
      expect(send).not.toHaveBeenCalled();
      await waitFor(() => expect(showSession).toHaveBeenCalledWith("%2"));
    });

    it("leaves out a session that has ended", async () => {
      accepted();
      updateRoles("/repo", "feat", () => ({ asker: { pane: "%9", id: "s9" } }));
      hosted({ ...session, agent: "claude", send: vi.fn() }, [{ pane: "%1", id: "s1", agent: "claude", cwd: "/repo" }]);
      expect(await screen.findByRole("button", { name: "Send 1 to Claude" })).toBeEnabled();
    });

    it("does not take a later session in the asker's pane for the asker", async () => {
      accepted();
      // A new tmux server numbered its panes from %0 again: %1 is someone else now.
      updateRoles("/repo", "feat", () => ({ asker: { pane: "%1", id: "before-restart" } }));
      hosted({ ...session, pane: "%2", agent: "codex", send: vi.fn() }, [
        { pane: "%1", id: "s1", agent: "claude", cwd: "/elsewhere" },
        { pane: "%2", id: "s2", agent: "codex", cwd: "/repo" },
      ]);
      expect(await screen.findByRole("button", { name: "Send 1 to Codex" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Send to…" })).toBeNull();
    });

    it("gives a reviewer its tool call named only by its pane the id of the session live there", async () => {
      accepted();
      updateRoles("/repo", "feat", () => ({ asker: { pane: "%1", id: "s1" }, reviewer: { pane: "%2" } }));
      hosted({ ...session, agent: "claude", send: vi.fn() }, [
        { pane: "%1", id: "s1", agent: "claude", cwd: "/repo" },
        { pane: "%2", id: "s2", agent: "codex", cwd: "/repo" },
      ]);
      await waitFor(() => expect(storedRoles("/repo", "feat").reviewer).toEqual({ pane: "%2", id: "s2" }));
    });

    it("starts no session of its own: with no agent to send to, Send waits", async () => {
      accepted();
      hosted({ ...session, agent: null, send: vi.fn() }, [], vi.fn().mockResolvedValue(true));
      expect(await screen.findByRole("button", { name: "Send 1" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Send to…" })).toBeNull();
    });
  });
});
