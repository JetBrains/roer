import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitCheckedOut, gitReposIn, gitRoot } from "./git";
import { killSession, listClaudeSessions, listPastSessions, listSessions, roerStatus, type SessionInfo } from "./pty";
import { createProject, deleteProject, listProjects, renameProject } from "./projects";
import {
  attachProject,
  createWorkspace,
  detachProject,
  listWorkspaces,
  renameWorkspace,
  setWorkspaceFolder,
  workspaceAssignments,
  type Workspace,
} from "./workspaces";
import { useSessionBrowser } from "./useSessionBrowser";

vi.mock("./pty", () => ({
  listSessions: vi.fn(),
  listPastSessions: vi.fn(),
  listClaudeSessions: vi.fn(),
  roerStatus: vi.fn(),
  killSession: vi.fn(async () => undefined),
}));

vi.mock("./git", () => ({
  gitRoot: vi.fn(async () => null),
  gitCheckedOut: vi.fn(async () => false),
  gitReposIn: vi.fn(async () => []),
}));

vi.mock("./workspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  setWorkspaceFolder: vi.fn(),
  deleteWorkspace: vi.fn(),
  attachProject: vi.fn(),
  detachProject: vi.fn(),
  workspaceAssignments: vi.fn(async () => ({})),
  assignSession: vi.fn(async () => undefined),
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
// A browser tab asks as a desktop app does, through the same question.
vi.mock("./confirm", () => ({ confirmAction: ask }));

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return { id: "w1", name: "one", projects: [], ...overrides };
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
  vi.mocked(setWorkspaceFolder).mockReset().mockImplementation(async (id, folder) => workspace({ id, name: "work", folder: folder ?? undefined }));
  vi.mocked(renameWorkspace).mockReset();
  vi.mocked(attachProject).mockReset();
  vi.mocked(detachProject).mockReset();
  vi.mocked(createProject).mockReset();
  vi.mocked(renameProject).mockReset();
  vi.mocked(deleteProject).mockReset();
  vi.mocked(gitRoot).mockReset().mockResolvedValue(null);
  vi.mocked(gitCheckedOut).mockReset().mockResolvedValue(false);
  vi.mocked(gitReposIn).mockReset().mockResolvedValue([]);
  ask.mockReset();
});

function setUp(initialWorkspaces: Workspace[], onOpen = vi.fn()) {
  vi.mocked(listWorkspaces).mockResolvedValue(initialWorkspaces);
  return renderHook(() => useSessionBrowser({ token: "none", onOpen }));
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
    vi.mocked(gitRoot).mockResolvedValue("/tmp/two");
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

  it("asks about a folder of repositories, and makes the ones kept a workspace of their own", async () => {
    const onOpen = vi.fn();
    vi.mocked(gitReposIn).mockResolvedValue(["/Users/test/work/api", "/Users/test/work/web"]);
    vi.mocked(createWorkspace).mockResolvedValue(workspace({ id: "w2", name: "work" }));
    vi.mocked(createProject).mockImplementation(async (name, path) => ({ id: `p-${name}`, name, path }));
    // The backend answers with the whole record, the folder set just before included.
    vi.mocked(attachProject).mockImplementation(async (id, project) =>
      workspace({ id, name: "work", projects: [project], folder: "/Users/test/work" }),
    );
    const { result } = setUp([workspace()], onOpen);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => result.current.attachNewProjectForNewSession("/Users/test/work"));
    await waitFor(() => expect(result.current.folderRepos?.repos).toEqual(["/Users/test/work/api", "/Users/test/work/web"]));
    // Nothing is registered before the answer.
    expect(createProject).not.toHaveBeenCalled();

    await act(async () => result.current.confirmFolderRepos(["/Users/test/work/api"], "new"));

    expect(createWorkspace).toHaveBeenCalledWith("work");
    expect(setWorkspaceFolder).toHaveBeenCalledWith("w2", "/Users/test/work");
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith("api", "/Users/test/work/api");
    expect(attachProject).toHaveBeenCalledWith("w2", "p-api");
    expect(result.current.selectedWorkspace?.id).toBe("w2");
    expect(result.current.folderInView).toBe("/Users/test/work");
    expect(result.current.folderRepos).toBeNull();
    // The session it was picked for starts in the folder, beside them all.
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/Users/test/work", args: ["new"] }));
  });

  it("adds a folder's repositories to the workspace it was picked for, when asked to", async () => {
    vi.mocked(gitReposIn).mockResolvedValue(["/Users/test/work/api"]);
    vi.mocked(createProject).mockResolvedValue({ id: "p-api", name: "api", path: "/Users/test/work/api" });
    vi.mocked(attachProject).mockResolvedValue(workspace({ projects: ["p-api"] }));
    const { result } = setUp([workspace()]);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => result.current.handleAttachNewProject("/Users/test/work"));
    await waitFor(() => expect(result.current.folderRepos?.workspaceId).toBe("w1"));
    await act(async () => result.current.confirmFolderRepos(["/Users/test/work/api"], "same"));

    expect(createWorkspace).not.toHaveBeenCalled();
    // The Workspace it was added to stands for no folder it did not before.
    expect(setWorkspaceFolder).not.toHaveBeenCalled();
    expect(attachProject).toHaveBeenCalledWith("w1", "p-api");
    expect(result.current.selectedWorkspace?.projects).toEqual(["p-api"]);
  });

  it("starts a session in a folder with no repository in it without making it a project", async () => {
    const onOpen = vi.fn();
    const { result } = setUp([workspace()], onOpen);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => result.current.attachNewProjectForNewSession("/Users/test/notes"));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/Users/test/notes" })));
    expect(createProject).not.toHaveBeenCalled();
    expect(result.current.folderRepos).toBeNull();
  });

  it("says why a folder with no repository in it cannot be a project", async () => {
    const { result } = setUp([workspace()]);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));
    act(() => result.current.setSelectedWorkspaceId("w1"));

    await act(async () => result.current.handleAttachNewProject("/Users/test/notes"));

    await waitFor(() => expect(result.current.failure).toMatch(/~\/notes is not a git repository and has none in it/));
    expect(createProject).not.toHaveBeenCalled();
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

describe("live Codex conversations", () => {
  it("lists a conversation open in a live Codex session once, as the live one", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "w-1", pane: "%0", attached: true, cwd: "/tmp/w", command: "codex", title: "Weather tab" },
      // The same name in another folder is another conversation.
      { id: "2", session: "x-1", pane: "%1", attached: true, cwd: "/tmp/x", command: "codex", title: "Fix it" },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      { id: "a", cwd: "/tmp/w", agent: "codex", title: "Weather tab", updatedAt: 2 },
      { id: "b", cwd: "/tmp/w", agent: "codex", title: "Fix it", updatedAt: 1 },
      // Claude Code says which of its own are live; the list has none of them.
      { id: "c", cwd: "/tmp/w", title: "Weather tab", updatedAt: 1 },
    ]);
    const { result } = setUp([]);

    await waitFor(() => expect(result.current.claudeSessions).toHaveLength(2));
    expect(result.current.claudeSessions.map((past) => past.id)).toEqual(["b", "c"]);
  });
});

describe("conversations open in Roer's panes", () => {
  it("leaves them to their live rows, found by the pane's process", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "w-1", pane: "%0", attached: true, cwd: "/tmp/w", command: "claude", pid: 41 },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      { id: "live", cwd: "/tmp/w", title: "Weather tab", updatedAt: 3, pane: 41 },
      { id: "past", cwd: "/tmp/w", title: "Fix it", updatedAt: 1 },
    ]);
    const { result } = setUp([]);

    await waitFor(() => expect(result.current.paneConversations.get(41)?.id).toBe("live"));
    expect(listClaudeSessions).toHaveBeenCalledWith(expect.any(Array), [41]);
    expect(result.current.claudeSessions.map((past) => past.id)).toEqual(["past"]);
  });
});

describe("a workspace's folder", () => {
  it("takes in what runs there, and leaves it out of the first workspace", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "s1", session: "work", pane: "%1", attached: false, cwd: "/Users/test/work", command: "zsh" },
      { id: "s2", session: "tmp", pane: "%2", attached: false, cwd: "/tmp", command: "zsh" },
    ]);
    const { result } = setUp([workspace({ id: "w0", name: "Default" }), workspace({ id: "w2", name: "work", folder: "/Users/test/work" })]);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));

    act(() => result.current.setSelectedWorkspaceId("w2"));
    await waitFor(() => expect(result.current.visibleSessions.map((s) => s.pane)).toEqual(["%1"]));
    act(() => result.current.setSelectedWorkspaceId("w0"));
    await waitFor(() => expect(result.current.visibleSessions.map((s) => s.pane)).toEqual(["%2"]));
  });

  it("offers the repositories in a folder set as the workspace's, but not the ones it has", async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: "p-api", name: "api", path: "/Users/test/work/api" }]);
    vi.mocked(setWorkspaceFolder).mockResolvedValue(workspace({ projects: ["p-api"], folder: "/Users/test/work" }));
    vi.mocked(gitReposIn).mockResolvedValue(["/Users/test/work/api", "/Users/test/work/web"]);
    vi.mocked(createProject).mockResolvedValue({ id: "p-web", name: "web", path: "/Users/test/work/web" });
    vi.mocked(attachProject).mockResolvedValue(workspace({ projects: ["p-api", "p-web"], folder: "/Users/test/work" }));
    const { result } = setUp([workspace({ projects: ["p-api"] })]);
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    await act(async () => result.current.handleSetWorkspaceFolder("w1", "/Users/test/work"));
    await waitFor(() => expect(result.current.folderRepos).toMatchObject({ repos: ["/Users/test/work/web"], workspaceId: "w1", forFolder: true }));
    await act(async () => result.current.confirmFolderRepos(["/Users/test/work/web"], "same"));

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(attachProject).toHaveBeenCalledWith("w1", "p-web");
    expect(result.current.workspaces[0].projects).toEqual(["p-api", "p-web"]);
  });

  it("is set and forgotten from the workspace", async () => {
    const { result } = setUp([workspace()]);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));

    await act(async () => result.current.handleSetWorkspaceFolder("w1", "/Users/test/work"));
    await waitFor(() => expect(result.current.workspaces[0].folder).toBe("/Users/test/work"));
    await act(async () => result.current.handleSetWorkspaceFolder("w1", null));
    await waitFor(() => expect(result.current.workspaces[0].folder).toBeUndefined());
  });
});

/** A live row as `roer list` gives it, for the pane a clone runs in. */
function pane(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id: "s5", session: "hello", pane: "%5", attached: true, cwd: "/Users/test/work", command: "zsh", ...overrides };
}

describe("adding a project from the dialog", () => {
  const dest = "/Users/test/work/hello";

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(killSession).mockClear();
  });

  /** Asks for a clone into `dest`, attached to w2, and gives back the hook. */
  async function cloning(session = false) {
    const onOpen = vi.fn();
    const hook = setUp([workspace(), workspace({ id: "w2", name: "two" })], onOpen);
    await waitFor(() => expect(hook.result.current.workspaces).toHaveLength(2));
    act(() =>
      hook.result.current.handleAddProject({ mode: "clone", url: "https://example.com/hello.git", dest, workspaceId: "w2", session }),
    );
    return { ...hook, onOpen };
  }

  /** The live list becomes `live`, read as the poll would, with git's
   * answer about the folder in by the end. */
  async function listed(result: { current: { refresh: () => Promise<void> } }, live: SessionInfo[]) {
    vi.mocked(listSessions).mockResolvedValue(live);
    await act(async () => result.current.refresh());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  /** The next poll's worth of time on: a list read now is read well after
   * the last look at the folder. */
  let ahead = 0;
  const realNow = Date.now.bind(Date);
  function later() {
    ahead += 5000;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + ahead);
  }

  afterEach(() => {
    ahead = 0;
    vi.restoreAllMocks();
  });

  it("clones in a terminal of its own, and adds the project once git is done there", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "p9", name: "hello", path: dest });
    vi.mocked(attachProject).mockResolvedValue(workspace({ id: "w2", name: "two", projects: ["p9"] }));
    const { result, onOpen } = await cloning();

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["new", "--shell", "--command", `git clone 'https://example.com/hello.git' '${dest}'`, "hello"],
        cwd: "/Users/test/work",
      }),
    );

    // While git runs, the folder is not a project yet, whatever it holds.
    vi.mocked(gitRoot).mockResolvedValue(dest);
    await listed(result, [pane({ command: "git" })]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(createProject).not.toHaveBeenCalled();

    await listed(result, [pane()]);
    // Looks done, but the list may predate git: said again by a later one.
    expect(createProject).not.toHaveBeenCalled();
    later();
    await listed(result, [pane()]);
    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("w2", "p9"));
    expect(createProject).toHaveBeenCalledWith("hello", dest);
    await waitFor(() => expect(killSession).toHaveBeenCalledWith("%5"));
    // In view, where the dialog said, rather than where the sidebar was.
    expect(result.current.selectedWorkspaceId).toBe("w2");
    expect(result.current.projects).toEqual([{ id: "p9", name: "hello", path: dest }]);
  });

  it("starts a session in the clone, when asked to", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "p9", name: "hello", path: dest });
    vi.mocked(attachProject).mockResolvedValue(workspace({ id: "w2", name: "two", projects: ["p9"] }));
    const { result, onOpen } = await cloning(true);
    vi.mocked(gitRoot).mockResolvedValue(dest);

    await listed(result, [pane({ command: "git" })]);
    await listed(result, [pane()]);
    later();
    await listed(result, [pane()]);

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ args: ["new"], cwd: dest })));
  });

  it("leaves a failed clone's terminal open, to say why", async () => {
    const { result } = await cloning();

    await listed(result, [pane({ command: "git" })]);
    // git gave up, and took the folder it began with it.
    await listed(result, [pane()]);
    await listed(result, [pane()]);

    expect(createProject).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });

  it("tells its terminal from another session started meanwhile by its name", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "p9", name: "hello", path: dest });
    vi.mocked(attachProject).mockResolvedValue(workspace({ id: "w2", name: "two", projects: ["p9"] }));
    const { result } = await cloning();
    vi.mocked(gitRoot).mockResolvedValue(dest);

    const other = pane({ id: "s6", session: "elsewhere", pane: "%6" });
    await listed(result, [other, pane({ command: "git" })]);
    await listed(result, [other, pane()]);
    later();
    await listed(result, [other, pane()]);

    await waitFor(() => expect(killSession).toHaveBeenCalledWith("%5"));
    expect(killSession).toHaveBeenCalledTimes(1);
  });

  it("takes no list read before git started for git done, however far it got", async () => {
    const { result } = await cloning(true);
    // Still the shell when the list was read, and by the time the folder is
    // looked at git has made it, .git and all, and is fetching.
    vi.mocked(gitRoot).mockResolvedValue(dest);
    await listed(result, [pane()]);
    later();
    await listed(result, [pane({ command: "git" })]);
    later();
    await listed(result, [pane({ command: "git" })]);

    expect(createProject).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });

  it("knows git as Windows names it, for a clone of an empty repository", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "p9", name: "hello", path: dest });
    vi.mocked(attachProject).mockResolvedValue(workspace({ id: "w2", name: "two", projects: ["p9"] }));
    const { result } = await cloning();
    // Nothing to check out, ever: a repository there once git has stopped.
    vi.mocked(gitRoot).mockResolvedValue(dest);

    await listed(result, [pane({ command: "git.exe" })]);
    later();
    await listed(result, [pane({ command: "git.exe" })]);
    expect(createProject).not.toHaveBeenCalled();

    await listed(result, [pane({ command: "pwsh" })]);
    later();
    await listed(result, [pane({ command: "pwsh" })]);
    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("w2", "p9"));
  });

  it("knows a clone is done by its checkout where the terminal never says git runs", async () => {
    vi.mocked(createProject).mockResolvedValue({ id: "p9", name: "hello", path: dest });
    vi.mocked(attachProject).mockResolvedValue(workspace({ id: "w2", name: "two", projects: ["p9"] }));
    const { result } = await cloning();
    const shell = pane({ command: "pwsh" });
    // A repository there all along, fetching: not checked out yet.
    vi.mocked(gitRoot).mockResolvedValue(dest);
    await listed(result, [shell]);
    later();
    await listed(result, [shell]);
    expect(createProject).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();

    vi.mocked(gitCheckedOut).mockResolvedValue(true);
    await listed(result, [shell]);
    later();
    await listed(result, [shell]);

    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("w2", "p9"));
    await waitFor(() => expect(killSession).toHaveBeenCalledWith("%5"));
  });

  it("makes a new repository with git init, the same way", async () => {
    const onOpen = vi.fn();
    const { result } = setUp([workspace()], onOpen);
    await waitFor(() => expect(result.current.workspaces).toHaveLength(1));

    act(() => result.current.handleAddProject({ mode: "new", dest, workspaceId: "w1", session: false }));

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["new", "--shell", "--command", `git init '${dest}'`, "hello"] }),
    );
    // And offers the same folder for the next one.
    expect(result.current.projectParent("w1")).toBe("/Users/test/work");
  });
});

describe("a workspace's folder, watched", () => {
  const folder = "/Users/test/work";

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Long enough for the poll to look in the folders again. */
  const aWhile = () => act(async () => vi.advanceTimersByTimeAsync(15_000));

  it("attaches a repository that turns up in it, but not what was there to begin with", async () => {
    vi.mocked(gitReposIn).mockResolvedValue([`${folder}/api`]);
    vi.mocked(createProject).mockImplementation(async (name, path) => ({ id: `p-${name}`, name, path }));
    vi.mocked(attachProject).mockImplementation(async (id, projectId) => workspace({ id, folder, projects: [projectId] }));
    const { result } = setUp([workspace({ folder })]);
    await waitFor(() => expect(gitReposIn).toHaveBeenCalledWith(folder));

    // Cloned there by an agent, say.
    vi.mocked(gitReposIn).mockResolvedValue([`${folder}/api`, `${folder}/web`]);
    await aWhile();

    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("w1", "p-web"));
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith("web", `${folder}/web`);
    expect(result.current.workspaces[0].projects).toEqual(["p-web"]);
  });

  it("does not take back a repository detached from it", async () => {
    vi.mocked(gitReposIn).mockResolvedValue([`${folder}/api`]);
    setUp([workspace({ folder })]);
    await waitFor(() => expect(gitReposIn).toHaveBeenCalled());

    // api was there all along, so seen: a workspace without it chose so.
    await aWhile();
    await aWhile();

    expect(createProject).not.toHaveBeenCalled();
  });

  it("leaves a repository cloned there from the dialog to the workspace the dialog said", async () => {
    vi.mocked(gitReposIn).mockResolvedValue([]);
    vi.mocked(createProject).mockImplementation(async (name, path) => ({ id: `p-${name}`, name, path }));
    vi.mocked(attachProject).mockImplementation(async (id, projectId) => workspace({ id, projects: [projectId] }));
    const { result } = setUp([workspace({ folder }), workspace({ id: "w2", name: "two" })]);
    await waitFor(() => expect(gitReposIn).toHaveBeenCalled());

    act(() =>
      result.current.handleAddProject({ mode: "clone", url: "https://example.com/web.git", dest: `${folder}/web`, workspaceId: "w2", session: false }),
    );
    // Half cloned, in the folder: .git is there already.
    vi.mocked(gitReposIn).mockResolvedValue([`${folder}/web`]);
    vi.mocked(listSessions).mockResolvedValue([pane({ session: "web", command: "git" })]);
    await aWhile();
    expect(attachProject).not.toHaveBeenCalled();

    vi.mocked(gitRoot).mockResolvedValue(`${folder}/web`);
    vi.mocked(listSessions).mockResolvedValue([pane({ session: "web" })]);
    await aWhile();
    await aWhile();

    await waitFor(() => expect(attachProject).toHaveBeenCalledWith("w2", "p-web"));
    expect(attachProject).toHaveBeenCalledTimes(1);
  });
});
