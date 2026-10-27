import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { buildTree, checkoutName, folderLabel, type TreeCheckout, type TreeProject } from "./lib/checkouts";
import { useHeldRequests } from "./lib/askAgent";
import { useFolded } from "./lib/folded";
import type { Repo } from "./lib/git";
import type { Project } from "./lib/projects";
import type { SessionInfo } from "./lib/pty";
import type { SessionBrowserState } from "./lib/useSessionBrowser";
import type { Worktree } from "./lib/worktrees";
import {
  AssignMenu,
  isWorking,
  LiveName,
  liveRank,
  needsYou,
  rowNote,
  paneLabel,
  runningAgent,
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

/**
 * A Project's checkouts in the order they matter: the main one first, then
 * the worktrees with sessions, those with one waiting on you first, each
 * group by the session opened most recently, then the worktrees with none
 * in git's order. An agent starting or finishing work moves nothing: rows
 * that jumped on every turn would move under the pointer.
 */
export const busiestFirst =
  (waiting: ReadonlySet<string>) =>
  (checkouts: TreeCheckout<SessionInfo>[]): TreeCheckout<SessionInfo>[] => {
    const waits = (checkout: TreeCheckout<SessionInfo>) => checkout.items.some((session) => waiting.has(session.pane));
    const opened = (checkout: TreeCheckout<SessionInfo>) => Math.max(0, ...checkout.items.map((session) => session.opened ?? 0));
    return checkouts
      .map((checkout, index) => ({ checkout, index }))
      .sort((a, b) => {
        if (a.checkout.worktree.main !== b.checkout.worktree.main) return a.checkout.worktree.main ? -1 : 1;
        const used = (a.checkout.items.length > 0 ? 0 : 1) - (b.checkout.items.length > 0 ? 0 : 1);
        if (used !== 0 || a.checkout.items.length === 0) return used || a.index - b.index;
        return (
          Number(waits(b.checkout)) - Number(waits(a.checkout)) ||
          opened(b.checkout) - opened(a.checkout) ||
          a.index - b.index
        );
      })
      .map(({ checkout }) => checkout);
  };

/** The tree as the sidebar shows it: sessions by `byLiveRank`, checkouts by
 * `busiestFirst`. */
export function orderTree(
  projects: Project[],
  worktrees: Record<string, Worktree[]>,
  repos: Record<string, Repo>,
  sessions: SessionInfo[],
  waiting: ReadonlySet<string>,
  folder?: string,
) {
  const built = buildTree(projects, worktrees, repos, sessions, (session) => session.cwd, byLiveRank(waiting), folder);
  return { ...built, projects: built.projects.map((node) => ({ ...node, checkouts: busiestFirst(waiting)(node.checkouts) })) };
}

/** Whether every word of `query` is in `text`, ignoring case: "roer fix"
 * finds the fix-login worktree of roer. */
export function matches(query: string, ...text: string[]): boolean {
  const hay = text.join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** What a session row is found by: what it is called, who runs in it, and
 * its tmux session's name. */
const sessionText = (session: SessionInfo): string =>
  [paneLabel(session.title, session.command), runningAgent(session) ?? session.command, session.session].join(" ");

/**
 * The tree cut down to what `query` finds, each session by its own text with
 * its Project's and checkout's names, so a Project's or a branch's name finds
 * every session in it. A checkout with no sessions stays when its own names
 * match, so a worktree can be found to start one in.
 */
export function filterTree<Tree extends { projects: TreeProject<SessionInfo>[]; inFolder: SessionInfo[]; elsewhere: SessionInfo[] }>(
  tree: Tree,
  query: string,
  /** The Workspace's folder, as its group is headed, when it has one. */
  folderName?: string | false,
): Tree {
  if (!query.trim()) return tree;
  const projects = tree.projects
    .map((node) => ({
      ...node,
      checkouts: node.checkouts
        .map((checkout) => {
          const names = [node.project.name, checkoutName(checkout.worktree)];
          const items = checkout.items.filter((session) => matches(query, ...names, sessionText(session)));
          return items.length > 0 || (checkout.items.length === 0 && matches(query, ...names))
            ? { ...checkout, items }
            : null;
        })
        .filter((checkout): checkout is TreeCheckout<SessionInfo> => checkout !== null),
    }))
    .filter((node) => node.checkouts.length > 0);
  return {
    ...tree,
    projects,
    inFolder: tree.inFolder.filter((session) => matches(query, folderName || "", sessionText(session))),
    elsewhere: tree.elsewhere.filter((session) => matches(query, sessionText(session))),
  };
}

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
  | "folderInView"
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
  folderInView,
  projects,
  onOpen,
}: SessionTreeProps) {
  const ordered = orderTree(projects, worktrees, repos, visibleSessions, waiting, folderInView);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const tree = filterTree(ordered, query, folderInView && folderLabel(folderInView));
  const home = status?.home;
  const [savedFolds, toggleSavedFold] = useFolded("roer:folded-tree");
  // A search looks inside folded Projects and branches too, and leaves the
  // folds as they were for when it is cleared.
  const folded: ReadonlySet<string> = searching ? new Set() : savedFolds;
  const heldByPane = useHeldRequests();
  const toggleFold = (key: string) => {
    if (!searching) toggleSavedFold(key);
  };

  // The rows a search can step through, in the order they are shown.
  const found = [
    ...tree.projects.flatMap((node) => node.checkouts.flatMap((checkout) => checkout.items)),
    ...tree.inFolder,
    ...tree.elsewhere,
  ];
  // A search hides the Workspace's folder when nothing in it matches.
  const showFolder = !!folderInView && (!searching || tree.inFolder.length > 0);
  // The match Enter opens, by its pane, so a poll that reorders the list
  // keeps it: the first match until the arrows pick another.
  const [picked, setPicked] = useState<string | null>(null);
  const pickedAt = Math.max(0, found.findIndex((session) => session.pane === picked));
  const pickedPane = searching ? found[pickedAt]?.pane : undefined;
  const searchRef = useRef<HTMLInputElement>(null);

  const openSession = (session: SessionInfo) =>
    onOpen({ args: ["attach", session.pane], cwd: session.cwd, title: session.session, pane: session.pane });

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (found.length > 0) setPicked(found[(pickedAt + step + found.length) % found.length].pane);
    } else if (event.key === "Enter") {
      const session = searching ? found[pickedAt] : undefined;
      if (session) {
        event.preventDefault();
        setQuery("");
        openSession(session);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      event.currentTarget.blur();
    }
  };

  // Speed search: typing while a row has the keyboard goes to the search.
  // Not from a menu a row opened: it is in a portal, outside the tree's
  // own elements, and its typeahead is its own.
  const onTreeKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target === searchRef.current || !event.currentTarget.contains(event.target as Node)) return;
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey || event.key === " ") return;
    event.preventDefault();
    setQuery((current) => current + event.key);
    setPicked(null);
    searchRef.current?.focus();
  };

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
    // What it waits on, or how its turn ended, under its name: only while it waits and is out of sight.
    const note = !here && (state === "needs" || state === "waiting") ? rowNote(session) : null;
    const classes = [
      "tree-session",
      here ? "active" : "",
      session.pane === pickedPane ? "picked" : "",
      note ? "noted" : "",
    ].filter(Boolean);
    const held = heldByPane.get(session.pane) ?? [];
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
            className={classes.join(" ")}
            aria-current={here ? "true" : undefined}
            title={`${session.session} — ${shorten(session.cwd, home)}`}
            onClick={() => openSession(session)}
          >
            <span className="row-line">
            <span className={`tree-dot ${state}`} aria-hidden="true" />
            <LiveName session={session} />
            {STATUS_WORDS[state] && !here ? <span className={`tree-state ${state}`}>{STATUS_WORDS[state]}</span> : null}
            {held.length > 0 ? (
              <span
                className="tree-state held"
                title={`Waiting to be sent to its agent: ${held.map((request) => request.label).join("; ")}. Open the session, then + in the tab strip to send or cancel.`}
              >
                {held.length === 1 ? "1 queued" : `${held.length} queued`}
              </span>
            ) : null}
            </span>
            {note ? (
              <span className="tree-note" title={note}>
                {note}
              </span>
            ) : null}
          </button>
        </AssignMenu>
      </li>
    );
  };

  const checkout = ({ worktree, items: sessions }: TreeCheckout<SessionInfo>, name = checkoutName(worktree)) => {
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
    <section className="session-tree" aria-label="Running sessions" onKeyDown={onTreeKey}>
      <h2>
        Sessions
        {projects.length > 0 ? (
          <button type="button" className="link" onClick={() => openNewWorktree()}>
            New worktree
          </button>
        ) : null}
      </h2>
      {visibleSessions.length > 0 || projects.length > 0 || folderInView || query ? (
        <input
          ref={searchRef}
          type="search"
          className="tree-search"
          aria-label="Find a session"
          placeholder="Find a session, branch or project"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPicked(null);
          }}
          onKeyDown={onSearchKey}
        />
      ) : null}
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
          {folded.has(`project-${node.project.id}`) ? null : <ul>{node.checkouts.map((each) => checkout(each))}</ul>}
        </div>
      ))}
      {/* The Workspace's own folder, shaped as a Project with one checkout:
        what runs there runs across its repositories. */}
      {folderInView && showFolder ? (
        <div className="tree-project">
          <h3 className="tree-project-head" title={shorten(folderInView, home)}>
            {fold("folder", folderLabel(folderInView), tree.inFolder, "tree-project-name")}
          </h3>
          {folded.has("folder") ? null : (
            <ul>
              {checkout(
                {
                  worktree: { path: folderInView, branch: null, commit: "", main: true, base: null, locked: false, missing: false },
                  items: tree.inFolder,
                },
                "all projects",
              )}
            </ul>
          )}
        </div>
      ) : null}
      {tree.elsewhere.length > 0 ? (
        <div className="tree-project">
          {tree.projects.length > 0 || showFolder ? <h3>Elsewhere</h3> : null}
          <ul className="tree-loose">{tree.elsewhere.map(row)}</ul>
        </div>
      ) : null}
      {tree.projects.length === 0 && !showFolder && tree.elsewhere.length === 0 ? (
        <p className="muted">{searching ? `Nothing matches “${query.trim()}”.` : "Nothing running yet."}</p>
      ) : null}
    </section>
  );
}
