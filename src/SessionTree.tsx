import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { ReactNode } from "react";

import { buildTree, checkoutName, type TreeCheckout } from "./lib/checkouts";
import { useFolded } from "./lib/folded";
import type { Project } from "./lib/projects";
import type { SessionInfo } from "./lib/pty";
import type { SessionBrowserState } from "./lib/useSessionBrowser";
import {
  AssignMenu,
  isWorking,
  LiveName,
  liveRank,
  needsYou,
  shorten,
  type OpenRequest,
} from "./SessionBrowser";

/** Live sessions in the order they matter: waiting, working, the rest, each
 * the most recently opened first. */
export const byLiveRank =
  (waiting: ReadonlySet<string>) =>
  (list: SessionInfo[]): SessionInfo[] =>
    list
      .map((session, index) => ({ session, index }))
      .sort(
        (a, b) =>
          liveRank(a.session, waiting) - liveRank(b.session, waiting) ||
          (b.session.opened ?? 0) - (a.session.opened ?? 0) ||
          a.index - b.index,
      )
      .map(({ session }) => session);

/** What a session is up to, as the dot before its name says it. */
function statusOf(session: SessionInfo, waiting: ReadonlySet<string>): "needs" | "waiting" | "working" | "idle" {
  if (waiting.has(session.pane)) return needsYou(session) ? "needs" : "waiting";
  return isWorking(session) ? "working" : "idle";
}

const STATUS_WORDS = { needs: "needs you", waiting: "waiting", working: "working", idle: "" } as const;

export type SessionTreeProps = Pick<
  SessionBrowserState,
  | "status"
  | "workspaces"
  | "assignments"
  | "handleAssign"
  | "handleEndSession"
  | "waiting"
  | "repos"
  | "stats"
  | "visibleSessions"
  | "activePane"
  | "worktrees"
  | "openNewWorktree"
  | "openInWorktree"
  | "openPickAgent"
  | "handleRemoveWorktree"
> & {
  /** The Projects in view, whose checkouts the tree is made of. */
  projects: Project[];
  onOpen: (request: OpenRequest) => void;
};

/**
 * The left column's list of live sessions, always in sight beside the
 * stage: by Project, then by checkout — the main one and each worktree —
 * then the sessions running in it, so switching between agents never means
 * leaving the terminal. Past conversations stay on the Workspace tab, which
 * has room for them.
 */
export function SessionTree({
  status,
  workspaces,
  assignments,
  handleAssign,
  handleEndSession,
  waiting,
  repos,
  stats,
  visibleSessions,
  activePane,
  worktrees,
  openNewWorktree,
  openInWorktree,
  openPickAgent,
  handleRemoveWorktree,
  projects,
  onOpen,
}: SessionTreeProps) {
  const tree = buildTree(projects, worktrees, repos, visibleSessions, (session) => session.cwd, byLiveRank(waiting));
  const home = status?.home;
  const [folded, toggleFold] = useFolded("roer:folded-tree");

  /** A fold toggle for a project or branch, and what it hides once folded:
   * how many sessions, and whether one of them waits on you. */
  const fold = (key: string, label: ReactNode, hidden: SessionInfo[], className: string) => {
    const open = !folded.has(key);
    const waits = hidden.some((session) => waiting.has(session.pane));
    return (
      <>
        <button type="button" className={`fold ${className}`} aria-expanded={open} onClick={() => toggleFold(key)}>
          {open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
          <span className="fold-label">{label}</span>
        </button>
        {open || hidden.length === 0 ? null : (
          <span className="fold-count" title={`${hidden.length} hidden`}>
            {hidden.length}
            {waits ? (
              <>
                <span className="fold-dot" aria-hidden="true" />
                <span className="sr-only">, one waiting</span>
              </>
            ) : null}
          </span>
        )}
      </>
    );
  };

  const row = (session: SessionInfo) => {
    const state = statusOf(session, waiting);
    const here = session.pane === activePane;
    return (
      <li key={session.pane}>
        <AssignMenu
          sessionId={session.id}
          workspaces={workspaces}
          assignedTo={assignments[session.id]}
          handleAssign={handleAssign}
          onEnd={() => handleEndSession(session)}
        >
          <button
            type="button"
            className={here ? "tree-session active" : "tree-session"}
            aria-current={here ? "true" : undefined}
            title={`${session.session} — ${shorten(session.cwd, home)}`}
            onClick={() =>
              onOpen({ args: ["attach", session.pane], cwd: session.cwd, title: session.session, pane: session.pane })
            }
          >
            <span className={`tree-dot ${state}`} aria-hidden="true" />
            <LiveName session={session} />
            {STATUS_WORDS[state] && !here ? <span className={`tree-state ${state}`}>{STATUS_WORDS[state]}</span> : null}
          </button>
        </AssignMenu>
      </li>
    );
  };

  const checkout = ({ worktree, items: sessions }: TreeCheckout<SessionInfo>) => {
    const name = checkoutName(worktree);
    const changes = stats[worktree.path] ?? sessions.map((session) => stats[session.cwd]).find(Boolean);
    return (
      <li key={worktree.path} className={sessions.length === 0 ? "tree-checkout idle" : "tree-checkout"}>
        <div className="tree-checkout-head" title={shorten(worktree.path, home)}>
          {sessions.length > 0 ? (
            fold(`checkout-${worktree.path}`, name, sessions, worktree.main ? "tree-branch" : "tree-branch linked")
          ) : (
            <span className={worktree.main ? "tree-branch unfoldable" : "tree-branch linked unfoldable"}>{name}</span>
          )}
          {changes && changes.files > 0 ? (
            <span className="counts">
              <span className="plus">+{changes.added}</span> <span className="minus">−{changes.deleted}</span>
            </span>
          ) : null}
          <button
            type="button"
            className="tree-action"
            aria-label={`Start a session in ${name}`}
            title={`Start a session in ${shorten(worktree.path, home)} (with ⌥, pick the agent)`}
            onClick={(event) => (event.altKey ? openPickAgent(worktree.path) : openInWorktree(worktree))}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
          {!worktree.main && !worktree.locked ? (
            <button
              type="button"
              className="tree-action"
              aria-label={`Remove the worktree ${name}`}
              title="Remove this worktree"
              onClick={() => handleRemoveWorktree(worktree)}
            >
              ×
            </button>
          ) : null}
        </div>
        {sessions.length > 0 && !folded.has(`checkout-${worktree.path}`) ? <ul>{sessions.map(row)}</ul> : null}
      </li>
    );
  };

  return (
    <section className="session-tree" aria-label="Running sessions">
      <h2>
        Sessions
        {projects.length > 0 ? (
          <button type="button" className="link" onClick={() => openNewWorktree()}>
            New worktree
          </button>
        ) : null}
      </h2>
      {tree.projects.map((node) => (
        <div key={node.project.id} className="tree-project">
          <h3 className="tree-project-head" title={shorten(node.project.path, home)}>
            {fold(
              `project-${node.project.id}`,
              node.project.name,
              node.checkouts.flatMap((checkout) => checkout.items),
              "tree-project-name",
            )}
          </h3>
          {folded.has(`project-${node.project.id}`) ? null : <ul>{node.checkouts.map(checkout)}</ul>}
        </div>
      ))}
      {tree.elsewhere.length > 0 ? (
        <div className="tree-project">
          {tree.projects.length > 0 ? <h3>Elsewhere</h3> : null}
          <ul className="tree-loose">{tree.elsewhere.map(row)}</ul>
        </div>
      ) : null}
      {tree.projects.length === 0 && tree.elsewhere.length === 0 ? (
        <p className="muted">Nothing running yet.</p>
      ) : null}
    </section>
  );
}
