import { useCallback, useEffect, useRef, useState } from "react";

import { listSessions, roerStatus, type RoerStatus, type SessionInfo } from "./lib/pty";

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
}

export interface SessionListProps {
  /** The pane on the stage, so the list can mark it rather than offer it. */
  activePane?: string;
  /** Changes whenever the stage changes, which is when the list is stale. */
  token: string;
  error: string | null;
  onOpen: (request: OpenRequest) => void;
}

/**
 * The sessions you can attach to, kept on screen beside the terminal so the
 * list stays navigation rather than a screen you leave.
 */
export function SessionList({ activePane, token, error, onOpen }: SessionListProps) {
  const [status, setStatus] = useState<RoerStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await listSessions());
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
  // badges are stale the moment the stage changes.
  useEffect(() => {
    void refresh();
  }, [refresh, token]);

  // Counts the sessions opened from here, only so each one is a different
  // request. Two clicks send the same args to the same directory, and without
  // something to tell them apart the stage sees no change and keeps the first
  // terminal mounted.
  const openedRef = useRef(0);

  // `new` rather than `shell`, because `shell` reuses the session for a
  // directory. A new session starts in the home directory: the shim names a
  // session after its directory, and the app's own working directory is an
  // accident of how it was launched. `cd` is a shell away once it is open.
  const openNew = () => {
    openedRef.current += 1;
    onOpen({
      args: ["new"],
      cwd: status?.home,
      title: "new session",
      nonce: `new-${openedRef.current}`,
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
        <ul>
          {sessions.map((session) => {
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
                  <span className="muted">{session.command}</span>
                  {/* Attaching takes a session over from whoever holds it,
                      which may be a terminal or another window of this app. */}
                  <span className={active ? "badge here" : session.attached ? "badge held" : "badge free"}>
                    {active ? "open here" : session.attached ? "attached" : "idle"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
