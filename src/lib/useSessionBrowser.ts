import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";

import { gitRoot } from "../lib/git";
import {
  listClaudeSessions,
  listPastSessions,
  listSessions,
  roerStatus,
  type ClaudeSession,
  type RoerStatus,
  type SessionInfo,
} from "../lib/pty";
import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
  type Project,
} from "../lib/projects";
import {
  addWorkspaceItem,
  assignSession,
  attachProject,
  createWorkspace,
  deleteWorkspace,
  detachProject,
  listWorkspaces,
  removeWorkspaceItem,
  renameWorkspace,
  unassignSession,
  workspaceAssignments,
  type Workspace,
} from "../lib/workspaces";
import type { OpenRequest } from "../SessionBrowser";

export interface UseSessionBrowserArgs {
  /** The pane on the stage, so the list can mark it rather than offer it. */
  activePane?: string;
  /** Changes whenever the stage changes, which is when the list is stale. */
  token: string;
  onOpen: (request: OpenRequest) => void;
}

/** Just the directory's own name, used as a new Project's starting name. */
function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/**
 * Everything the Workspace sidebar and the session browser share: which
 * Workspace or Project is selected, what's assigned to it, and the sessions
 * and conversations that filters. One hook rather than several, because the
 * views are one piece of state split across places on screen — not
 * independent features.
 */
export function useSessionBrowser({ activePane, token, onOpen }: UseSessionBrowserArgs) {
  const [status, setStatus] = useState<RoerStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [roots, setRoots] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Session id (live session or Claude conversation) to the Workspace it is
  // assigned to — membership is explicit, not derived from a directory.
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  // `null` is "All" — every session and conversation, same as before
  // Workspaces existed. Selecting a Workspace clears the Project filter and
  // vice versa: one active filter at a time, not a combined query.
  const [selectedWorkspaceId, setSelectedWorkspaceIdRaw] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectIdRaw] = useState<string | null>(null);
  const [addingItem, setAddingItem] = useState(false);
  const [itemTitle, setItemTitle] = useState("");
  // A brand new session waits for a project pick when its Workspace has more
  // than one attached — this is what the picker is showing, if anything.
  const [pickingProjectFor, setPickingProjectFor] = useState<Workspace | null>(null);

  const setSelectedWorkspaceId = useCallback((id: string | null) => {
    setSelectedWorkspaceIdRaw(id);
    setSelectedProjectIdRaw(null);
  }, []);

  const setSelectedProjectId = useCallback((id: string | null) => {
    setSelectedProjectIdRaw(id);
    if (id !== null) setSelectedWorkspaceIdRaw(null);
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const [list, projectList, assigned] = await Promise.all([
        listWorkspaces(),
        listProjects(),
        workspaceAssignments(),
      ]);
      setWorkspaces(list);
      setProjects(projectList);
      setAssignments(assigned);
    } catch (cause: unknown) {
      setFailure(String(cause));
    }
  }, []);

  // A "New session" click while a Workspace is selected, waiting for the
  // pane tmux makes for it — the same problem App.tsx's own `adopt` solves
  // for finding which pane is on screen, solved the same way: the one pane
  // that was not there before the click.
  const pendingAssignRef = useRef<{ known: string[]; workspaceId: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const live = await listSessions();
      setSessions(live);

      const pending = pendingAssignRef.current;
      if (pending) {
        const fresh = live.filter((session) => !pending.known.includes(session.pane));
        if (fresh.length === 1) {
          pendingAssignRef.current = null;
          const { id: sessionId } = fresh[0];
          const { workspaceId } = pending;
          void assignSession(sessionId, workspaceId)
            .then(() => setAssignments((current) => ({ ...current, [sessionId]: workspaceId })))
            .catch((cause: unknown) => setFailure(String(cause)));
        }
      }

      // Reconciling history depends on having just asked for the live list,
      // so this always follows it rather than running in parallel. Its own
      // rows are no longer shown directly — only its cwds, to scope which
      // Claude conversations are worth looking up. Every registered Project's
      // path is included too: a conversation can predate any tmux session
      // Roer ever tracked (or survive one being forgotten, e.g. by a state
      // reset), but a Project the user explicitly attached is always worth
      // checking.
      const past = await listPastSessions();
      const cwds = [
        ...new Set([
          ...live.map((s) => s.cwd),
          ...past.map((p) => p.cwd),
          ...projects.map((p) => p.path),
        ]),
      ].filter(Boolean);
      const [claude, rootEntries] = await Promise.all([
        cwds.length > 0 ? listClaudeSessions(cwds) : Promise.resolve([]),
        Promise.all(cwds.map(async (cwd) => [cwd, (await gitRoot(cwd)) ?? cwd] as const)),
      ]);
      setClaudeSessions(claude);
      setRoots(Object.fromEntries(rootEntries));
      setFailure(null);
    } catch (cause: unknown) {
      setFailure(String(cause));
    }
  }, [projects]);

  useEffect(() => {
    void roerStatus()
      .then(setStatus)
      .catch((cause: unknown) => setFailure(String(cause)));
  }, []);

  // Workspaces are independent of the stage, unlike everything `refresh`
  // covers — nothing about a Workspace's own identity depends on which
  // session is active.
  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedWorkspaceProjects = selectedWorkspace
    ? selectedWorkspace.projects
        .map((id) => projects.find((project) => project.id === id))
        .filter((project): project is Project => project != null)
    : [];

  const handleCreateWorkspace = (name: string) => {
    void createWorkspace(name)
      .then((workspace) => {
        setWorkspaces((current) => [...current, workspace]);
        setSelectedWorkspaceId(workspace.id);
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleRenameWorkspace = (id: string, name: string) => {
    void renameWorkspace(id, name)
      .then((updated) => {
        if (!updated) return;
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleDeleteWorkspace = (id: string) => {
    void deleteWorkspace(id)
      .then(() => {
        setWorkspaces((current) => current.filter((workspace) => workspace.id !== id));
        setSelectedWorkspaceIdRaw((current) => (current === id ? null : current));
        setAssignments((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([, workspaceId]) => workspaceId !== id),
          ),
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleAssign = (sessionId: string, workspaceId: string | null) => {
    void (workspaceId ? assignSession(sessionId, workspaceId) : unassignSession(sessionId))
      .then(() => {
        setAssignments((current) => {
          if (!workspaceId) {
            const { [sessionId]: _removed, ...rest } = current;
            return rest;
          }
          return { ...current, [sessionId]: workspaceId };
        });
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  /** True once nothing left attached to `projectId` references it — an
   * orphan worth offering to delete from the registry outright. */
  const isOrphaned = (projectId: string, workspaceList: Workspace[]) =>
    !workspaceList.some((workspace) => workspace.projects.includes(projectId));

  /** Registers a Project on its own, with nothing attaching it to a
   * Workspace yet — the Projects tab's own "New project", as opposed to
   * SessionBrowser's create-and-attach flow. */
  const handleCreateProject = (name: string, path: string) => {
    void createProject(name, path)
      .then((project) => {
        setProjects((current) =>
          current.some((existing) => existing.id === project.id)
            ? current
            : [...current, project],
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleAttachExistingProject = (projectId: string) => {
    if (!selectedWorkspace) return;
    void attachProject(selectedWorkspace.id, projectId)
      .then((updated) => {
        if (!updated) return;
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  /** Registers a brand new Project (deduped by path on the backend) and
   * attaches it to the selected Workspace in one step. */
  const handleAttachNewProject = (path: string) => {
    if (!selectedWorkspace) return;
    void createProject(folderName(path), path)
      .then((project) => {
        setProjects((current) =>
          current.some((existing) => existing.id === project.id)
            ? current
            : [...current, project],
        );
        return attachProject(selectedWorkspace.id, project.id);
      })
      .then((updated) => {
        if (!updated) return;
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleDetachProject = (projectId: string) => {
    if (!selectedWorkspace) return;
    void detachProject(selectedWorkspace.id, projectId)
      .then(async (updated) => {
        if (!updated) return;
        const nextWorkspaces = workspaces.map((workspace) =>
          workspace.id === updated.id ? updated : workspace,
        );
        setWorkspaces(nextWorkspaces);
        if (!isOrphaned(projectId, nextWorkspaces)) return;
        const project = projects.find((candidate) => candidate.id === projectId);
        const alsoDelete = await ask(
          `"${project?.name ?? "This project"}" is no longer attached to any Workspace. Delete it too?`,
          { title: "Detach project", kind: "warning" },
        );
        if (!alsoDelete) return;
        await deleteProject(projectId);
        setProjects((current) => current.filter((candidate) => candidate.id !== projectId));
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleRenameProject = (id: string, name: string) => {
    void renameProject(id, name)
      .then((updated) => {
        if (!updated) return;
        setProjects((current) =>
          current.map((project) => (project.id === updated.id ? updated : project)),
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleDeleteProject = (id: string) => {
    void deleteProject(id)
      .then(() => {
        setProjects((current) => current.filter((project) => project.id !== id));
        setWorkspaces((current) =>
          current.map((workspace) => ({
            ...workspace,
            projects: workspace.projects.filter((projectId) => projectId !== id),
          })),
        );
        setSelectedProjectIdRaw((current) => (current === id ? null : current));
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleAddItem = () => {
    const trimmed = itemTitle.trim();
    if (!selectedWorkspace || !trimmed) return;
    void addWorkspaceItem(selectedWorkspace.id, "task", trimmed)
      .then((updated) => {
        if (!updated) return;
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
        );
        setItemTitle("");
        setAddingItem(false);
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  const handleRemoveItem = (itemId: string) => {
    if (!selectedWorkspace) return;
    void removeWorkspaceItem(selectedWorkspace.id, itemId)
      .then((updated) => {
        if (!updated) return;
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  // Opening or releasing a session changes what is attached to what, so the
  // badges are stale the moment the stage changes. A pane that has only just
  // become known counts too: a session started here is created by the shim
  // moments after the click, so the list drawn at click time can predate it.
  useEffect(() => {
    void refresh();
  }, [activePane, refresh, token]);

  // Counts the sessions opened from here, only so each one is a different
  // request. Two clicks send the same args to the same directory, and without
  // something to tell them apart the stage sees no change and keeps the first
  // terminal mounted.
  const openedRef = useRef(0);

  const startNewSession = (cwd: string | undefined, workspace: Workspace | null) => {
    openedRef.current += 1;
    const known = sessions.map((session) => session.pane);
    pendingAssignRef.current = workspace ? { known, workspaceId: workspace.id } : null;
    onOpen({
      args: ["new"],
      cwd,
      title: "new session",
      nonce: `new-${openedRef.current}`,
      known,
    });
  };

  // `new` rather than `shell`, because `shell` reuses the session for a
  // directory. A new session starts in the selected Project's directory when
  // one is selected directly (the Projects tab), otherwise in the selected
  // Workspace's attached Project when it has exactly one, otherwise the home
  // directory. A Workspace with several Projects asks which one, rather than
  // guessing — `pickingProjectFor` holds the Workspace while that picker is up.
  const openNew = () => {
    if (selectedProject) {
      startNewSession(selectedProject.path, selectedWorkspace);
      return;
    }
    if (selectedWorkspace && selectedWorkspaceProjects.length > 1) {
      setPickingProjectFor(selectedWorkspace);
      return;
    }
    startNewSession(selectedWorkspaceProjects[0]?.path ?? status?.home, selectedWorkspace);
  };

  const cancelProjectPick = () => setPickingProjectFor(null);

  const pickProjectForNewSession = (path: string) => {
    const workspace = pickingProjectFor;
    setPickingProjectFor(null);
    startNewSession(path, workspace);
  };

  /** The picker's "Attach a new project…" escape hatch: registers and
   * attaches the Project, then starts the session in it right away. */
  const attachNewProjectForNewSession = (path: string) => {
    const workspace = pickingProjectFor;
    setPickingProjectFor(null);
    if (!workspace) return;
    void createProject(folderName(path), path)
      .then((project) => {
        setProjects((current) =>
          current.some((existing) => existing.id === project.id)
            ? current
            : [...current, project],
        );
        return attachProject(workspace.id, project.id);
      })
      .then((updated) => {
        if (updated) {
          setWorkspaces((current) =>
            current.map((existing) => (existing.id === updated.id ? updated : existing)),
          );
        }
        startNewSession(path, workspace);
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  // Resuming a past Claude conversation goes through the shim's own
  // `resume`, not `new` — the transcript, not just the directory, is what's
  // being reopened.
  const openClaudeSession = (session: ClaudeSession) => {
    openedRef.current += 1;
    onOpen({
      args: ["resume", session.id],
      cwd: session.cwd,
      title: session.title,
      nonce: `resume-${openedRef.current}`,
      known: sessions.map((s) => s.pane),
    });
  };

  const underProject = (cwd: string, project: Project) =>
    cwd === project.path || cwd.startsWith(`${project.path}/`);

  // A Workspace's view is the union of what its own attached Projects cover
  // and whatever was explicitly assigned — a session under an attached
  // Project's path belongs here without anyone having to tag it by hand, the
  // same way selecting the Project itself would show it.
  const underWorkspace = (cwd: string, id: string, workspace: Workspace) =>
    assignments[id] === workspace.id ||
    selectedWorkspaceProjects.some((project) => underProject(cwd, project));

  const visibleSessions = selectedProject
    ? sessions.filter((session) => underProject(session.cwd, selectedProject))
    : selectedWorkspace
      ? sessions.filter((session) => underWorkspace(session.cwd, session.id, selectedWorkspace))
      : sessions;
  const visibleClaudeSessions = selectedProject
    ? claudeSessions.filter((session) => underProject(session.cwd, selectedProject))
    : selectedWorkspace
      ? claudeSessions.filter((session) => underWorkspace(session.cwd, session.id, selectedWorkspace))
      : claudeSessions;

  return {
    status,
    failure,
    workspaces,
    projects,
    assignments,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceProjects,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject,
    handleCreateWorkspace,
    handleRenameWorkspace,
    handleDeleteWorkspace,
    handleAssign,
    handleCreateProject,
    handleAttachExistingProject,
    handleAttachNewProject,
    handleDetachProject,
    handleRenameProject,
    handleDeleteProject,
    addingItem,
    setAddingItem,
    itemTitle,
    setItemTitle,
    handleAddItem,
    handleRemoveItem,
    roots,
    visibleSessions,
    visibleClaudeSessions,
    activePane,
    openNew,
    pickingProjectFor,
    cancelProjectPick,
    pickProjectForNewSession,
    attachNewProjectForNewSession,
    openClaudeSession,
    refresh,
  };
}

export type SessionBrowserState = ReturnType<typeof useSessionBrowser>;
