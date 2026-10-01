import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitChanges, gitRepo } from "./lib/git";
import { notify } from "./lib/notify";
import {
  killSession,
  listClaudeSessions,
  listPastSessions,
  listSessions,
  roerStatus,
  type SessionInfo,
} from "./lib/pty";
import { useSessionBrowser } from "./lib/useSessionBrowser";
import { listProjects } from "./lib/projects";
import { confirmAction } from "./lib/confirm";
import {
  assignSession,
  deleteWorkspace,
  listWorkspaces,
  unassignSession,
  workspaceAssignments,
} from "./lib/workspaces";
import { NewSessionButton } from "./NewSessionButton";
import { checkoutLabel, isWorking, paneLabel, runningAgent, SessionBrowser, type OpenRequest } from "./SessionBrowser";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

vi.mock("./lib/pty", () => ({
  killSession: vi.fn(),
  listSessions: vi.fn(),
  listPastSessions: vi.fn(),
  listClaudeSessions: vi.fn(),
  roerStatus: vi.fn(),
}));

vi.mock("./lib/confirm", () => ({ confirmAction: vi.fn() }));

vi.mock("./lib/git", () => ({
  gitRepo: vi.fn(),
  gitChanges: vi.fn(),
}));

vi.mock("./lib/notify", () => ({ notify: vi.fn(async () => undefined) }));

vi.mock("./lib/workspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  attachProject: vi.fn(),
  detachProject: vi.fn(),
  addWorkspaceItem: vi.fn(),
  removeWorkspaceItem: vi.fn(),
  workspaceAssignments: vi.fn(async () => ({})),
  assignSession: vi.fn(),
  unassignSession: vi.fn(),
}));

vi.mock("./lib/projects", () => ({
  listProjects: vi.fn(async () => []),
  createProject: vi.fn(),
  renameProject: vi.fn(),
  deleteProject: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
  vi.mocked(listPastSessions).mockReset().mockResolvedValue([]);
  vi.mocked(listClaudeSessions).mockReset().mockResolvedValue([]);
  vi.mocked(gitRepo).mockReset().mockResolvedValue(null);
  vi.mocked(listWorkspaces).mockReset().mockResolvedValue([]);
  vi.mocked(listProjects).mockReset().mockResolvedValue([]);
  vi.mocked(gitChanges).mockReset().mockRejectedValue(new Error("not a repository"));
  vi.mocked(notify).mockClear();
  vi.mocked(roerStatus)
    .mockReset()
    .mockResolvedValue({ bin: "roer", available: true, home: "/Users/test" });
});

/**
 * The sidebar and the browser split one hook's state across two places on
 * screen — same shape as `App.tsx`, just without the stage around it.
 */
function Harness({ onOpen }: { onOpen: (request: OpenRequest) => void }) {
  const browser = useSessionBrowser({ token: "none", onOpen });
  return (
    <>
      <WorkspaceSidebar
        collapsed={false}
        status={browser.status}
        failure={browser.failure}
        workspaces={browser.workspaces}
        projects={browser.projects}
        selectedWorkspaceId={browser.selectedWorkspaceId}
        setSelectedWorkspaceId={browser.setSelectedWorkspaceId}
        selectedProjectId={browser.selectedProjectId}
        setSelectedProjectId={browser.setSelectedProjectId}
        handleCreateWorkspace={browser.handleCreateWorkspace}
        handleRenameWorkspace={browser.handleRenameWorkspace}
        handleDeleteWorkspace={browser.handleDeleteWorkspace}
        handleCreateProject={browser.handleCreateProject}
        handleRenameProject={browser.handleRenameProject}
        handleDeleteProject={browser.handleDeleteProject}
      />
      <NewSessionButton
        projects={browser.projects}
        openNew={browser.openNew}
        pickingProjectFor={browser.pickingProjectFor}
        cancelProjectPick={browser.cancelProjectPick}
        pickProjectForNewSession={browser.pickProjectForNewSession}
        attachNewProjectForNewSession={browser.attachNewProjectForNewSession}
      />
      <SessionBrowser
        status={browser.status}
        workspaces={browser.workspaces}
        projects={browser.projects}
        assignments={browser.assignments}
        selectedWorkspace={browser.selectedWorkspace}
        selectedWorkspaceProjects={browser.selectedWorkspaceProjects}
        handleAssign={browser.handleAssign}
        handleAttachExistingProject={browser.handleAttachExistingProject}
        handleAttachNewProject={browser.handleAttachNewProject}
        handleDetachProject={browser.handleDetachProject}
        addingItem={browser.addingItem}
        setAddingItem={browser.setAddingItem}
        itemTitle={browser.itemTitle}
        setItemTitle={browser.setItemTitle}
        handleAddItem={browser.handleAddItem}
        handleRemoveItem={browser.handleRemoveItem}
        roots={browser.roots}
        repos={browser.repos}
        waiting={browser.waiting}
        stats={browser.stats}
        handleEndSession={browser.handleEndSession}
        visibleSessions={browser.visibleSessions}
        visibleClaudeSessions={browser.visibleClaudeSessions}
        activePane={browser.activePane}
        openClaudeSession={browser.openClaudeSession}
        refresh={browser.refresh}
        onOpen={onOpen}
      />
    </>
  );
}

/** A plain checkout: its own root, the repository's only worktree. */
const repoAt = (root: string) => ({ root, main: root, worktrees: [root] });

function renderList(onOpen: (request: OpenRequest) => void = vi.fn()) {
  return render(<Harness onOpen={onOpen} />);
}

describe("a resumed conversation", () => {
  it("is listed while its agent runs, and left to its conversation once it quits", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-resume-5", pane: "%0", attached: true, cwd: "/Users/test/project", command: "claude", title: "\u2733 UX review" },
      { id: "2", session: "roer-resume-6", pane: "%1", attached: false, cwd: "/Users/test/project", command: "zsh" },
    ]);
    renderList();

    expect(await screen.findByTitle(/^roer-resume-5 /)).toHaveTextContent("UX review");
    expect(screen.queryByTitle(/^roer-resume-6 /)).not.toBeInTheDocument();
  });
});

describe("worktrees", () => {
  it("counts a session in another worktree as its Project's, and says which worktree", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { id: "w0", name: "Default", projects: [], items: [] },
      { id: "w1", name: "Roer", projects: ["p1"], items: [] },
    ]);
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", name: "roer", path: "/work/roer" }]);
    const repo = { main: "/work/roer", worktrees: ["/work/roer", "/work/roer-ux"] };
    vi.mocked(gitRepo).mockImplementation(async (cwd: string) =>
      cwd.startsWith("/work/roer-ux") ? { ...repo, root: "/work/roer-ux" } : cwd.startsWith("/work/roer") ? { ...repo, root: "/work/roer" } : null,
    );
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: false, cwd: "/work/roer", command: "zsh" },
      { id: "2", session: "roer-ux", pane: "%1", attached: false, cwd: "/work/roer-ux/src", command: "zsh" },
    ]);
    renderList();

    // Covered by Roer's Project, so not left to Default.
    await waitFor(() => expect(listClaudeSessions).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTitle(/^roer-ux /)).not.toBeInTheDocument());
    fireEvent.click(await screen.findByRole("button", { name: /^Roer/ }));

    const linked = await screen.findByTitle(/^roer-ux /);
    await waitFor(() => expect(linked).toHaveTextContent("roer-ux"));
    expect(screen.getByTitle(/^roer-a /)).not.toHaveTextContent("roer-ux");
    // One repository, so one group: no headings.
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    // Conversations are looked for in every worktree.
    await waitFor(() =>
      expect(vi.mocked(listClaudeSessions).mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining(["/work/roer-ux"])),
    );
  });
});

describe("what a row names its checkout by", () => {
  const stats = (branch: string, commit: string) => ({ branch, commit, files: 0, added: 0, deleted: 0 });

  it("goes by the branch, which it reads again when the session switches", () => {
    expect(checkoutLabel(stats("ux-polishing", "ab3d7d1"), "roer-ux")?.text).toBe("ux-polishing");
    expect(checkoutLabel(stats("main", "ab3d7d1"), null)?.text).toBe("main");
  });

  it("names a detached checkout by its commit, never as detached", () => {
    const label = checkoutLabel(stats("(detached)", "27e3ed0"), "roer-pr36");
    expect(label?.text).toBe("27e3ed0");
    expect(label?.title).toContain("roer-pr36");
  });

  it("falls back to the worktree's folder, and to nothing outside a repository", () => {
    expect(checkoutLabel(undefined, "roer-ux")?.text).toBe("roer-ux");
    expect(checkoutLabel(stats("(detached)", ""), null)).toBeNull();
    expect(checkoutLabel(undefined, null)).toBeNull();
  });
});

describe("past Claude conversations", () => {
  it("renders resumable conversations alongside live sessions", async () => {
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/project",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      {
        id: "abc-123",
        cwd: "/Users/test/project",
        title: "fix the flaky test",
        updatedAt: Math.floor(Date.now() / 1000) - 120,
      },
    ]);
    renderList();

    const row = await screen.findByRole("button", { name: /fix the flaky test/i });
    expect(row).toHaveTextContent("ago");
  });

  it("resumes via the shim's resume command in the conversation's old directory", async () => {
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/project",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      {
        id: "abc-123",
        cwd: "/Users/test/project",
        title: "fix the flaky test",
        updatedAt: Math.floor(Date.now() / 1000),
      },
    ]);
    const onOpen = vi.fn();
    renderList(onOpen);

    fireEvent.click(await screen.findByRole("button", { name: /fix the flaky test/i }));

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["resume", "abc-123"],
        cwd: "/Users/test/project",
        title: "fix the flaky test",
      }),
    );
  });

  it("scopes the Claude lookup to the union of live and past-history cwds", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer-a",
        pane: "%0",
        attached: true,
        cwd: "/Users/test/live",
        command: "claude",
      },
    ]);
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/ended",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    renderList();

    await screen.findByRole("navigation", { name: /sessions/i });
    expect(listClaudeSessions).toHaveBeenCalledWith(["/Users/test/live", "/Users/test/ended"]);
  });

});

describe("grouping by git root", () => {
  it("groups sessions from different repositories under their own heading", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/work/one", command: "zsh" },
      { id: "2", session: "roer-b", pane: "%1", attached: true, cwd: "/work/two", command: "zsh" },
    ]);
    vi.mocked(gitRepo).mockImplementation(async (cwd: string) =>
      repoAt(cwd === "/work/one" ? "/work/one" : "/work/two"),
    );
    renderList();

    const groups = await screen.findAllByRole("heading", { level: 3 });
    expect(groups.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("one"), expect.stringContaining("two")]),
    );
  });

  it("shows no group heading when everything shares one root", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/work/one", command: "zsh" },
      {
        id: "2",
        session: "roer-b",
        pane: "%1",
        attached: true,
        cwd: "/work/one/sub",
        command: "zsh",
      },
    ]);
    vi.mocked(gitRepo).mockResolvedValue(repoAt("/work/one"));
    renderList();

    await screen.findByTitle(/^roer-a /);
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });
});

describe("naming a session", () => {
  it("leads with the task the agent has titled its pane", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer-daf2-3",
        pane: "%0",
        attached: true,
        cwd: "/Users/test/project",
        command: "claude",
        title: "\u2733 github-pr-tab-integration",
      },
    ]);
    renderList();

    const row = await screen.findByRole("button", { name: /^github-pr-tab-integrationclaude/ });
    // The session's own name says only which directory it is in: the
    // tooltip keeps it, the row does not.
    expect(row).not.toHaveTextContent("roer");
    expect(row).toHaveAttribute("title", expect.stringContaining("roer-daf2-3"));
  });

  it("falls back to the command, still without the session name", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer-daf2",
        pane: "%0",
        attached: true,
        cwd: "/Users/test/project",
        command: "zsh",
        title: "",
      },
    ]);
    renderList();

    const row = await screen.findByRole("button", { name: /^zsh/ });
    expect(row).not.toHaveTextContent("roer");
  });

  it("tells same-named repositories apart by their parent directory", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-daf2", pane: "%0", attached: true, cwd: "/work/roer", command: "zsh" },
      { id: "2", session: "roer-1b3c", pane: "%1", attached: true, cwd: "/trees/roer", command: "zsh" },
      { id: "3", session: "api-0a0a", pane: "%2", attached: true, cwd: "/work/api", command: "zsh" },
    ]);
    vi.mocked(gitRepo).mockImplementation(async (cwd: string) => repoAt(cwd));
    renderList();

    await waitFor(async () => {
      const groups = await screen.findAllByRole("heading", { level: 3 });
      expect(groups.map((h) => h.textContent)).toEqual(["work/roer", "trees/roer", "api"]);
    });
  });
});

describe("session labels", () => {
  it("drops spinner glyphs and titles that just repeat the command", () => {
    expect(paneLabel("\u2802 fixing tests", "claude")).toBe("fixing tests");
    expect(paneLabel("zsh", "zsh")).toBe("");
    expect(paneLabel(undefined, "zsh")).toBe("");
  });
});

describe("what the agent is doing", () => {
  const claude = (title: string): SessionInfo => ({
    id: "1",
    session: "roer-a",
    pane: "%0",
    attached: false,
    cwd: "/Users/test/project",
    command: "claude",
    title,
  });

  it("reads Claude Code's spinner as working and its ✳ as not", () => {
    expect(isWorking(claude("\u2802 fixing tests"))).toBe(true);
    expect(isWorking(claude("\u2733 fixing tests"))).toBe(false);
  });

  it("takes any other agent as working while it keeps printing, and nothing else", () => {
    const now = 1_790_000_000;
    const codex = { ...claude(""), command: "codex", activity: now - 2 };
    expect(isWorking(codex, now)).toBe(true);
    expect(isWorking({ ...codex, activity: now - 30 }, now)).toBe(false);
    expect(isWorking({ ...codex, activity: 0 }, now)).toBe(false);
    // A shell printing a build log is not an agent at work.
    expect(isWorking({ ...codex, command: "zsh" }, now)).toBe(false);
  });

  it("goes by what the agent's hooks said over anything its title shows", () => {
    expect(isWorking({ ...claude("\u2733 fixing tests"), state: "working" })).toBe(true);
    expect(isWorking({ ...claude("\u2802 fixing tests"), state: "done" })).toBe(false);
    expect(isWorking({ ...claude("\u2802 fixing tests"), state: "waiting" })).toBe(false);
  });

  it("takes a hooked turn that has gone quiet for a stop, as Esc leaves it", () => {
    const now = 1_790_000_000;
    const working: SessionInfo = { ...claude("\u2802 fixing tests"), state: "working", activity: now - 10 };
    expect(isWorking(working, now)).toBe(true);
    // Esc ends the turn without a Stop hook: `working` stays, the output stops.
    expect(isWorking({ ...working, activity: now - 31 }, now)).toBe(false);
    // An older shim reports no activity; the hook is all there is.
    expect(isWorking({ ...working, activity: undefined }, now)).toBe(true);
  });

  it("says a session is held up on you, in Claude's words, once its hooks say so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(listSessions).mockResolvedValue([{ ...claude("\u2802 fixing tests"), state: "working" }]);
      renderList();
      await screen.findByText("working");

      vi.mocked(listSessions).mockResolvedValue([
        { ...claude("\u2733 fixing tests"), state: "waiting", note: "Claude needs your permission to use Bash" },
      ]);
      await vi.advanceTimersByTimeAsync(3000);

      const badge = await screen.findByText("needs you");
      expect(badge).toHaveAttribute("title", "Claude needs your permission to use Bash");
      expect(notify).toHaveBeenCalledWith(
        "fixing tests",
        expect.stringContaining("Claude needs your permission to use Bash"),
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a session that rang the bell out of sight as waiting", async () => {
    vi.mocked(listSessions).mockResolvedValue([{ ...claude(""), command: "codex", bell: true }]);
    renderList();

    const row = await screen.findByTitle(/^roer-a /);
    await waitFor(() => expect(row).toHaveTextContent("waiting"));
    // Already so when Roer first looked: shown, but not news.
    expect(notify).not.toHaveBeenCalled();
  });

  it("lists what waits first, then what works, then the rest", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { ...claude("\u2733 idle one"), pane: "%0", session: "a" },
      { ...claude("\u2802 busy one"), pane: "%1", session: "b" },
      { ...claude("\u2733 rang one"), pane: "%2", session: "c", command: "codex", title: "", bell: true },
    ]);
    renderList();

    await waitFor(() => {
      const rows = [...document.querySelectorAll(".sessions-view button.row")].map((row) => row.getAttribute("title"));
      expect(rows.map((title) => title?.split(" ")[0])).toEqual(["c", "b", "a"]);
    });
  });

  it("shows the branch, what is uncommitted on it, and when it last printed", async () => {
    vi.mocked(gitChanges).mockResolvedValue({
      root: "/Users/test/project",
      branch: "fix-login",
      commit: "ab3d7d1",
      files: [
        { path: "a.ts", staged: ".", unstaged: "M", added: 10, deleted: 2, binary: false, counted: true },
        { path: "b.ts", staged: ".", unstaged: "M", added: 2, deleted: 1, binary: false, counted: true },
      ],
    });
    vi.mocked(listSessions).mockResolvedValue([
      { ...claude("\u2733 fix"), activity: Math.floor(Date.now() / 1000) - 300 },
    ]);
    renderList();

    const row = await screen.findByTitle(/^roer-a /);
    await waitFor(() => expect(row).toHaveTextContent("fix-login"));
    expect(row).toHaveTextContent("+12 −3");
    expect(row).toHaveTextContent("5m ago");
  });

  it("ends a session from its menu, once that is confirmed", async () => {
    vi.mocked(listSessions).mockResolvedValue([claude("\u2802 fixing tests")]);
    vi.mocked(killSession).mockReset().mockResolvedValue(undefined);
    vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
    renderList();

    fireEvent.contextMenu(await screen.findByTitle(/^roer-a /));
    fireEvent.click(await screen.findByText("End session…"));

    await waitFor(() => expect(killSession).toHaveBeenCalledWith("%0"));
    expect(vi.mocked(confirmAction).mock.calls[0][0]).toContain("An agent is still working in it.");
  });

  it("marks a working session, and calls one nobody holds detached", async () => {
    vi.mocked(listSessions).mockResolvedValue([claude("\u2802 fixing tests")]);
    renderList();

    const row = await screen.findByTitle(/^roer-a /);
    expect(row).toHaveTextContent("working");
    expect(row).toHaveTextContent("detached");
  });

  it("marks a session waiting once its agent stops out of sight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(listSessions).mockResolvedValue([claude("\u2802 fixing tests")]);
      renderList();
      await screen.findByText("working");

      vi.mocked(listSessions).mockResolvedValue([claude("\u2733 fixing tests")]);
      await vi.advanceTimersByTimeAsync(3000);

      const row = await screen.findByTitle(/^roer-a /);
      await waitFor(() => expect(row).toHaveTextContent("waiting"));
      expect(row).not.toHaveTextContent("working");
      // Named, so it says which session.
      expect(notify).toHaveBeenCalledWith("fixing tests", expect.stringContaining("claude is waiting"), expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it("never marks a session that was idle all along", async () => {
    vi.mocked(listSessions).mockResolvedValue([claude("\u2733 fixing tests")]);
    renderList();

    const row = await screen.findByTitle(/^roer-a /);
    expect(row).not.toHaveTextContent("waiting");
    expect(row).not.toHaveTextContent("working");
  });
});

describe("naming the agent", () => {
  it("names a running claude session the same way the terminal would", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer-a",
        pane: "%0",
        attached: true,
        cwd: "/Users/test/project",
        command: "claude",
      },
    ]);
    renderList();

    const row = await screen.findByTitle(/^roer-a /);
    expect(row).toHaveTextContent("claude");
  });

  it("names the agent on every row in the Resume list", async () => {
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/project",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      {
        id: "abc-123",
        cwd: "/Users/test/project",
        title: "fix the flaky test",
        updatedAt: Math.floor(Date.now() / 1000),
      },
    ]);
    renderList();

    const row = await screen.findByRole("button", { name: /fix the flaky test/i });
    expect(row).toHaveTextContent("claude");
  });
});

describe("the selected workspace", () => {
  it("asks before deleting a Workspace", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { id: "w1", name: "Default", projects: [], items: [] },
      { id: "w2", name: "Feature work", projects: [], items: [] },
    ]);
    vi.mocked(deleteWorkspace).mockReset().mockResolvedValue(undefined);
    vi.mocked(confirmAction).mockReset().mockResolvedValue(false);
    renderList();

    fireEvent.contextMenu(await screen.findByRole("button", { name: /Feature work/ }));
    fireEvent.click(await screen.findByText("Delete"));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(deleteWorkspace).not.toHaveBeenCalled();

    vi.mocked(confirmAction).mockResolvedValue(true);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Feature work/ }));
    fireEvent.click(await screen.findByText("Delete"));
    await waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith("w2"));
  });

  it("is the first one on launch, with no unfiltered All beside it", async () => {
    vi.mocked(listWorkspaces).mockResolvedValueOnce([
      { id: "w1", name: "Default", projects: [], items: [] },
      { id: "w2", name: "Feature work", projects: [], items: [] },
    ]);
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/Users/test/project", command: "zsh" },
    ]);
    renderList();

    expect(await screen.findByRole("button", { name: /Default/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "All" })).not.toBeInTheDocument();
    // Neither assigned to Default nor under a Project of its: not listed.
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /roer-a/i })).not.toBeInTheDocument();
  });

  it("offers no Delete for Default, only for the ones after it", async () => {
    vi.mocked(listWorkspaces).mockResolvedValueOnce([
      { id: "w1", name: "Default", projects: [], items: [] },
      { id: "w2", name: "Feature work", projects: [], items: [] },
    ]);
    renderList();

    fireEvent.contextMenu(await screen.findByRole("button", { name: /Default/ }));
    expect(await screen.findByText("Rename")).toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.contextMenu(screen.getByRole("button", { name: /Feature work/ }));
    expect(await screen.findByText("Delete")).toBeInTheDocument();
  });
});

describe("assigning a session to a workspace", () => {
  it("assigns a live session to a workspace via its right-click menu", async () => {
    // Listed because it is under the Workspace's Project, not yet assigned.
    vi.mocked(listProjects).mockResolvedValueOnce([{ id: "p1", path: "/Users/test/project", name: "project" }]);
    vi.mocked(listWorkspaces).mockResolvedValue([{ id: "w1", name: "Feature work", projects: ["p1"], items: [] }]);
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/Users/test/project", command: "zsh" },
    ]);
    vi.mocked(assignSession).mockResolvedValue(undefined);
    renderList();

    const row = await screen.findByTitle(/^roer-a /);
    fireEvent.contextMenu(row);

    fireEvent.click(await screen.findByText("Assign to Feature work"));

    expect(assignSession).toHaveBeenCalledWith("1", "w1");
  });

  it("unassigns a session that is already in a workspace", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([{ id: "w1", name: "Feature work", projects: [], items: [] }]);
    vi.mocked(workspaceAssignments).mockResolvedValue({ "1": "w1" });
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/Users/test/project", command: "zsh" },
    ]);
    vi.mocked(unassignSession).mockResolvedValue(undefined);
    renderList();

    const row = await screen.findByTitle(/^roer-a /);
    fireEvent.contextMenu(row);

    expect(await screen.findByText("Assign to Feature work")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByText("Remove from Feature work"));

    expect(unassignSession).toHaveBeenCalledWith("1");
  });
});

describe("runningAgent", () => {
  const live = (command: string, agent = "") =>
    ({ id: "i", session: "s", pane: "%1", attached: false, cwd: "/w", command, agent }) as SessionInfo;

  it("is only ever an agent, never a shell, an editor or a dev server", () => {
    expect(runningAgent(live("node", "Fast pi"))).toBe("Fast pi");
    expect(runningAgent(live("claude"))).toBe("claude");
    expect(runningAgent(live("zsh"))).toBeNull();
    expect(runningAgent(live("vim"))).toBeNull();
    expect(runningAgent(live("node"))).toBeNull();
  });
});
