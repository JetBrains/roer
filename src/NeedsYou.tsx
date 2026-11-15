/**
 * Everything waiting on the person, across every session, at the top of the sidebar: agents held up on a question
 * or a permission, and threads where an agent answered or asked and they have not seen it yet. Each opens where it
 * lives; a thread also opens in place, to read and answer it without going there.
 */
import { useEffect, useRef, useState } from "react";

import { LiveName, needsYou, paneLabel, rowNote, runningAgent } from "./SessionBrowser";
import { ThreadCards, useThreadSender, type ThreadPeople } from "./Threads";
import type { OpenFile } from "./extensions/api";
import { notify } from "./lib/notify";
import type { SessionInfo } from "./lib/pty";
import { forYou, liveOf, messagesIn, placeOf, sessionLabel, useThreads, type Thread } from "./lib/threads";

export interface NeedsYouProps {
  /** Every live session, the ones out of the sidebar's view included: what waits on the person waits anywhere. */
  sessions: readonly SessionInfo[];
  /** The panes whose agent is waiting on the person. */
  waiting: ReadonlySet<string>;
  /** The session on the stage, which the person is already looking at. */
  activePane?: string | null;
  onOpenSession: (session: SessionInfo) => void;
  onOpenFile: OpenFile;
  /** Who threads answered from here go to. */
  people: ThreadPeople;
}

const capitalised = (word: string) => (word ? word[0].toUpperCase() + word.slice(1) : word);

/** Rows shown before "N more": enough for a glance, few enough to leave the sessions in sight. */
const FIRST_ROWS = 4;

const FOLD_KEY = "roer:needs-you-folded";

export function NeedsYou({ sessions, waiting, activePane, onOpenSession, onOpenFile, people }: NeedsYouProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [folded, setFoldedRaw] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setFolded = (next: boolean) => {
    setFoldedRaw(next);
    try {
      if (next) localStorage.setItem(FOLD_KEY, "1");
      else localStorage.removeItem(FOLD_KEY);
    } catch {
      /* kept until the window closes */
    }
  };
  // Reading a thread here sees it, which would take it off the list under the person's eyes: the open one stays
  // until it is closed.
  // Newest first: the store keeps them in the order they were started.
  const listed = useThreads((thread) => forYou(thread) || thread.id === open, [open]).slice().reverse();
  const threads = listed.filter(forYou);
  const sender = useThreadSender(people);
  const held = sessions.filter((session) => waiting.has(session.pane) && session.pane !== activePane);

  const sessionOf = (thread: Thread) =>
    thread.session ? sessions.find((one) => one.pane === thread.session!.pane && (!thread.session!.id || one.id === thread.session!.id)) : undefined;
  const whoOf = (thread: Thread) => {
    const live = liveOf(thread.session, people.sessions ?? []) ?? thread.session;
    return live ? sessionLabel(live) : "";
  };

  // A banner for each new word from an agent, said generically, as the session banners are: the agent's own words
  // stay in Roer, where it is the person reading them.
  const known = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const before = known.current;
    known.current = new Map(threads.map((thread) => [thread.id, messagesIn(thread)]));
    if (!before || (typeof document.hasFocus === "function" && document.hasFocus())) return;
    for (const thread of threads) {
      if ((before.get(thread.id) ?? 0) >= messagesIn(thread)) continue;
      const agent = capitalised(thread.replies.at(-1)?.author ?? thread.author ?? "The agent");
      const what = thread.replies.length > 0 ? "answered your comment" : "left you a comment";
      const where = thread.view ? "in a view" : `on ${placeOf(thread)}`;
      void notify(whoOf(thread) || agent, `${agent} ${what} ${where}`, () => setOpen(thread.id));
    }
    // `whoOf` reads the live sessions, which change far more often than the threads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  const count = held.length + threads.length;
  if (held.length + listed.length === 0) return null;

  const goTo = (thread: Thread) => {
    const line = thread.anchors.find((a): a is Extract<Thread["anchors"][number], { kind: "line" }> => a.kind === "line");
    if (line) onOpenFile(thread.root, line.path, line.line, { thread: thread.id, ...(line.branch ? { branch: line.branch } : {}) });
    else {
      // A view's threads live in its session's panel.
      const session = sessionOf(thread);
      if (session) onOpenSession(session);
    }
  };

  type Row = { session: SessionInfo; thread?: undefined } | { thread: Thread; session?: undefined };
  const rows: Row[] = [...held.map((session) => ({ session })), ...listed.map((thread) => ({ thread }))];
  // The thread being read stays in the rows shown, wherever it falls.
  const shown = all ? rows : rows.filter((row, i) => i < FIRST_ROWS || row.thread?.id === open);
  const more = rows.length - shown.length;

  return (
    <section className="needs-you" aria-label="Needs you">
      <h2>
        <button type="button" className="needs-you-fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
          Needs you {count > 0 ? <span className="needs-you-count">{count}</span> : null}
        </button>
      </h2>
      {folded ? null : (
        <>
          <ul className={all ? "all" : undefined}>
            {shown.map((row) => (row.session ? sessionRow(row.session) : threadRow(row.thread)))}
          </ul>
          {more > 0 || all ? (
            <button type="button" className="gen-button borderless needs-you-more" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `${more} more`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );

  function sessionRow(session: SessionInfo) {
    const note = rowNote(session);
    const who = runningAgent(session) ?? session.command;
    return (
      <li key={`session:${session.pane}`}>
        <button
          type="button"
          className="needs-you-row"
          onClick={() => onOpenSession(session)}
          // The whole title, which the row may cut short, and where the session works.
          title={[paneLabel(session.title, session.command), session.cwd].filter(Boolean).join("\n")}
        >
          <span className="row-line">
            <span className={`tree-dot ${needsYou(session) ? "needs" : "waiting"}`} aria-hidden="true" />
            <LiveName session={session} />
            <span className="tree-state needs">{needsYou(session) ? "needs you" : "waiting"}</span>
          </span>
          <span className="tree-note">{note ?? `${capitalised(who)} is waiting for you`}</span>
        </button>
      </li>
    );
  }

  function threadRow(thread: Thread) {
    const last = thread.replies.at(-1);
    const author = last?.author ?? thread.author ?? "Agent";
    const words = (last?.text ?? thread.text).replace(/\s+/g, " ").trim();
    const expanded = open === thread.id;
    return (
      <li key={`thread:${thread.id}`}>
        <button
          type="button"
          className={expanded ? "needs-you-row open" : "needs-you-row"}
          aria-expanded={expanded}
          onClick={() => setOpen(expanded ? null : thread.id)}
        >
          <span className="row-line">
            <span className="tree-dot needs" aria-hidden="true" />
            <strong>{author}</strong>
            <span className="muted">{thread.replies.length > 0 ? "answered" : "asks"}</span>
            <span className="needs-you-place">{placeOf(thread)}</span>
          </span>
          <span className="tree-note">{words}</span>
        </button>
        {expanded ? (
          <div className="needs-you-thread">
            <button type="button" className="gen-button borderless" onClick={() => goTo(thread)}>
              {thread.view ? `Open ${whoOf(thread) || "its session"}` : `Open ${placeOf(thread)}`}
            </button>
            <ThreadCards threads={[thread]} sender={sender} name={placeOf} />
          </div>
        ) : null}
      </li>
    );
  }
}
