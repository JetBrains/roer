import { useCallback, useEffect, useRef, useState } from "react";

import { SessionList, type OpenRequest } from "./SessionList";
import { TerminalView } from "./TerminalView";
import {
  ackHandoff,
  claimHandoff,
  failHandoff,
  listSessions,
  onHandoff,
  pendingHandoffs,
  type Handoff,
} from "./lib/pty";

interface SessionView extends OpenRequest {
  /** Set when this session was teleported in; a terminal is waiting on it.
   * Holds the *claimed* record path, which is what ack and fail take. */
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

function viewOf(handoff: Handoff, record: string): SessionView {
  return {
    args: handoff.args,
    cwd: handoff.cwd,
    title: handoff.label,
    // The shim hands over a pane for an attach; a resume has no pane yet.
    pane: handoff.args[0] === "attach" ? handoff.args[1] : undefined,
    record,
  };
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Acking twice would try to delete an already-deleted record.
  const ackedRef = useRef<string | null>(null);

  const target = targetOf(session);

  // What is on the stage, read synchronously. The handoff listener is
  // registered once and cannot close over a render's values, and a handoff
  // arriving in the same tick as another must see the first one.
  const stagedRef = useRef<SessionView | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  // The target that has proved itself live. A terminal only proves it by
  // producing output, which happens once per mount.
  const attachedRef = useRef<string | null>(null);
  // Handoffs claimed while the stage still owes a terminal its proof. The
  // stage holds one session, so showing them at once would evict a session
  // whose terminal is still waiting to hear that it moved.
  const queueRef = useRef<SessionView[]>([]);

  // A different target is a different terminal, and it has not attached yet.
  useEffect(() => {
    if (attachedRef.current !== target) attachedRef.current = null;
  }, [target]);

  const show = useCallback((next: SessionView) => {
    stagedRef.current = next;
    setNotice(null);
    setSession(next);
  }, []);

  /** Shows the next queued handoff, if the stage has come free. */
  const drain = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) return false;
    show(next);
    return true;
  }, [show]);

  const ack = useCallback(
    (record: string | undefined) => {
      if (!record || ackedRef.current === record) return;
      ackedRef.current = record;
      // Releases the waiting terminal, now that the session is really rendering.
      void ackHandoff(record)
        .catch(() => {
          /* The terminal has its own timeout to fall back on. */
        })
        // Nobody is owed proof any more, so a handoff that arrived meanwhile
        // can have the stage.
        .finally(() => drain());
    },
    [drain],
  );

  /** True while the staged session owes a terminal its proof. */
  const owesProof = useCallback(() => {
    const record = stagedRef.current?.record;
    return Boolean(record) && ackedRef.current !== record;
  }, []);

  const accept = useCallback(
    async (handoff: Handoff) => {
      // Claim before attaching: the shim cancels by renaming this same path,
      // so a failure here means it gave up and still holds the session.
      let claimed: string;
      try {
        claimed = await claimHandoff(handoff.record);
      } catch {
        return;
      }
      const next = viewOf(handoff, claimed);
      if (owesProof()) {
        queueRef.current.push(next);
        return;
      }
      // `roer` in a terminal for the session Roer is already showing. The
      // target does not change, so nothing remounts and no further output
      // will arrive to prove the attach — it is already proved. Without this
      // the waiting terminal blocks for its whole timeout and then reports
      // that nothing moved, even though the session is on screen.
      if (targetOf(next) === targetRef.current && attachedRef.current === targetRef.current) {
        show(next);
        ack(claimed);
        return;
      }
      show(next);
    },
    [ack, owesProof, show],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onHandoff((handoff) => {
      void accept(handoff);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        // Only now, with a listener in place, is it safe to ask for what
        // arrived earlier — the shim starts Roer and then waits, so the
        // handoff that opened the app is nearly always in here.
        return pendingHandoffs().then(async (records) => {
          for (const record of records) {
            if (cancelled) return;
            await accept(record);
          }
        });
      })
      .catch(() => {
        /* Nothing was waiting, or the backend is not up; the watcher covers
           anything that arrives from here on. */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [accept]);

  const handleAttached = useCallback(() => {
    attachedRef.current = targetRef.current;
    ack(stagedRef.current?.record);
  }, [ack]);

  /**
   * What became of a session whose PTY just ended. Detaching leaves the
   * session running with no client; a shell that exited takes it with it, and
   * saying it can be taken back then would be a lie.
   */
  const describeExit = useCallback(async (gone: SessionView) => {
    if (!gone.pane) return "Session closed.";
    try {
      const sessions = await listSessions();
      return sessions.some((s) => s.pane === gone.pane)
        ? "Session released. It is still running with no client, so `roer` in a terminal will take it back."
        : "Session ended.";
    } catch {
      return "Session closed.";
    }
  }, []);

  const handleExit = useCallback(() => {
    const gone = stagedRef.current;
    stagedRef.current = null;
    setSession(null);

    // A claimed handoff whose session never made it on screen: hand the record
    // back, so the terminal hears that nothing moved instead of waiting out
    // its timeout.
    if (gone?.record && ackedRef.current !== gone.record) {
      void failHandoff(gone.record).catch(() => {
        /* The terminal's timeout says the same thing, more slowly. */
      });
    }

    if (drain()) return;
    if (gone) void describeExit(gone).then(setNotice);
  }, [describeExit, drain]);

  return (
    <main className="workspace" aria-label="Roer session">
      <SessionList
        activePane={session?.pane}
        token={target}
        error={null}
        onOpen={(request) => show(request)}
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
