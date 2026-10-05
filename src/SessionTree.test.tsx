import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmAction } from "./lib/confirm";
import { gitChanges, gitRepo } from "./lib/git";
import { listProjects } from "./lib/projects";
import { killSession, listClaudeSessions, listPastSessions, listSessions, roerStatus, type SessionInfo } from "./lib/pty";
import { useSessionBrowser } from "./lib/useSessionBrowser";
import { listWorkspaces } from "./lib/workspaces";
import {
  deleteWorktreeBranch,
  listWorktrees,
  removeWorktree,
  uncommittedInWorktree,
  type Worktree,
} from "./lib/worktrees";
import type { OpenRequest } from "./SessionBrowser";
import { buildTree } from "./lib/checkouts";
import { byLiveRank, SessionTree } from "./SessionTree";

vi.mock("./lib/pty", () => ({
  killSession: vi.fn(),
  listSessions: vi.fn(),
  listPastSessions: vi.fn(),
  listClaudeSessions: vi.fn(),
  roerStatus: vi.fn(),
}));
vi.mock("./lib/confirm", () => ({ confirmAction: vi.fn() }));
vi.mock("./lib/git", () => ({ gitRepo: vi.fn(), gitChanges: vi.fn() }));
vi.mock("./lib/notify", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("./lib/workspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  workspaceAssignments: vi.fn(async () => ({})),
  assignSession: vi.fn(),
  unassignSession: vi.fn(),
}));
vi.mock("./lib/projects", () => ({ listProjects: vi.fn(async () => []) }));
vi.mock("./lib/worktrees", () => ({
  listWorktrees: vi.fn(async () => []),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  uncommittedInWorktree: vi.fn(async () => []),
  deleteWorktreeBranch: vi.fn(),
}));

const project = { id: "p1", name: "roer", path: "/work/roer" };
const main: Worktree = { path: "/work/roer", branch: "main", commit: "abc1234", main: true, base: null, locked: false, missing: false };
const linked: Worktree = {
  path: "/Users/test/.roer/worktrees/roer/fix-login",
  branch: "fix-login",
  commit: "def5678",
  main: false,
  base: "origin/main",
  locked: false,
  missing: false,
};
const session = (pane: string, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: pane,
  session: `s${pane}`,
  pane,
  attached: false,
  cwd,
  command: "zsh",
  ...extra,
});

describe("sorting sessions into checkouts", () => {
  it("puts each session under the checkout that holds it most closely", () => {
    // The worktree's folder is not under the main checkout here, but even
    // where it is, the nearer checkout wins.
    const nested: Worktree = { ...linked, path: "/work/roer/.wt/nested" };
    const tree = buildTree(
      [project],
      { [project.path]: [main, linked, nested] },
      {},
      [session("%1", "/work/roer/src"), session("%2", `${linked.path}/app`), session("%3", "/work/roer/.wt/nested")],
      (s) => s.cwd, byLiveRank(new Set()),
    );
    const panes = tree.projects[0].checkouts.map((checkout) => checkout.items.map((s) => s.pane));
    expect(panes).toEqual([["%1"], ["%2"], ["%3"]]);
    expect(tree.elsewhere).toEqual([]);
  });

  it("keeps what no checkout holds apart, and a Project git has not listed as its own folder", () => {
    const tree = buildTree([project], {}, {}, [session("%1", "/work/roer"), session("%2", "/tmp")], (s) => s.cwd, byLiveRank(new Set()));
    expect(tree.projects[0].checkouts.map((checkout) => checkout.worktree.path)).toEqual(["/work/roer"]);
    expect(tree.projects[0].checkouts[0].items.map((s) => s.pane)).toEqual(["%1"]);
    expect(tree.elsewhere.map((s) => s.pane)).toEqual(["%2"]);
  });

  it("lists what waits on you first", () => {
    const tree = buildTree(
      [project],
      { [project.path]: [main] },
      {},
      [session("%1", "/work/roer"), session("%2", "/work/roer", { state: "waiting" })],
      (s) => s.cwd, byLiveRank(new Set(["%2"])),
    );
    expect(tree.projects[0].checkouts[0].items.map((s) => s.pane)).toEqual(["%2", "%1"]);
  });

  it("keeps two Projects of one repository to their own checkouts, and leaves out missing ones", () => {
    const ux = { id: "p2", name: "roer-ux", path: "/work/roer-ux" };
    const uxCheckout: Worktree = { ...linked, path: "/work/roer-ux", branch: "ux" };
    const gone: Worktree = { ...linked, path: "/Volumes/usb/roer-old", branch: "old", missing: true };
    const listed = [main, uxCheckout, linked, gone];
    const tree = buildTree(
      [project, ux],
      { [project.path]: listed, [ux.path]: listed },
      {},
      [session("%1", "/work/roer-ux/src")],
      (s) => s.cwd,
      byLiveRank(new Set()),
    );
    expect(tree.projects[0].checkouts.map((c) => c.worktree.branch)).toEqual(["main", "fix-login"]);
    expect(tree.projects[1].checkouts.map((c) => c.worktree.branch)).toEqual(["ux"]);
    expect(tree.projects[1].checkouts[0].items.map((s) => s.pane)).toEqual(["%1"]);
  });

  it("goes by the worktrees the repository was found with until git's list is read", () => {
    const repo = { root: "/work/roer", main: "/work/roer", worktrees: ["/work/roer", "/work/roer-ux"] };
    const tree = buildTree([project], {}, { [project.path]: repo }, [session("%1", "/work/roer-ux/src")], (s) => s.cwd, byLiveRank(new Set()));
    expect(tree.projects[0].checkouts.map((checkout) => checkout.items.length)).toEqual([0, 1]);
    expect(tree.elsewhere).toEqual([]);
  });
});

function Harness({ onOpen }: { onOpen: (request: OpenRequest) => void }) {
  const browser = useSessionBrowser({ token: "none", onOpen });
  return (
    <SessionTree
      status={browser.status}
      workspaces={browser.workspaces}
      assignments={browser.assignments}
      handleAssign={browser.handleAssign}
      handleEndSession={browser.handleEndSession}
      waiting={browser.waiting}
      repos={browser.repos}
      stats={browser.stats}
      visibleSessions={browser.visibleSessions}
      activePane={browser.activePane}
      worktrees={browser.worktrees}
      openNewWorktree={browser.openNewWorktree}
      openInWorktree={browser.openInWorktree}
      openPickAgent={browser.openPickAgent}
      handleRemoveWorktree={browser.handleRemoveWorktree}
      projects={browser.projectsInView}
      onOpen={onOpen}
    />
  );
}

describe("the session tree", () => {
  beforeEach(() => {
    vi.mocked(listSessions).mockReset().mockResolvedValue([]);
    vi.mocked(listPastSessions).mockReset().mockResolvedValue([]);
    vi.mocked(listClaudeSessions).mockReset().mockResolvedValue([]);
    vi.mocked(gitRepo).mockReset().mockResolvedValue(null);
    vi.mocked(gitChanges).mockReset().mockRejectedValue(new Error("not a repository"));
    vi.mocked(roerStatus).mockReset().mockResolvedValue({ bin: "roer", available: true, home: "/Users/test" });
    vi.mocked(listWorkspaces).mockReset().mockResolvedValue([{ id: "w1", name: "Roer", projects: ["p1"], items: [] }]);
    vi.mocked(listProjects).mockReset().mockResolvedValue([project]);
    vi.mocked(listWorktrees).mockReset().mockResolvedValue([main, linked]);
  });

  it("shows each checkout, opens a session in place, and starts a new one in a worktree", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      session("%3", `${linked.path}/src`, { command: "claude", title: "✳ Login fix", state: "waiting" }),
    ]);
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);

    const tree = within(await screen.findByRole("region", { name: "Running sessions" }));
    expect(await tree.findByText("main")).toBeInTheDocument();
    const row = await tree.findByTitle(/^s%3 /);
    expect(row).toHaveTextContent("Login fix");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ args: ["attach", "%3"], pane: "%3" }));

    fireEvent.click(tree.getByRole("button", { name: "Start a session in fix-login" }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ args: ["new"], cwd: linked.path }));
    // The main checkout is the Project itself: nothing to remove.
    expect(tree.queryByRole("button", { name: "Remove the worktree main" })).not.toBeInTheDocument();
  });

  it("folds a branch and a project, saying how much is hidden and that one waits", async () => {
    localStorage.removeItem("roer:folded-tree");
    vi.mocked(listSessions).mockResolvedValue([
      session("%3", `${linked.path}/src`, { command: "claude", state: "waiting" }),
      session("%4", linked.path),
    ]);
    render(<Harness onOpen={vi.fn()} />);

    const tree = within(await screen.findByRole("region", { name: "Running sessions" }));
    await tree.findByTitle(/^s%3 /);
    // A branch with nothing in it has nothing to fold.
    expect(tree.queryByRole("button", { name: "main" })).not.toBeInTheDocument();

    fireEvent.click(tree.getByRole("button", { name: "fix-login" }));
    expect(tree.queryByTitle(/^s%3 /)).not.toBeInTheDocument();
    expect(tree.getByTitle("2 hidden")).toHaveTextContent("2");

    fireEvent.click(tree.getByRole("button", { name: "roer" }));
    expect(tree.queryByText("fix-login")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("roer:folded-tree") ?? "[]")).toEqual([
      `checkout-${linked.path}`,
      "project-p1",
    ]);
    localStorage.removeItem("roer:folded-tree");
  });

  it("names a checkout by the branch it has switched to, without the stage changing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(listSessions).mockResolvedValue([session("%1", "/work/roer")]);
      render(<Harness onOpen={vi.fn()} />);
      const tree = within(await screen.findByRole("region", { name: "Running sessions" }));
      expect(await tree.findByRole("button", { name: "main" })).toBeInTheDocument();

      // `git switch -c test` in a terminal.
      vi.mocked(listWorktrees).mockResolvedValue([{ ...main, branch: "test" }, linked]);
      for (let poll = 0; poll < 10; poll += 1) await vi.advanceTimersByTimeAsync(3000);

      expect(await tree.findByRole("button", { name: "test" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks once about everything removal loses, ends its sessions only then, and asks about commits", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("%3", `${linked.path}/src`, { command: "claude" })]);
    vi.mocked(uncommittedInWorktree).mockReset().mockResolvedValue(["notes.md"]);
    vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
    vi.mocked(killSession).mockReset().mockResolvedValue(undefined);
    vi.mocked(removeWorktree)
      .mockReset()
      .mockResolvedValue({ kind: "removed", deletedBranch: null, unmergedBranch: "fix-login" });
    vi.mocked(deleteWorktreeBranch).mockReset().mockResolvedValue(undefined);
    render(<Harness onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove the worktree fix-login" }));
    await waitFor(() => expect(deleteWorktreeBranch).toHaveBeenCalledWith("/work/roer", "fix-login"));
    const asked = vi.mocked(confirmAction).mock.calls.map(([message]) => message);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/notes\.md/);
    expect(asked[0]).toMatch(/The session running in it ends/);
    expect(asked[1]).toMatch(/commits no other branch has/);
    expect(killSession).toHaveBeenCalledWith("%3");
    expect(removeWorktree).toHaveBeenCalledWith(linked.path, true);
  });

  it("asks again about work written after the question, and leaves it when told to", async () => {
    vi.mocked(uncommittedInWorktree).mockReset().mockResolvedValue([]);
    vi.mocked(confirmAction).mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(removeWorktree).mockReset().mockResolvedValue({ kind: "dirty", files: ["late.md"] });
    render(<Harness onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove the worktree fix-login" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(2));
    expect(vi.mocked(confirmAction).mock.calls[1][0]).toMatch(/late\.md/);
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith(linked.path, false);
  });

  it("removes nothing when the first question is declined", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("%3", `${linked.path}/src`, { command: "claude" })]);
    vi.mocked(confirmAction).mockReset().mockResolvedValue(false);
    vi.mocked(removeWorktree).mockReset();
    vi.mocked(killSession).mockReset();
    render(<Harness onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove the worktree fix-login" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(removeWorktree).not.toHaveBeenCalled();
    // Its agent is left running.
    expect(killSession).not.toHaveBeenCalled();
  });
});

function NewSessionHarness({ onOpen, activePane }: { onOpen: (request: OpenRequest) => void; activePane?: string }) {
  const browser = useSessionBrowser({ token: "none", onOpen, activePane });
  return (
    <>
      <span data-testid="place">{browser.newSessionPlace()}</span>
      <button type="button" onClick={() => browser.openNew()}>
        New session
      </button>
    </>
  );
}

describe("a plain New session", () => {
  const site = { id: "p2", name: "site", path: "/work/site" };

  beforeEach(() => {
    localStorage.removeItem("roer:last-new-session-project");
    vi.mocked(listSessions).mockReset().mockResolvedValue([]);
    vi.mocked(listPastSessions).mockReset().mockResolvedValue([]);
    vi.mocked(listClaudeSessions).mockReset().mockResolvedValue([]);
    vi.mocked(gitRepo).mockReset().mockResolvedValue(null);
    vi.mocked(gitChanges).mockReset().mockRejectedValue(new Error("not a repository"));
    vi.mocked(roerStatus).mockReset().mockResolvedValue({ bin: "roer", available: true, home: "/Users/test" });
    vi.mocked(listWorkspaces).mockReset().mockResolvedValue([{ id: "w1", name: "Roer", projects: ["p1", "p2"], items: [] }]);
    vi.mocked(listProjects).mockReset().mockResolvedValue([project, site]);
    vi.mocked(listWorktrees).mockReset().mockImplementation(async (cwd: string) => (cwd === "/work/site" ? [] : [main, linked]));
  });

  it("starts beside the session on the stage, never asking which Project", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("%3", `${linked.path}/src`, { command: "claude" })]);
    const repo = { main: "/work/roer", worktrees: ["/work/roer", linked.path] };
    vi.mocked(gitRepo).mockImplementation(async (cwd: string) =>
      cwd.startsWith(linked.path)
        ? { ...repo, root: linked.path }
        : cwd.startsWith("/work/roer")
          ? { ...repo, root: "/work/roer" }
          : null,
    );
    const onOpen = vi.fn();
    render(<NewSessionHarness onOpen={onOpen} activePane="%3" />);

    await waitFor(() => expect(screen.getByTestId("place")).toHaveTextContent("roer · fix-login"));
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ args: ["new"], cwd: linked.path }));
  });

  it("with nothing on the stage, starts in the Project started in last", async () => {
    localStorage.setItem("roer:last-new-session-project", "/work/site");
    const onOpen = vi.fn();
    render(<NewSessionHarness onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByTestId("place")).toHaveTextContent("site"));
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/site" }));
    localStorage.removeItem("roer:last-new-session-project");
  });
});

