import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listClaudeSessions, listPastSessions, listSessions, roerStatus } from "./pty";
import { createProject, deleteProject, listProjects, renameProject } from "./projects";
import {
  attachProject,
  createWorkspace,
  detachProject,
  listWorkspaces,
  renameWorkspace,
  workspaceAssignments,
  type Workspace,
} from "./workspaces";
import { useSessionBrowser } from "./useSessionBrowser";

vi.mock("./pty", () => ({
  listSessions: vi.fn(),
  listPastSessions: vi.fn(),
  listClaudeSessions: vi.fn(),
  roerStatus: vi.fn(),
}));

vi.mock("./git", () => ({
  gitRoot: vi.fn(async () => null),
}));

vi.mock("./workspaces", () => ({
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

vi.mock("./projects", () => ({
  listProjects: vi.fn(async () => []),
  createProject: vi.fn(),
  renameProject: vi.fn(),
  deleteProject: vi.fn(),
}));

const ask = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return { id: "w1", name: "one", projects: [], items: [], ...overrides };
}

beforeEach(() => {
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
  vi.mocked(listPastSessions).mockReset().mockResolvedValue([]);
  vi.mocked(listClaudeSessions).mockReset().mockResolvedValue([]);
  vi.mocked(roerStatus)
    .mockReset()
    .mockResolvedValue({ bin: "roer", available: true, home: "/Users/test" });
  vi.mocked(listWorkspaces).mockReset().mockResolvedValue([]);
  vi.mocked(workspaceAssignments).mockReset().mockResolvedValue({});
  vi.mocked(listProjects).mockReset().mockResolvedValue([]);
  vi.mocked(createWorkspace).mockReset();
  vi.mocked(renameWorkspace).mockReset();
  vi.mocked(attachProject).mockReset();
  vi.mocked(detachProject).mockReset();
  vi.mocked(createProject).mockReset();
  vi.mocked(renameProject).mockReset();
  vi.mocked(deleteProject).mockReset();
  ask.mockReset();
});

function setUp(initialWorkspaces: Workspace[]) {
  vi.mocked(listWorkspaces).mockResolvedValue(initialWorkspaces);
  return renderHook(() => useSessionBrowser({ token: "none", onOpen: vi.fn() }));
}

describe("attaching a project", () => {
  it("attaches an existing project to the selected workspace", async () => {
    const w = workspace();
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    vi.mocked(attachProject).mockResolvedValue({ ...w, projects: ["p1"] });
    const { result } = setUp([w]);

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => result.current.handleAttachExistingProject("p1"));

    expect(attachProject).toHaveBeenCalledWith("w1", "p1");
    expect(result.current.selectedWorkspace?.projects).toEqual(["p1"]);
  });

  it("registers a brand new project and attaches it in one step", async () => {
    const w = workspace();
    vi.mocked(createProject).mockResolvedValue({ id: "p2", path: "/tmp/two", name: "two" });
    vi.mocked(attachProject).mockResolvedValue({ ...w, projects: ["p2"] });
    const { result } = setUp([w]);

    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => result.current.handleAttachNewProject("/tmp/two"));

    expect(createProject).toHaveBeenCalledWith("two", "/tmp/two");
    expect(attachProject).toHaveBeenCalledWith("w1", "p2");
    expect(result.current.projects.map((p) => p.id)).toContain("p2");
  });
});

describe("detaching a project", () => {
  it("offers to delete a project once nothing else references it", async () => {
    const w = workspace({ projects: ["p1"] });
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    vi.mocked(detachProject).mockResolvedValue({ ...w, projects: [] });
    ask.mockResolvedValue(true);
    const { result } = setUp([w]);

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => {
      result.current.handleDetachProject("p1");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(detachProject).toHaveBeenCalledWith("w1", "p1");
    await waitFor(() => expect(ask).toHaveBeenCalled());
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(result.current.projects).toHaveLength(0));
  });

  it("does not prompt to delete a project still attached elsewhere", async () => {
    const one = workspace({ id: "w1", name: "one", projects: ["p1"] });
    const two = workspace({ id: "w2", name: "two", projects: ["p1"] });
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    vi.mocked(detachProject).mockResolvedValue({ ...one, projects: [] });
    const { result } = setUp([one, two]);

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => {
      result.current.handleDetachProject("p1");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ask).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
  });
});

describe("renaming", () => {
  it("renames a workspace", async () => {
    const w = workspace();
    vi.mocked(renameWorkspace).mockResolvedValue({ ...w, name: "renamed" });
    const { result } = setUp([w]);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));

    await act(async () => result.current.handleRenameWorkspace("w1", "renamed"));

    expect(result.current.workspaces[0].name).toBe("renamed");
  });

  it("renames a project", async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    vi.mocked(renameProject).mockResolvedValue({ id: "p1", path: "/tmp/one", name: "renamed" });
    const { result } = setUp([]);
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    await act(async () => result.current.handleRenameProject("p1", "renamed"));

    expect(result.current.projects[0].name).toBe("renamed");
  });
});

describe("new session cwd", () => {
  it("starts a new session in the selected Project's directory", async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    const onOpen = vi.fn();
    const { result } = renderHook(() => useSessionBrowser({ token: "none", onOpen }));
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => result.current.setSelectedProjectId("p1"));
    act(() => result.current.openNew());

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["new"], cwd: "/tmp/one" }),
    );
  });
});

describe("filtering by project", () => {
  it("shows only sessions under the selected project's path", async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/tmp/one/sub", command: "zsh" },
      { id: "2", session: "roer-b", pane: "%1", attached: true, cwd: "/tmp/two", command: "zsh" },
    ]);
    const { result } = setUp([]);
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => result.current.setSelectedProjectId("p1"));

    await waitFor(() => expect(result.current.visibleSessions).toHaveLength(1));
    expect(result.current.visibleSessions[0].session).toBe("roer-a");
  });

  it("selecting a project clears any selected workspace, and vice versa", async () => {
    const w = workspace();
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    const { result } = setUp([w]);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));

    act(() => result.current.setSelectedWorkspaceId("w1"));
    expect(result.current.selectedProjectId).toBeNull();

    act(() => result.current.setSelectedProjectId("p1"));
    expect(result.current.selectedWorkspaceId).toBeNull();
  });

  it("selecting All clears a project filter left over from before", async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    const { result } = setUp([]);
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => result.current.setSelectedProjectId("p1"));
    expect(result.current.selectedProjectId).toBe("p1");

    act(() => result.current.setSelectedWorkspaceId(null));
    expect(result.current.selectedProjectId).toBeNull();
  });

  it("shows a Workspace's sessions and conversations from its attached Project's path, unassigned", async () => {
    const w = workspace({ projects: ["p1"] });
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/tmp/one/sub", command: "zsh" },
      { id: "2", session: "roer-b", pane: "%1", attached: true, cwd: "/tmp/two", command: "zsh" },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      { id: "c1", cwd: "/tmp/one/sub", title: "under the project", updatedAt: 1 },
      { id: "c2", cwd: "/tmp/two", title: "elsewhere", updatedAt: 1 },
    ]);
    const { result } = setUp([workspace({ id: "w0", name: "Default" }), w]);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));

    act(() => result.current.setSelectedWorkspaceId("w1"));

    await waitFor(() => expect(result.current.visibleSessions).toHaveLength(1));
    expect(result.current.visibleSessions[0].session).toBe("roer-a");
    await waitFor(() => expect(result.current.visibleClaudeSessions).toHaveLength(1));
    expect(result.current.visibleClaudeSessions[0].title).toBe("under the project");
  });

  it("lists under Default, the first Workspace, whatever no Workspace covers", async () => {
    const byDefault = workspace({ id: "w0", name: "Default" });
    const other = workspace({ projects: ["p1"] });
    vi.mocked(listProjects).mockResolvedValue([{ id: "p1", path: "/tmp/one", name: "one" }]);
    vi.mocked(workspaceAssignments).mockResolvedValue({ "3": "w1" });
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/tmp/one/sub", command: "zsh" },
      { id: "2", session: "roer-b", pane: "%1", attached: true, cwd: "/tmp/two", command: "zsh" },
      { id: "3", session: "roer-c", pane: "%2", attached: true, cwd: "/tmp/three", command: "zsh" },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      { id: "c1", cwd: "/tmp/one/sub", title: "under the project", updatedAt: 1 },
      { id: "c2", cwd: "/tmp/two", title: "elsewhere", updatedAt: 1 },
    ]);
    const { result } = setUp([byDefault, other]);
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    await waitFor(() => expect(result.current.assignments).toEqual({ "3": "w1" }));

    act(() => result.current.setSelectedWorkspaceId("w0"));

    await waitFor(() => expect(result.current.visibleSessions.map((s) => s.session)).toEqual(["roer-b"]));
    expect(result.current.visibleClaudeSessions.map((s) => s.title)).toEqual(["elsewhere"]);

    act(() => result.current.setSelectedWorkspaceId("w1"));

    await waitFor(() =>
      expect(result.current.visibleSessions.map((s) => s.session)).toEqual(["roer-a", "roer-c"]),
    );
  });
});
