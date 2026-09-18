import { useCallback, useEffect, useRef, useState } from "react";

import { gitRoot } from "./lib/git";
import {
  listClaudeSessions,
  listPastSessions,
  listSessions,
  roerStatus,
  type ClaudeSession,
  type RoerStatus,
  type SessionInfo,
} from "./lib/pty";

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

export interface SessionListProps {
  /** The pane on the stage, so the list can mark it rather than offer it. */
  activePane?: string;
  /** Changes whenever the stage changes, which is when the list is stale. */
  token: string;
  error: string | null;
  onOpen: (request: OpenRequest) => void;
}

/** A session's directory, in the form a person recognises it. */
function shorten(cwd: string, home: string | undefined): string {
  if (!cwd) return "";
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/**
 * Just the directory's own name, not its whole path — the group heading
 * above a row already names the repository it's in, so the row itself only
 * needs to tell rows within the same group apart.
 */
function folderName(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() ?? cwd;
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

/**
 * The sessions you can attach to, kept on screen beside the terminal so the
 * list stays navigation rather than a screen you leave.
 */
export function SessionList({ activePane, token, error, onOpen }: SessionListProps) {
  const [status, setStatus] = useState<RoerStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [roots, setRoots] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const live = await listSessions();
      setSessions(live);
      // Reconciling history depends on having just asked for the live list,
      // so this always follows it rather than running in parallel. Its own
      // rows are no longer shown directly — only its cwds, to scope which
      // Claude conversations are worth looking up.
      const past = await listPastSessions();
      const cwds = [...new Set([...live.map((s) => s.cwd), ...past.map((p) => p.cwd)])].filter(
        Boolean,
      );
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
  }, []);

  useEffect(() => {
    void roerStatus()
      .then(setStatus)
      .catch((cause: unknown) => setFailure(String(cause)));
  }, []);

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

  // `new` rather than `shell`, because `shell` reuses the session for a
  // directory. A new session starts in the home directory: the shim names a
  // session after its directory, and the app's own working directory is an
  // accident of how it was launched. `cd` is a shell away once it is open.
  //
  // No cwd at all until status resolves, rather than a disabled button: the
  // backend defaults an empty cwd to home, so a click that lands first still
  // opens in the right place.
  const openNew = () => {
    openedRef.current += 1;
    onOpen({
      args: ["new"],
      cwd: status?.home,
      title: "new session",
      nonce: `new-${openedRef.current}`,
      known: sessions.map((session) => session.pane),
    });
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

  return (
    <nav className="sidebar" aria-label="Sessions">
      <header>
        <h1>Roer</h1>
        <button type="button" className="primary" onClick={openNew}>
          New session
        </button>
      </header>

      {(error ?? failure) ? <p className="error">{error ?? failure}</p> : null}

      {status && !status.available ? (
        <p className="error">
          The <code>roer</code> shim was not found (looked for <code>{status.bin}</code>). Link it
          with <code>ln -s $PWD/scripts/roer ~/.local/bin/roer</code>, or point{" "}
          <code>ROER_BIN</code> at it.
        </p>
      ) : null}

      <h2>
        Sessions
        <button type="button" className="link" onClick={() => void refresh()}>
          Refresh
        </button>
      </h2>

      {sessions.length === 0 ? (
        <p className="muted">
          Nothing running yet. Start one here, or run <code>roer</code> in a terminal and teleport
          it over with the skill.
        </p>
      ) : (
        groupByRoot(sessions, (session) => session.cwd, roots).map((group) => (
          <div key={group.root ?? "sessions"}>
            {group.root ? (
              <h3 className="group" title={shorten(group.root, status?.home)}>
                {folderName(group.root)}
              </h3>
            ) : null}
            <ul>
              {group.items.map((session) => {
                const active = session.pane === activePane;
                return (
                  <li key={session.pane}>
                    <button
                      type="button"
                      className={active ? "row active" : "row"}
                      aria-current={active ? "true" : undefined}
                      onClick={() =>
                        onOpen({
                          args: ["attach", session.pane],
                          cwd: session.cwd,
                          title: session.session,
                          pane: session.pane,
                        })
                      }
                    >
                      <strong>{session.session}</strong>
                      {/* Named exactly as the terminal would show it: the
                          command running in the pane. */}
                      <span className="muted">{session.command}</span>
                      {/* Attaching takes a session over from whoever holds it,
                          which may be a terminal or another window of this app. */}
                      <span
                        className={active ? "badge here" : session.attached ? "badge held" : "badge free"}
                      >
                        {active ? "open here" : session.attached ? "attached" : "idle"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      {claudeSessions.length > 0 ? (
        <>
          <h2 className="muted">Resume</h2>
          {groupByRoot(claudeSessions, (session) => session.cwd, roots).map((group) => (
            <div key={group.root ?? "resume"}>
              {group.root ? (
                <h3 className="group" title={shorten(group.root, status?.home)}>
                  In {folderName(group.root)}
                </h3>
              ) : null}
              <ul>
                {group.items.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className="row"
                      onClick={() => openClaudeSession(session)}
                    >
                      <strong>{session.title}</strong>
                      {/* Named the same way the Sessions list names its
                          rows: the agent that will run, not an icon for it. */}
                      <span className="muted">claude</span>
                      <span className="badge resume">{relativeAge(session.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : null}
    </nav>
  );
}
