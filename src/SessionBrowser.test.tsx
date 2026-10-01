import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitRoot } from "./lib/git";
import { listClaudeSessions, listPastSessions, listSessions, roerStatus, type SessionInfo } from "./lib/pty";
import { useSessionBrowser } from "./lib/useSessionBrowser";
import { listProjects } from "./lib/projects";
import { assignSession, listWorkspaces, unassignSession, workspaceAssignments } from "./lib/workspaces";
import { NewSessionButton } from "./NewSessionButton";
import { isWorking, paneLabel, runningAgent, SessionBrowser, type OpenRequest } from "./SessionBrowser";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

vi.mock("./lib/pty", () => ({
  listSessions: vi.fn(),
  listPastSessions: vi.fn(),
  listClaudeSessions: vi.fn(),
  roerStatus: vi.fn(),
}));

vi.mock("./lib/git", () => ({
  gitRoot: vi.fn(),
}));

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
  vi.mocked(gitRoot).mockReset().mockResolvedValue(null);
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
        waiting={browser.waiting}
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

function renderList(onOpen: (request: OpenRequest) => void = vi.fn()) {
  return render(<Harness onOpen={onOpen} />);
}

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
    vi.mocked(gitRoot).mockImplementation(async (cwd: string) =>
      cwd === "/work/one" ? "/work/one" : "/work/two",
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
    vi.mocked(gitRoot).mockResolvedValue("/work/one");
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
    vi.mocked(gitRoot).mockImplementation(async (cwd: string) => cwd);
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
    expect(isWorking("\u2802 fixing tests")).toBe(true);
    expect(isWorking("\u2733 fixing tests")).toBe(false);
    expect(isWorking("fixing tests")).toBe(false);
    expect(isWorking(undefined)).toBe(false);
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
    fireEvent.click(screen.getByText("Unassign"));

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
