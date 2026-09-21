import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitRoot } from "./lib/git";
import { listClaudeSessions, listPastSessions, listSessions, roerStatus } from "./lib/pty";
import { useSessionBrowser } from "./lib/useSessionBrowser";
import { assignSession, listWorkspaces, unassignSession, workspaceAssignments } from "./lib/workspaces";
import { NewSessionButton } from "./NewSessionButton";
import { SessionBrowser, type OpenRequest } from "./SessionBrowser";
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

    await screen.findByRole("button", { name: /roer-a/i });
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
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

    const row = await screen.findByRole("button", { name: /roer-a/i });
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

describe("assigning a session to a workspace", () => {
  it("assigns a live session to a workspace via its right-click menu", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([{ id: "w1", name: "Feature work", projects: [], items: [] }]);
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/Users/test/project", command: "zsh" },
    ]);
    vi.mocked(assignSession).mockResolvedValue(undefined);
    renderList();

    const row = await screen.findByRole("button", { name: /roer-a/i });
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

    const row = await screen.findByRole("button", { name: /roer-a/i });
    fireEvent.contextMenu(row);

    expect(await screen.findByText("Assign to Feature work")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByText("Unassign"));

    expect(unassignSession).toHaveBeenCalledWith("1");
  });
});
