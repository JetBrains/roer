import type { ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { confirmAction } from "./lib/confirm";
import { pickFolder } from "./lib/folderPicker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Repo } from "./lib/git";
import type { Project } from "./lib/projects";
import type { ClaudeSession, SessionInfo } from "./lib/pty";
import type { DirStats, SessionBrowserState } from "./lib/useSessionBrowser";
import type { Workspace } from "./lib/workspaces";

export interface OpenRequest {
  args: string[];
  cwd?: string;
  title: string;
  /** Known when a session is opened by pane, which is how the list and a
   * teleport both do it. A brand new session has no pane until tmux makes one. */
  pane?: string;
  /** Tells one brand new session apart from the next. The shim names them
   * itself, so `args` is identical every time and cannot do it. */
  nonce?: string;
  /** The panes that already existed, for a session that has none yet: the
   * one tmux makes for it is the one that was not in this list. */
  known?: string[];
}

/** A session's directory, in the form a person recognises it. */
export function shorten(cwd: string, home: string | undefined): string {
  if (!cwd) return "";
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/**
 * The shortest trailing slice of each path that no other path in the list
 * shares, so two checkouts both called `roer` read as `IdeaProjects/roer`
 * and `worktrees/roer` instead of two identical headings.
 */
export function distinctLabels(paths: string[]): Map<string, string> {
  const parts = new Map(paths.map((path) => [path, path.replace(/\/+$/, "").split("/")]));
  const tail = (of: string[], n: number) => of.slice(-n).join("/");
  const labels = new Map<string, string>();
  for (const [path, segments] of parts) {
    let depth = 1;
    while (
      depth < segments.length &&
      [...parts].some(
        ([other, theirs]) => other !== path && tail(theirs, depth) === tail(segments, depth),
      )
    ) {
      depth += 1;
    }
    labels.set(path, tail(segments, depth) || path);
  }
  return labels;
}

/**
 * The pane's title as a label, or "" when it says nothing the row doesn't.
 * Claude Code prefixes it with a spinner glyph that changes as it works.
 */
export function paneLabel(title: string | undefined, command: string): string {
  const text = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return text === command ? "" : text;
}

/** How recently an agent that titles nothing must have printed to count as
 * at work: its spinner redraws several times a second while it works, and
 * it falls quiet once it waits. Longer than the list's poll, so one quiet
 * moment between reads is not taken for a stop. */
export const ACTIVE_SECS = 5;

/** How long a session its hooks call working may go without printing before
 * it is taken for stopped: Claude Code runs no hook when Esc interrupts a
 * turn, so `working` outlives it. Its spinner and timer redraw for as long
 * as it really works, a slow tool included, so this only outlasts a stall. */
export const HOOKED_QUIET_SECS = 30;

/**
 * Whether the agent in the pane is at work. Best is what its own hooks said,
 * which Claude Code and Junie started by roer have, short of a `working` that
 * has gone quiet for too long to be true. Without them, Claude Code still says
 * so in its title: a braille spinner frame while it works, `✳` once it waits
 * for input. Any other agent is at work while it keeps printing. Never true
 * for a shell or anything else that is not an agent, whose output means
 * nothing of the kind.
 */
export function isWorking(session: SessionInfo, now = Date.now() / 1000): boolean {
  // A turn interrupted with Esc never says so; its silence does. The title
  // can lag a turn that has just begun, so it does not count against a hook.
  if (session.state === "working") return !session.activity || now - session.activity <= HOOKED_QUIET_SECS;
  if (session.state) return false;
  const title = session.title ?? "";
  if (/^[\u2801-\u28ff]/u.test(title)) return true;
  if (/^\u2733/u.test(title)) return false;
  if (!runningAgent(session)) return false;
  return !!session.activity && now - session.activity <= ACTIVE_SECS;
}

/** Whether all there is to go by is the agent's output: no hooks, and no
 * spinner or `✳` in its title. */
export function toldByOutput(session: SessionInfo): boolean {
  return !session.state && !/^[\u2801-\u28ff\u2733]/u.test(session.title ?? "");
}

/** Whether the agent is held up on you — a permission prompt, a question —
 * rather than done with its turn. Only its hooks can tell those apart. */
export function needsYou(session: SessionInfo): boolean {
  return session.state === "waiting";
}

/** Where a live row goes in its group: what is held up on you, what has
 * finished and waits, what is at work, then the rest, each in the order
 * tmux listed them. */
function liveRank(session: SessionInfo, waiting: ReadonlySet<string>): number {
  if (waiting.has(session.pane)) return needsYou(session) ? 0 : 1;
  return isWorking(session) ? 2 : 3;
}

/** The CLIs roer knows, by the command tmux reports for them. */
const AGENT_COMMANDS = new Set(["claude", "codex", "pi", "junie"]);

/** Who is running in the session, when that is known to be an agent: the one
 * roer started, which the shim names only while it runs, or a CLI started by
 * hand. `null` for anything else — a shell, an editor, a dev server —
 * nothing a prompt should ever be typed into. */
export function runningAgent(session: SessionInfo): string | null {
  if (session.agent) return session.agent;
  return AGENT_COMMANDS.has(session.command) ? session.command : null;
}


/** A live row's name: what the agent says it is doing, when it says, with
 * who is doing it beside it; otherwise just who. That is the agent roer
 * started, by the name it was saved under, while it runs — most agents never
 * title their pane, and a CLI runs as `node` as often as not — and the
 * command, named exactly as the terminal would show it, once only the shell
 * is left. The session's own name (`roer-2`) says only which directory it is
 * in, which the group headings show wherever there is more than one, so it
 * is left to the row's tooltip. */
function LiveName({ session }: { session: SessionInfo }) {
  const who = runningAgent(session) ?? session.command;
  const label = paneLabel(session.title, session.command);
  return label && label !== who ? (
    <>
      <strong>{label}</strong>
      <span className="muted">{who}</span>
    </>
  ) : (
    <strong>{who}</strong>
  );
}

/** Live rows in the order they matter: waiting, working, the rest. Past
 * conversations stay after them, as they were. */
function byRank(items: SessionEntry[], waiting: ReadonlySet<string>): SessionEntry[] {
  const rank = (entry: SessionEntry) => (entry.kind === "live" ? liveRank(entry.session, waiting) : 4);
  return items
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** What tells one row from the next without opening it: the branch, what
 * is uncommitted on it, and when the session last printed anything. */
function RowMeta({
  session,
  stats,
  worktree,
}: {
  session: SessionInfo;
  stats: DirStats | undefined;
  worktree: string | null;
}) {
  const parts: ReactNode[] = [];
  // What the checkout is on now, read again every so often: a session can
  // switch branch. A detached one goes by its commit, never the word, which
  // on a row says nobody holds the session. A linked worktree's folder only
  // when there is neither, and nothing at all outside a repository.
  const head = checkoutLabel(stats, worktree);
  if (head) {
    parts.push(
      <span key="head" className={worktree ? "worktree" : undefined} title={head.title}>
        {head.text}
      </span>,
    );
  }
  if (stats && stats.files > 0) {
    parts.push(
      <span key="changes" className="counts" title={`${stats.files} ${stats.files === 1 ? "file" : "files"} changed`}>
        <span className="plus">+{stats.added}</span> <span className="minus">−{stats.deleted}</span>
      </span>,
    );
  }
  if (session.activity) parts.push(<span key="age">{relativeAge(session.activity)}</span>);
  return parts.length > 0 ? <span className="row-meta">{parts}</span> : null;
}

/** What a row names its checkout by: its branch, else its commit, else a
 * linked worktree's folder; `null` with none of them. */
export function checkoutLabel(
  stats: DirStats | undefined,
  worktree: string | null,
): { text: string; title: string } | null {
  const where = worktree ? ` in the worktree ${worktree}` : "";
  if (stats?.branch && stats.branch !== "(detached)") return { text: stats.branch, title: `On ${stats.branch}${where}` };
  if (stats?.commit) return { text: stats.commit, title: `No branch: at commit ${stats.commit}${where}` };
  if (worktree) return { text: worktree, title: `In the worktree ${worktree}` };
  return null;
}

/** A linked worktree's folder name, for a row grouped with the main
 * checkout's; `null` in the main checkout or outside a repository. */
function worktreeName(repo: Repo | undefined): string | null {
  if (!repo || repo.root === repo.main) return null;
  return repo.root.replace(/\/+$/, "").split("/").pop() ?? repo.root;
}

/** How long ago a past conversation was last updated, roughly. */
export function relativeAge(updatedAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - updatedAt);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Groups items by their git root (falling back to the directory itself
 * outside a repository), preserving each group's first-seen order. Skipped
 * entirely — one flat group — when everything shares a root, so the common
 * single-project case shows no redundant heading.
 */
function groupByRoot<T>(
  items: T[],
  cwdOf: (item: T) => string,
  roots: Record<string, string>,
): Array<{ root: string | null; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const root = roots[cwdOf(item)] ?? cwdOf(item);
    const list = groups.get(root);
    if (list) {
      list.push(item);
    } else {
      groups.set(root, [item]);
    }
  }
  if (groups.size <= 1) {
    return [{ root: null, items }];
  }
  return [...groups.entries()].map(([root, items]) => ({ root, items }));
}

/** One row in the merged list: a live tmux session or a resumable Claude
 * conversation, tagged so a single group can render either kind. */
type SessionEntry =
  | { kind: "live"; session: SessionInfo }
  | { kind: "resume"; session: ClaudeSession };

/**
 * The explicit-assignment path a session or conversation outside any
 * attached Project still needs: right-click to put it in a Workspace (or
 * take it out), the same interaction the Workspace/Project rows themselves
 * use for rename/delete.
 */
function AssignMenu({
  sessionId,
  workspaces,
  assignedTo,
  handleAssign,
  onEnd,
  children,
}: {
  sessionId: string;
  workspaces: Workspace[];
  assignedTo: string | undefined;
  handleAssign: (sessionId: string, workspaceId: string | null) => void;
  /** A live session's End session; a past conversation has none. */
  onEnd?: () => void;
  children: ReactNode;
}) {
  if (workspaces.length === 0 && !assignedTo && !onEnd) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {workspaces.map((workspace) => (
          <ContextMenuItem
            key={workspace.id}
            disabled={assignedTo === workspace.id}
            onSelect={() => handleAssign(sessionId, workspace.id)}
          >
            Assign to {workspace.name}
          </ContextMenuItem>
        ))}
        {workspaces.length > 0 && assignedTo ? <ContextMenuSeparator /> : null}
        {assignedTo ? (
          <ContextMenuItem onSelect={() => handleAssign(sessionId, null)}>
            Remove from {workspaces.find((workspace) => workspace.id === assignedTo)?.name ?? "Workspace"}
          </ContextMenuItem>
        ) : null}
        {onEnd ? (
          <>
            {workspaces.length > 0 || assignedTo ? <ContextMenuSeparator /> : null}
            <ContextMenuItem variant="destructive" onSelect={onEnd}>
              End session…
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export type SessionBrowserProps = Pick<
  SessionBrowserState,
  | "status"
  | "workspaces"
  | "projects"
  | "assignments"
  | "selectedWorkspace"
  | "selectedWorkspaceProjects"
  | "handleAssign"
  | "handleAttachExistingProject"
  | "handleAttachNewProject"
  | "handleDetachProject"
  | "addingItem"
  | "setAddingItem"
  | "itemTitle"
  | "setItemTitle"
  | "handleAddItem"
  | "handleRemoveItem"
  | "roots"
  | "repos"
  | "waiting"
  | "stats"
  | "handleEndSession"
  | "visibleSessions"
  | "visibleClaudeSessions"
  | "activePane"
  | "openClaudeSession"
  | "refresh"
> & {
  onOpen: (request: OpenRequest) => void;
};

/**
 * The right side: the sessions and Claude conversations the selected
 * Workspace (or Project) filters to, plus its attached Projects and generic
 * items. Which Workspace is selected lives in the sidebar; this is
 * everything that selection changes.
 */
export function SessionBrowser({
  status,
  workspaces,
  projects,
  assignments,
  selectedWorkspace,
  selectedWorkspaceProjects,
  handleAssign,
  handleAttachExistingProject,
  handleAttachNewProject,
  handleDetachProject,
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
  visibleSessions,
  visibleClaudeSessions,
  activePane,
  openClaudeSession,
  refresh,
  onOpen,
}: SessionBrowserProps) {
  const attachableProjects: Project[] = selectedWorkspace
    ? projects.filter((project) => !selectedWorkspace.projects.includes(project.id))
    : [];

  const attachNewProject = async () => {
    // Resolves to a plain path, or `null` when the dialog was dismissed —
    // nothing to do either way but let it settle.
    const picked = await pickFolder();
    if (typeof picked === "string") handleAttachNewProject(picked);
  };

  // One list, one heading per root — a running session and a resumable
  // conversation in the same repo are both just "Roer here", not two
  // differently-worded things.
  const entries: SessionEntry[] = [
    ...visibleSessions.map((session): SessionEntry => ({ kind: "live", session })),
    ...visibleClaudeSessions.map((session): SessionEntry => ({ kind: "resume", session })),
  ];
  const groups = groupByRoot(entries, (entry: SessionEntry) => entry.session.cwd, roots);
  const headings = distinctLabels(groups.flatMap((group) => (group.root ? [group.root] : [])));

  return (
    <nav className="sessions-view" aria-label="Sessions">
      <h2>
        Sessions
        <button type="button" className="link" onClick={() => void refresh()}>
          Refresh
        </button>
      </h2>

      {visibleSessions.length === 0 && visibleClaudeSessions.length === 0 ? (
        <p className="muted">
          {selectedWorkspace ? (
            "Nothing running in this Workspace's projects yet."
          ) : (
            <>
              Nothing running yet. Start one here, or run <code>roer</code> in a terminal and
              teleport it over with the skill.
            </>
          )}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.root ?? "sessions"}>
            {group.root ? (
              <h3 className="group" title={shorten(group.root, status?.home)}>
                {headings.get(group.root)}
              </h3>
            ) : null}
            <ul>
              {byRank(group.items, waiting).map((entry) =>
                entry.kind === "live" ? (
                  <li key={`live-${entry.session.pane}`}>
                    <AssignMenu
                      sessionId={entry.session.id}
                      workspaces={workspaces}
                      assignedTo={assignments[entry.session.id]}
                      handleAssign={handleAssign}
                      onEnd={() => handleEndSession(entry.session)}
                    >
                      <span className="workspace-row">
                        <button
                          type="button"
                          className={entry.session.pane === activePane ? "row active" : "row"}
                          aria-current={entry.session.pane === activePane ? "true" : undefined}
                          title={`${entry.session.session} — ${shorten(entry.session.cwd, status?.home)}`}
                          onClick={() =>
                            onOpen({
                              args: ["attach", entry.session.pane],
                              cwd: entry.session.cwd,
                              title: entry.session.session,
                              pane: entry.session.pane,
                            })
                          }
                        >
                          <LiveName session={entry.session} />
                          <RowMeta
                            session={entry.session}
                            stats={stats[entry.session.cwd]}
                            worktree={worktreeName(repos[entry.session.cwd])}
                          />
                          {entry.session.pane === activePane ? null : isWorking(entry.session) ? (
                            <span className="badge working">working</span>
                          ) : waiting.has(entry.session.pane) ? (
                            needsYou(entry.session) ? (
                              <span className="badge needs" title={entry.session.note || undefined}>
                                needs you
                              </span>
                            ) : (
                              <span className="badge waiting">waiting</span>
                            )
                          ) : null}
                          {/* Attaching takes a session over from whoever holds it,
                              which may be a terminal or another window of this app. */}
                          <span
                            className={
                              entry.session.pane === activePane
                                ? "badge here"
                                : entry.session.attached
                                  ? "badge held"
                                  : "badge free"
                            }
                          >
                            {entry.session.pane === activePane
                              ? "open here"
                              : entry.session.attached
                                ? "attached"
                                : "detached"}
                          </span>
                        </button>
                      </span>
                    </AssignMenu>
                  </li>
                ) : (
                  <li key={`resume-${entry.session.id}`}>
                    <AssignMenu
                      sessionId={entry.session.id}
                      workspaces={workspaces}
                      assignedTo={assignments[entry.session.id]}
                      handleAssign={handleAssign}
                    >
                      <span className="workspace-row">
                        <button
                          type="button"
                          className="row"
                          onClick={() => openClaudeSession(entry.session)}
                        >
                          <strong>{entry.session.title}</strong>
                          {/* Named the same way live rows name themselves: the
                              agent that will run, not an icon for it. */}
                          <span className="muted">{entry.session.agent ?? "claude"}</span>
                          <span className="badge resume">{relativeAge(entry.session.updatedAt)}</span>
                      </button>
                    </span>
                    </AssignMenu>
                  </li>
                ),
              )}
            </ul>
          </div>
        ))
      )}

      {selectedWorkspace ? (
        <>
          <h2 className="muted">
            Projects
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="link">
                  Attach project
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {attachableProjects.length > 0 ? (
                  <>
                    {attachableProjects.map((project) => (
                      <DropdownMenuItem
                        key={project.id}
                        onSelect={() => handleAttachExistingProject(project.id)}
                      >
                        {project.name}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem onSelect={() => void attachNewProject()}>
                  Attach a new project…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </h2>

          {selectedWorkspaceProjects.length === 0 ? (
            <p className="muted">No projects attached yet.</p>
          ) : (
            <ul>
              {selectedWorkspaceProjects.map((project) => (
                <li key={project.id}>
                  <span className="workspace-row">
                    <span className="workspace-item" title={project.path}>
                      <strong>{project.name}</strong>
                      <span className="muted">{shorten(project.path, status?.home)}</span>
                    </span>
                    <button
                      type="button"
                      className="tab-x"
                      aria-label={`Detach ${project.name}`}
                      onClick={() => handleDetachProject(project.id)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {/* A generic slot for anything else this Workspace is about — a
          tracker task today, other kinds later. No kind-specific UI yet. */}
      {selectedWorkspace ? (
        <>
          <h2 className="muted">
            Items
            <button type="button" className="link" onClick={() => setAddingItem((open) => !open)}>
              {addingItem ? "Cancel" : "Add item"}
            </button>
          </h2>

          {addingItem ? (
            <div className="workspace-form">
              <input
                type="text"
                className="workspace-input"
                placeholder="Title"
                value={itemTitle}
                onChange={(event) => setItemTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleAddItem();
                  if (event.key === "Escape") setAddingItem(false);
                }}
                autoFocus
              />
              <button type="button" className="primary" disabled={!itemTitle.trim()} onClick={handleAddItem}>
                Add
              </button>
            </div>
          ) : null}

          {selectedWorkspace.items.length === 0 ? (
            <p className="muted">No items yet.</p>
          ) : (
            <ul>
              {selectedWorkspace.items.map((item) => (
                <li key={item.id}>
                  <span className="workspace-row">
                    <span className="workspace-item">
                      <strong>{item.title}</strong>
                      <span className="badge resume">{item.kind}</span>
                    </span>
                    <button
                      type="button"
                      className="tab-x"
                      aria-label={`Remove ${item.title}`}
                      onClick={() =>
                        void confirmAction(`Remove "${item.title}"?`, "Remove item").then(
                          (confirmed) => confirmed && handleRemoveItem(item.id),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </nav>
  );
}
