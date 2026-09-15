import { useCallback, useEffect, useRef, useState } from "react";

import { SessionList, type OpenRequest } from "./SessionList";
import { TerminalView } from "./TerminalView";
import { ackHandoff, onHandoff } from "./lib/pty";

interface SessionView extends OpenRequest {
  /** Set when this session was teleported in; a terminal is waiting on it. */
  record?: string;
}

/**
 * Identity of what is on the stage: a different target is a different
 * terminal, so it keys the view and marks the session list stale. The nonce is
 * what makes two new sessions in the same directory two sessions.
 */
function targetOf(session: SessionView | null): string {
  return session
    ? `${session.nonce ?? ""}:${session.args.join(" ")}:${session.cwd ?? ""}`
    : "none";
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Acking twice would try to delete an already-deleted record.
  const ackedRef = useRef<string | null>(null);

  const target = targetOf(session);

  // The handoff listener is registered once, so it cannot close over a
  // render's values; it reads the stage through these instead.
  const targetRef = useRef(target);
  targetRef.current = target;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // The target that has proved itself live. A terminal only proves it by
  // producing output, which happens once per mount.
  const attachedRef = useRef<string | null>(null);

  // A different target is a different terminal, and it has not attached yet.
  useEffect(() => {
    if (attachedRef.current !== target) attachedRef.current = null;
  }, [target]);

  const ack = useCallback((record: string | undefined) => {
    if (!record || ackedRef.current === record) return;
    ackedRef.current = record;
    // Releases the waiting terminal, now that the session is really rendering.
    void ackHandoff(record).catch(() => {
      /* The terminal has its own timeout to fall back on. */
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onHandoff((handoff) => {
      setNotice(null);
      const next: SessionView = {
        args: handoff.args,
        cwd: handoff.cwd,
        title: handoff.label,
        // The shim hands over a pane for an attach; a resume has no pane yet.
        pane: handoff.args[0] === "attach" ? handoff.args[1] : undefined,
        record: handoff.record,
      };
      // `roer` in a terminal for the session Roer is already showing. The
      // target does not change, so nothing remounts and no further output
      // will arrive to prove the attach — it is already proved. Without this
      // the waiting terminal blocks for its whole timeout and then reports
      // that nothing moved, even though the session is on screen.
      if (targetOf(next) === targetRef.current && attachedRef.current === targetRef.current) {
        ack(handoff.record);
      }
      setSession(next);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [ack]);

  const handleAttached = useCallback(() => {
    attachedRef.current = targetRef.current;
    ack(sessionRef.current?.record);
  }, [ack]);

  const handleExit = useCallback(() => {
    setSession(null);
    setNotice(
      "Session released. It is still running with no client, so `roer` in a terminal will take it back.",
    );
  }, []);

  return (
    <main className="workspace" aria-label="Roer session">
      <SessionList
        activePane={session?.pane}
        token={target}
        error={null}
        onOpen={(request) => {
          setNotice(null);
          setSession(request);
        }}
      />

      <section className="stage">
        {session ? (
          <TerminalView
            key={target}
            args={session.args}
            cwd={session.cwd}
            onAttached={handleAttached}
            onExit={handleExit}
          />
        ) : (
          <div className="empty">
            {notice ? <p className="notice">{notice}</p> : null}
            <p className="muted">Pick a session on the left, or start a new one.</p>
          </div>
        )}
      </section>
    </main>
  );
}
