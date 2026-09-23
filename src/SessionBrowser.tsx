import { open } from "@tauri-apps/plugin-dialog";
import type { ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "./lib/projects";
import type { ClaudeSession, SessionInfo } from "./lib/pty";
import type { SessionBrowserState } from "./lib/useSessionBrowser";
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
function shorten(cwd: string, home: string | undefined): string {
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
 * The session name without the shim's path hash: `roer-daf2-2` is `roer-2`.
 * The hash only keeps same-named directories apart in tmux, and the group
 * heading already does that here.
 */
export function shortSessionName(name: string): string {
  return name.replace(/^(.+)-[0-9a-f]{4}(?=-|$)/, "$1");
}

/**
 * The pane's title as a label, or "" when it says nothing the row doesn't.
 * Claude Code prefixes it with a spinner glyph that changes as it works.
 */
export function paneLabel(title: string | undefined, command: string): string {
  const text = (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return text === command ? "" : text;
}

/** A live row's name: what the agent says it is doing, when it says, with
 * the session's own name beside it; otherwise just the session's name. */
function LiveName({ session }: { session: SessionInfo }) {
  const label = paneLabel(session.title, session.command);
  const name = shortSessionName(session.session);
  return label ? (
    <>
      <strong>{label}</strong>
      <span className="muted">{name}</span>
    </>
  ) : (
    <strong>{name}</strong>
  );
}

/** How long ago a Claude conversation was last updated, roughly. */
function relativeAge(updatedAt: number): string {
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
  children,
}: {
  sessionId: string;
  workspaces: Workspace[];
  assignedTo: string | undefined;
  handleAssign: (sessionId: string, workspaceId: string | null) => void;
  children: ReactNode;
}) {
  if (workspaces.length === 0 && !assignedTo) return <>{children}</>;
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
          <ContextMenuItem onSelect={() => handleAssign(sessionId, null)}>Unassign</ContextMenuItem>
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
 * Workspace (or "All") filters to, plus its attached Projects and generic
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
    // `open` resolves to a plain path on directory mode, or `null` when the
    // dialog was dismissed — nothing to do either way but let it settle.
    const picked = await open({ directory: true, multiple: false });
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
              {group.items.map((entry) =>
                entry.kind === "live" ? (
                  <li key={`live-${entry.session.pane}`}>
                    <AssignMenu
                      sessionId={entry.session.id}
                      workspaces={workspaces}
                      assignedTo={assignments[entry.session.id]}
                      handleAssign={handleAssign}
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
                          {/* Named exactly as the terminal would show it: the
                              command running in the pane. */}
                          <span className="muted">{entry.session.command}</span>
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
                                : "idle"}
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
                          <span className="muted">claude</span>
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
                      onClick={() => handleRemoveItem(item.id)}
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
