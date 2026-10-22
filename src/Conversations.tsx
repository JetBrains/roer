import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { checkoutName, within } from "./lib/checkouts";
import type { Repo } from "./lib/git";
import type { Project } from "./lib/projects";
import { searchClaudeSessions, type ClaudeSession } from "./lib/pty";
import type { Workspace } from "./lib/workspaces";
import type { Worktree } from "./lib/worktrees";
import { AssignMenu, relativeAge, shorten } from "./SessionBrowser";

/** How many of a bucket show before "Show N more". */
const SHOWN = 10;
/** How long typing has to pause before what was said is searched. */
const DEBOUNCE_MS = 200;

const BUCKETS = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"] as const;
type Bucket = (typeof BUCKETS)[number];

/** Which part of the timeline a conversation last updated at `updatedAt`
 * sits in, by the local calendar day. Both in seconds since the epoch. */
export function bucketOf(updatedAt: number, now: number): Bucket {
  const today = new Date(now * 1000);
  today.setHours(0, 0, 0, 0);
  const days = (when: number) => {
    const day = new Date(when * 1000);
    day.setHours(0, 0, 0, 0);
    return Math.round((today.getTime() - day.getTime()) / 86_400_000);
  };
  const ago = days(updatedAt);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago < 7) return "Previous 7 days";
  if (ago < 30) return "Previous 30 days";
  return "Older";
}

/** Whether every word of the query is in the conversation's name, folder or
 * branch: what can be told without reading what was said. */
function matchesPlace(conversation: ClaudeSession, terms: string[]): boolean {
  const place = `${conversation.title}\n${conversation.cwd}\n${conversation.branch ?? ""}`.toLowerCase();
  return terms.every((term) => place.includes(term));
}

/** `text` with each occurrence of any of `terms` (already lower case)
 * marked, for the snippet of what matched. */
function marked(text: string, terms: string[]): ReactNode[] {
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return [text];
  return text
    .split(new RegExp(`(${escaped.join("|")})`, "gi"))
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}

export interface ConversationsProps {
  /** What is in view, most recently updated first. */
  conversations: ClaudeSession[];
  /** Everywhere they were looked for, which is where a search looks. */
  cwds: string[];
  repos: Record<string, Repo>;
  /** Each Project in view's checkouts, by the Project's path. */
  worktrees: Record<string, Worktree[]>;
  /** The Projects in view: with more than one, a row says which it is in. */
  projects: Project[];
  home: string | undefined;
  workspaces: Workspace[];
  assignments: Record<string, string>;
  handleAssign: (sessionId: string, workspaceId: string | null) => void;
  onOpen: (conversation: ClaudeSession) => void;
}

/**
 * Past conversations as a timeline, with a filter over their names, folders,
 * branches and what was said in them. People come back to a conversation by
 * what it was about and when, more than by which checkout it was had in, and
 * with a project's worth of them a list per checkout is not one you can scan.
 */
export function Conversations({
  conversations,
  cwds,
  repos,
  worktrees,
  projects,
  home,
  workspaces,
  assignments,
  handleAssign,
  onOpen,
}: ConversationsProps) {
  const [query, setQuery] = useState("");
  // The latest answer, to the query it was for: by id, what matched.
  const [answer, setAnswer] = useState<{ query: string; hits: Map<string, string | undefined> } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<Bucket>>(new Set());
  const asked = useRef(0);
  const cwdsKey = cwds.join("\n");
  const ids = useId();

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const termsKey = terms.join(" ");

  useEffect(() => {
    const request = ++asked.current;
    if (!termsKey) {
      setAnswer(null);
      return;
    }
    const timer = window.setTimeout(() => {
      searchClaudeSessions(cwdsKey ? cwdsKey.split("\n") : [], termsKey)
        .then((hits) => {
          if (request === asked.current) setAnswer({ query: termsKey, hits: new Map(hits.map((hit) => [hit.id, hit.snippet])) });
        })
        .catch(() => {
          if (request === asked.current) setFailed(termsKey);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [termsKey, cwdsKey]);

  // A new query starts the days folded again; a list read again does not.
  useEffect(() => setUnfolded(new Set()), [termsKey]);

  const filtering = terms.length > 0;
  // While a query that only adds to the last one is asked, the last answer
  // stands, as everything the new one finds is in it: rows do not come and
  // go with each key typed.
  const found =
    answer && (answer.query === termsKey || termsKey.startsWith(answer.query)) ? answer.hits : null;
  const searching = filtering && answer?.query !== termsKey && failed !== termsKey;
  // While what was said is being searched, what the name, folder and branch
  // already say shows at once; the search then adds what only the text has.
  const shown = filtering
    ? conversations.filter((conversation) => found?.has(conversation.id) || matchesPlace(conversation, terms))
    : conversations;

  const now = Date.now() / 1000;
  const buckets = new Map<Bucket, ClaudeSession[]>();
  for (const conversation of shown) {
    const bucket = bucketOf(conversation.updatedAt, now);
    const list = buckets.get(bucket);
    if (list) list.push(conversation);
    else buckets.set(bucket, [conversation]);
  }

  const projectOf = (cwd: string) =>
    projects.length > 1
      ? projects.find((project) => {
          const main = repos[cwd]?.main;
          return within(cwd, project.path) || (main != null && main === repos[project.path]?.main);
        })
      : undefined;

  // The checkout a conversation was had in: the deepest one its folder is in.
  const checkouts = Object.values(worktrees).flat();
  const checkoutOf = (cwd: string) =>
    checkouts
      .filter((checkout) => within(cwd, checkout.path))
      .sort((a, b) => b.path.length - a.path.length)[0];

  const row = (conversation: ClaudeSession) => {
    // The branch it was on, which is what it was about; else the checkout's
    // name, or a linked worktree's folder.
    const repo = repos[conversation.cwd];
    const checkout = checkoutOf(conversation.cwd);
    const linked = checkout ? !checkout.main : repo != null && repo.root !== repo.main;
    const where =
      conversation.branch ?? (checkout ? checkoutName(checkout) : linked ? repo?.root.split("/").pop() : undefined);
    const project = projectOf(conversation.cwd);
    const snippet = found?.get(conversation.id);
    const badge = `${ids}-${conversation.id}-badge`;
    const said = `${ids}-${conversation.id}-said`;
    const described = [conversation.openElsewhere ? badge : null, snippet ? said : null].filter(Boolean).join(" ");
    return (
      <li key={`resume-${conversation.id}`}>
        <AssignMenu
          sessionId={conversation.id}
          workspaces={workspaces}
          assignedTo={assignments[conversation.id]}
          handleAssign={handleAssign}
        >
          <span className="workspace-row">
            <button
              type="button"
              className="row conversation"
              aria-label={`Resume ${conversation.title}`}
              aria-describedby={described || undefined}
              title={shorten(conversation.cwd, home)}
              onClick={() => onOpen(conversation)}
            >
              <span className="conversation-line">
                <strong>{conversation.title}</strong>
                <span className="row-meta">
                  {project ? <span>{project.name}</span> : null}
                  {where ? (
                    <span className={linked ? "worktree" : undefined} title={where}>
                      {where}
                    </span>
                  ) : null}
                  {/* Named the same way live rows name themselves: the agent
                      that will run, not an icon for it. */}
                  <span>{conversation.agent ?? "claude"}</span>
                </span>
                {conversation.openElsewhere ? (
                  <span id={badge} className="badge held" title="A CLI outside Roer has this conversation open">
                    open elsewhere
                  </span>
                ) : null}
                <span className="badge resume">{relativeAge(conversation.updatedAt)}</span>
              </span>
              {snippet ? (
                <span id={said} className="conversation-snippet">
                  {marked(snippet, terms)}
                </span>
              ) : null}
            </button>
          </span>
        </AssignMenu>
      </li>
    );
  };

  const count = filtering ? `${shown.length} of ${conversations.length}` : `${conversations.length}`;

  return (
    <section className="conversations" aria-label="Conversations">
      <h2>
        <span>
          Conversations <span className="conversations-count">{count}</span>
        </span>
        {searching ? <span className="conversations-status">Searching…</span> : null}
      </h2>
      {conversations.length === 0 ? (
        <p className="muted">No past conversations here yet.</p>
      ) : (
        <>
          <div className="conversations-filter">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              aria-label="Filter conversations"
              placeholder="Filter by name, folder, branch or what was said…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
            />
          </div>
          {failed === termsKey && filtering ? <p className="muted">Could not search what was said; matching names, folders and branches only.</p> : null}
          {shown.length === 0 && !searching ? <p className="muted">Nothing matches “{query.trim()}”.</p> : null}
          {BUCKETS.filter((bucket) => buckets.has(bucket)).map((bucket) => {
            const list = buckets.get(bucket) ?? [];
            const open = unfolded.has(bucket) ? list : list.slice(0, SHOWN);
            return (
              <div key={bucket} className="conversation-bucket">
                <h4 className="bucket">{bucket}</h4>
                <ul>{open.map(row)}</ul>
                {list.length > open.length ? (
                  <button
                    type="button"
                    className="link show-more"
                    onClick={() => setUnfolded((current) => new Set([...current, bucket]))}
                  >
                    Show {list.length - open.length} more
                  </button>
                ) : null}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
