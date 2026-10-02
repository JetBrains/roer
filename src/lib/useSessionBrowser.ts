import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logLine } from "./log";

import { gitChanges, gitRepo, type Repo } from "../lib/git";
import { confirmAction } from "./confirm";
import { notify } from "./notify";
import {
  killSession,
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
import { isWorking, paneLabel, runningAgent, shorten, toldByOutput, type OpenRequest } from "../SessionBrowser";

/** What a session's directory has on its branch, for its row. */
export interface DirStats {
  branch: string;
  commit: string;
  files: number;
  added: number;
  deleted: number;
}

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
  // Each known directory's repository, which is what says a session in a
  // linked worktree is still the same project.
  const [repos, setRepos] = useState<Record<string, Repo>>({});
  const [failure, setShownFailure] = useState<string | null>(null);
  // Every failure the browser shows is one a bug report wants too.
  const setFailure = useCallback((next: string | null) => {
    if (next) logLine(`sessions: ${next}`);
    setShownFailure(next);
  }, []);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Session id (live session or Claude conversation) to the Workspace it is
  // assigned to — membership is explicit, not derived from a directory.
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  // Selecting a Workspace clears the Project filter and vice versa: one
  // active filter at a time, not a combined query. With no Project selected
  // there is always a Workspace, the first one on launch (see below) — it's a
  // view filter, not a memory of last time. `lastNewSessionCwd` below is what
  // remembers where to put a new session; the two are deliberately
  // independent. `null` is only the Project filter's turn, or before loading.
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

  // Panes whose agent finished while nobody was looking: it worked, and
  // stopped, somewhere other than on the stage. Seen once it is opened, or
  // once it goes back to work, which means someone answered it elsewhere.
  //
  // A pane is seen while it is on the stage and the window has the focus: a
  // session that stops while Roer is behind another app waits too.
  const [waiting, setWaitingRaw] = useState<ReadonlySet<string>>(() => new Set());
  const waitingRef = useRef<ReadonlySet<string>>(waiting);
  const setWaiting = useCallback((next: ReadonlySet<string>) => {
    const same = next.size === waitingRef.current.size && [...next].every((pane) => waitingRef.current.has(pane));
    if (same) return;
    waitingRef.current = next;
    setWaitingRaw(next);
  }, []);
  const workingRef = useRef(new Map<string, boolean>());
  const bellRef = useRef(new Map<string, boolean>());
  const stateRef = useRef(new Map<string, string>());
  // Per pane, its last output and in how many lists in a row that moved on.
  const printedRef = useRef(new Map<string, { activity: number; lists: number }>());
  // The first list only says how things stand: nothing in it is news.
  const firstListRef = useRef(true);
  const activePaneRef = useRef(activePane);
  activePaneRef.current = activePane;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const homeRef = useRef<string | undefined>(undefined);

  /** Takes in a fresh live list: the rows, what finished or rang since the
   * last one, and the new session a Workspace is waiting to be given. */
  const takeLive = useCallback((live: SessionInfo[]) => {
    setSessions((current) => (JSON.stringify(current) === JSON.stringify(live) ? current : live));

    const now = Date.now() / 1000;
    const wasWorking = workingRef.current;
    const hadRung = bellRef.current;
    const wasState = stateRef.current;
    stateRef.current = new Map(live.map((session) => [session.pane, session.state ?? ""]));
    const wasPrinted = printedRef.current;
    printedRef.current = new Map(
      live.map((session) => {
        const activity = session.activity ?? 0;
        const last = wasPrinted.get(session.pane);
        return [session.pane, { activity, lists: last && activity > last.activity ? last.lists + 1 : 0 }];
      }),
    );
    // Output alone starts a turn only once it keeps coming: a spinner moves on
    // between every two lists, while a TUI redrawing itself for a resize, as
    // opening or leaving the session does, prints once and is done. Taken for
    // work, that would be a stop, and a notification, a few seconds later.
    const working = new Map(
      live.map((session) => [
        session.pane,
        isWorking(session, now) &&
          (!toldByOutput(session) ||
            Boolean(wasWorking.get(session.pane)) ||
            (printedRef.current.get(session.pane)?.lists ?? 0) >= 2),
      ]),
    );
    workingRef.current = working;
    bellRef.current = new Map(live.map((session) => [session.pane, Boolean(session.bell)]));
    const seen = (pane: string) => pane === activePaneRef.current && document.hasFocus();

    // An agent that stopped, asked for something, or rang for attention.
    const turned = live.filter(
      (session) =>
        !seen(session.pane) &&
        !working.get(session.pane) &&
        (wasWorking.get(session.pane) ||
          (session.state === "waiting" && wasState.get(session.pane) !== "waiting") ||
          (session.bell && !hadRung.get(session.pane))),
    );
    const before = waitingRef.current;
    setWaiting(
      new Set(
        [...before, ...turned.map((session) => session.pane)].filter(
          (pane) => !seen(pane) && working.get(pane) === false,
        ),
      ),
    );

    // Named, so the notification says which one: "is waiting" alone, with
    // several sessions running, says nothing.
    if (!firstListRef.current) {
      for (const session of turned) {
        if (before.has(session.pane)) continue;
        const who = runningAgent(session) ?? session.command;
        const name = paneLabel(session.title, session.command) || who;
        // Claude's own words when its hooks gave them: "Claude needs your
        // permission to use Bash" says what to do, not only where.
        const what = session.note || `${who} is waiting for you`;
        void notify(name, `${what} · ${shorten(session.cwd, homeRef.current)}`, () =>
          onOpenRef.current({
            args: ["attach", session.pane],
            cwd: session.cwd,
            title: session.session,
            pane: session.pane,
          }),
        );
      }
    }
    firstListRef.current = false;

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
  }, []);

  // Branch and uncommitted changes per directory, read with the full list
  // and every so often between, never on every poll: `git status` is the
  // slowest thing a row shows.
  const [stats, setStats] = useState<Record<string, DirStats>>({});
  const refreshStats = useCallback((live: SessionInfo[]) => {
    const cwds = [...new Set(live.map((session) => session.cwd))].filter(Boolean);
    void Promise.all(
      cwds.map((cwd) =>
        Promise.resolve()
          .then(() => gitChanges(cwd))
          .then((changes): [string, DirStats] => {
            const counted = changes.files.filter((file) => file.counted);
            return [
              cwd,
              {
                branch: changes.branch,
                commit: changes.commit,
                files: changes.files.length,
                added: counted.reduce((sum, file) => sum + file.added, 0),
                deleted: counted.reduce((sum, file) => sum + file.deleted, 0),
              },
            ];
          })
          .catch(() => null),
      ),
    ).then((found) => {
      const next = Object.fromEntries(found.filter((entry): entry is [string, DirStats] => entry !== null));
      setStats((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const live = await listSessions();
      takeLive(live);
      refreshStats(live);

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
      const repoOf = (cwd: string) =>
        Promise.resolve()
          .then(() => gitRepo(cwd))
          .catch(() => null)
          .then((repo) => [cwd, repo] as const);
      const found = new Map(await Promise.all(cwds.map(repoOf)));
      // A conversation may have been had in any worktree of a repository
      // known here, and is looked for in all of them.
      const everywhere = [
        ...new Set([...cwds, ...[...found.values()].flatMap((repo) => repo?.worktrees ?? [])]),
      ];
      const claude = everywhere.length > 0 ? await listClaudeSessions(everywhere) : [];
      for (const [cwd, repo] of await Promise.all(
        claude.map((thread) => thread.cwd).filter((cwd) => !found.has(cwd)).map(repoOf),
      )) {
        found.set(cwd, repo);
      }
      setClaudeSessions(claude);
      // Grouped by repository, not by checkout: a worktree's sessions sit
      // with the rest of its project, and their rows say which worktree.
      setRoots(Object.fromEntries([...found].map(([cwd, repo]) => [cwd, repo?.main ?? cwd])));
      setRepos(
        Object.fromEntries([...found].filter((entry): entry is [string, Repo] => entry[1] !== null)),
      );
      setFailure(null);
    } catch (cause: unknown) {
      setFailure(String(cause));
    }
  }, [projects, takeLive, refreshStats]);

  homeRef.current = status?.home;

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

  // There is no unfiltered "All" to fall back to, so whenever neither filter
  // points at anything — on launch, or once the selected Workspace or Project
  // is deleted — the first Workspace is selected. The backend always seeds a
  // Default one, so there is a first.
  useEffect(() => {
    if (selectedProjectId !== null) return;
    if (workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) return;
    const first = workspaces[0];
    if (first) setSelectedWorkspaceIdRaw(first.id);
  }, [workspaces, selectedWorkspaceId, selectedProjectId]);

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

  /** Attaches to `workspaceId`, the selected Workspace unless another is
   * named, as the sidebar's menu does for whichever one was right-clicked. */
  const handleAttachExistingProject = (projectId: string, workspaceId = selectedWorkspace?.id) => {
    if (!workspaceId) return;
    void attachProject(workspaceId, projectId)
      .then((updated) => {
        if (!updated) return;
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
        );
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  /** Registers a brand new Project (deduped by path on the backend) and
   * attaches it to `workspaceId` (the selected Workspace by default) in one
   * step. */
  const handleAttachNewProject = (path: string, workspaceId = selectedWorkspace?.id) => {
    if (!workspaceId) return;
    void createProject(folderName(path), path)
      .then((project) => {
        setProjects((current) =>
          current.some((existing) => existing.id === project.id)
            ? current
            : [...current, project],
        );
        return attachProject(workspaceId, project.id);
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

  // Between those, only the live list is read again, often enough to see an
  // agent start and stop: it is one `roer list`, where `refresh` also reads
  // every conversation and git root. A pane that came or went needs those
  // too, so that one is a full refresh.
  useEffect(() => {
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      void listSessions()
        .then((live) => {
          const panes = [...workingRef.current.keys()];
          const changed =
            live.length !== panes.length || live.some((session) => !workingRef.current.has(session.pane));
          if (changed) {
            void refresh();
            return;
          }
          takeLive(live);
          if (ticks % STATS_EVERY === 0) refreshStats(live);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, refreshStats, takeLive]);

  // Opening a waiting session is seeing it, and so is coming back to the
  // window with it on the stage.
  useEffect(() => {
    const markSeen = () => {
      const pane = activePaneRef.current;
      if (!pane || !waitingRef.current.has(pane) || !document.hasFocus()) return;
      const next = new Set(waitingRef.current);
      next.delete(pane);
      setWaiting(next);
    };
    markSeen();
    window.addEventListener("focus", markSeen);
    return () => window.removeEventListener("focus", markSeen);
  }, [activePane, setWaiting]);

  /** End session, from a row's menu: asked first, since whatever runs in it
   * stops with it, and the more so when an agent is still at work. */
  const handleEndSession = (session: SessionInfo) => {
    const name = paneLabel(session.title, session.command) || (runningAgent(session) ?? session.command);
    const busy = isWorking(session) ? " An agent is still working in it." : "";
    void confirmAction(`End "${name}"?${busy} Everything running in it stops.`, "End session")
      .then(async (confirmed) => {
        if (!confirmed) return;
        await killSession(session.pane);
        await refresh();
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  // The Dock (or taskbar) counts them too, for when Roer is not in front.
  // Outside Tauri there is no window, and asking for one throws.
  useEffect(() => {
    try {
      void getCurrentWindow()
        .setBadgeCount(waiting.size > 0 ? waiting.size : undefined)
        .catch(() => {});
    } catch {
      /* no window */
    }
  }, [waiting]);

  // Counts the sessions opened from here, only so each one is a different
  // request. Two clicks send the same args to the same directory, and without
  // something to tell them apart the stage sees no change and keeps the first
  // terminal mounted.
  const openedRef = useRef(0);

  // The agent the next session starts, kept across the Project picker that
  // may come up between choosing it and the session starting.
  const pendingAgentRef = useRef<string | undefined>(undefined);

  const startNewSession = (cwd: string | undefined, workspace: Workspace | null, agent?: string) => {
    openedRef.current += 1;
    const known = sessions.map((session) => session.pane);
    pendingAssignRef.current = workspace ? { known, workspaceId: workspace.id } : null;
    // Remembered only so a later `openNew` (below) in a Workspace with no
    // Projects has somewhere better than home to fall back to — not tied to
    // the view filter, which always starts fresh on launch.
    if (cwd) localStorage.setItem("roer:last-new-session-cwd", cwd);
    onOpen({
      args: agent === SHELL ? ["new", "--shell"] : agent ? ["new", "--agent", agent] : ["new"],
      cwd,
      title: "new session",
      nonce: `new-${openedRef.current}`,
      known,
    });
  };

  // `new` rather than `shell`, because `shell` reuses the session for a
  // directory. A new session starts in the selected Project's directory when
  // one is selected directly (the Projects tab), otherwise in the selected
  // Workspace's attached Project when it has exactly one, otherwise wherever
  // the last new session was started, otherwise the home directory. A
  // Workspace with several Projects asks which one, rather than guessing —
  // `pickingProjectFor` holds the Workspace while that picker is up.
  //
  // `agent` is an agent's id, or `SHELL` for just a shell; without one the
  // shim starts the default agent.
  const openNew = (agent?: string) => {
    if (selectedProject) {
      startNewSession(selectedProject.path, selectedWorkspace, agent);
      return;
    }
    if (selectedWorkspace && selectedWorkspaceProjects.length > 1) {
      pendingAgentRef.current = agent;
      setPickingProjectFor(selectedWorkspace);
      return;
    }
    startNewSession(
      selectedWorkspaceProjects[0]?.path ??
        localStorage.getItem("roer:last-new-session-cwd") ??
        status?.home,
      selectedWorkspace,
      agent,
    );
  };

  /** Where a new session would start, when that is known without asking:
   * the directory whose project's own agents apply to it. `undefined` while
   * a Workspace with several Projects has yet to ask which, so that no one
   * Project's agents are offered for all of them. */
  const newSessionCwd = (): string | undefined => {
    if (selectedProject) return selectedProject.path;
    if (selectedWorkspace && selectedWorkspaceProjects.length > 1) return undefined;
    return (
      selectedWorkspaceProjects[0]?.path ??
      localStorage.getItem("roer:last-new-session-cwd") ??
      status?.home
    );
  };

  const cancelProjectPick = () => setPickingProjectFor(null);

  const pickProjectForNewSession = (path: string) => {
    const workspace = pickingProjectFor;
    setPickingProjectFor(null);
    startNewSession(path, workspace, pendingAgentRef.current);
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
        startNewSession(path, workspace, pendingAgentRef.current);
      })
      .catch((cause: unknown) => setFailure(String(cause)));
  };

  // Resuming a past conversation goes through the shim's own `resume`, not
  // `new` — the transcript, not just the directory, is what's being
  // reopened, by the CLI that wrote it.
  const openClaudeSession = (session: ClaudeSession) => {
    openedRef.current += 1;
    const agent = session.agent && session.agent !== "claude" ? ["--agent", session.agent] : [];
    onOpen({
      args: ["resume", session.id, ...agent],
      cwd: session.cwd,
      title: session.title,
      nonce: `resume-${openedRef.current}`,
      known: sessions.map((s) => s.pane),
    });
  };

  // Under the Project's folder, or under the same folder of another
  // worktree of its repository: the same project, checked out twice.
  const within = (cwd: string, path: string) => cwd === path || cwd.startsWith(`${path}/`);
  const underProject = (cwd: string, project: Project) => {
    if (within(cwd, project.path)) return true;
    const theirs = repos[project.path];
    const ours = repos[cwd];
    if (!theirs || !ours || theirs.main !== ours.main || !within(project.path, theirs.root)) return false;
    return within(cwd, ours.root + project.path.slice(theirs.root.length));
  };

  // A Workspace's view is the union of what its own attached Projects cover
  // and whatever was explicitly assigned — a session under an attached
  // Project's path belongs here without anyone having to tag it by hand, the
  // same way selecting the Project itself would show it.
  const underWorkspace = (cwd: string, id: string, workspace: Workspace) =>
    assignments[id] === workspace.id ||
    selectedWorkspaceProjects.some((project) => underProject(cwd, project)) ||
    (workspace.id === workspaces[0]?.id && !coveredByAny(cwd, id));

  // Default, the first Workspace, also takes whatever no Workspace covers, so
  // a session is always listed somewhere. Without that, a fresh install —
  // one Default with no Projects — lists nothing at all, however many
  // sessions are running.
  const coveredByAny = (cwd: string, id: string) =>
    workspaces.some((workspace) => assignments[id] === workspace.id) ||
    workspaces.some((workspace) =>
      workspace.projects.some((projectId) => {
        const project = projects.find((candidate) => candidate.id === projectId);
        return project != null && underProject(cwd, project);
      }),
    );

  // A resumed conversation's tmux session (`<dir>-resume`, `-resume-2`, ...):
  // scaffolding the shim creates so the resume is teleportable. Once its
  // agent has quit, the conversation's own row stands for it, and the shell
  // left behind is not worth a row. While the agent runs it is the only row
  // there is — a conversation being had is never offered for resuming — so
  // it is listed like any other session.
  const isResumeScaffold = (session: SessionInfo) =>
    /-resume(-\d+)?$/.test(session.session) && !runningAgent(session);

  const visibleSessions = (
    selectedProject
      ? sessions.filter((session) => underProject(session.cwd, selectedProject))
      : selectedWorkspace
        ? sessions.filter((session) => underWorkspace(session.cwd, session.id, selectedWorkspace))
        : sessions
  ).filter((session) => !isResumeScaffold(session));
  // Search looks past the selected Workspace: finding a session is the
  // point when you don't know where it is.
  const allSessions = sessions.filter((session) => !isResumeScaffold(session));

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
    repos,
    waiting,
    stats,
    handleEndSession,
    allSessions,
    claudeSessions,
    visibleSessions,
    visibleClaudeSessions,
    activePane,
    openNew,
    newSessionCwd,
    pickingProjectFor,
    cancelProjectPick,
    pickProjectForNewSession,
    attachNewProjectForNewSession,
    openClaudeSession,
    refresh,
  };
}

/** How often the live list is read for agents starting and stopping. */
const POLL_MS = 3000;

/** Every how many polls the branches and changes are read again. */
const STATS_EVERY = 10;

/** What `openNew` takes to start a session with just a shell. */
export const SHELL = "--shell";

export type SessionBrowserState = ReturnType<typeof useSessionBrowser>;
