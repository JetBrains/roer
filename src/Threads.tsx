/**
 * What every view that takes comments draws and does the same way: the thread cards, their replies, and getting
 * each prompt to the session its thread is with when that session is free. Where a view keeps its threads and what
 * they are anchored to is the view's own; see `lib/threads`.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { NoteCard, NoteComposer, type NoteAnswer } from "./DiffNote";
import type { Session } from "./extensions/api";
import type { DiffNote } from "./lib/diff";
import { sendToSession } from "./lib/github";
import {
  askPrompt,
  deleteThread,
  liveOf,
  pickSession,
  replyPrompt,
  replyToThread,
  sessionLabel,
  setThread,
  startThread,
  type LiveSession,
  type Thread,
  type ThreadSession,
} from "./lib/threads";

/** Who a view's threads can go to: the stage's session and the live ones. */
export interface ThreadPeople {
  stage?: Session | null;
  sessions?: readonly LiveSession[];
}

const NO_SESSIONS: readonly LiveSession[] = [];

/** The sessions threads go to, for the views under it that have no props of their own for them. */
export const ThreadPeopleContext = createContext<ThreadPeople>({});

/** A thread's card answers: resolving it settles it, Undo opens it again. */
const THREAD_ACTIONS = [
  { label: "Resolve", value: "resolved", done: "Resolved" },
  { label: "Delete", value: "delete" },
];

/** Starting, replying to and sending threads, for one view. */
export function useThreadSender({ stage, sessions = NO_SESSIONS }: ThreadPeople) {
  const [outbox, setOutbox] = useState<{ thread: string; prompt: string; to: ThreadSession }[]>([]);
  const sending = useRef(false);

  // Each prompt typed into its own session when that one is free; the others wait without holding it up.
  useEffect(() => {
    if (sending.current) return;
    const next = outbox.find((one) => {
      const live = liveOf(one.to, sessions);
      const staged = stage?.pane === one.to.pane && !!stage.agent;
      return live ? !live.busy && !(staged && stage.busy) : staged && !stage.busy;
    });
    if (!next) return;
    sending.current = true;
    const live = liveOf(next.to, sessions);
    const typed = stage?.pane === next.to.pane ? stage.send(next.prompt) : sendToSession(next.to.pane, next.prompt);
    typed
      .then(() => {
        setThread(next.thread, {
          awaiting: true,
          session: live ? { pane: live.pane, id: live.id, agent: live.agent, cwd: live.cwd } : next.to,
        });
        setOutbox((current) => current.filter((one) => one !== next));
      })
      .catch((cause: unknown) => console.error("roer: could not send a comment to its session", cause))
      .finally(() => {
        sending.current = false;
      });
  }, [stage, sessions, outbox]);

  const queued = new Set(outbox.map((one) => one.thread));
  const send = (thread: string, prompt: string, to: ThreadSession) =>
    setOutbox((current) => [...current, { thread, prompt, to }]);

  /** Whether a thread's session is still there; without a list (a test, an old page) the stage's counts. */
  const isLive = (with_: ThreadSession | undefined) =>
    !!with_ && (!!liveOf(with_, sessions) || (sessions.length === 0 && with_.pane === stage?.pane));

  const targetFor = (root: string) => pickSession(root, stage, sessions);

  return {
    sessions,
    targetFor,
    isLive,
    /** Where a thread stands, as the tag on its card: who it is with, and whose turn it is. */
    statusOf(thread: Thread): string {
      const with_ = liveOf(thread.session, sessions) ?? thread.session;
      const label = with_ ? sessionLabel(with_) : "no session";
      if (thread.session && !isLive(thread.session)) {
        const next = targetFor(thread.root);
        return `${label} · ended: a reply goes to ${next ? sessionLabel(next) : "no one"}`;
      }
      if (queued.has(thread.id)) return `${label} · waiting for it to be free`;
      if (thread.awaiting) return `${label} · waiting for an answer`;
      if (thread.author && thread.replies.every((one) => one.author !== "You")) return `${label} · for you`;
      return label;
    },
    /** Starts the person's thread and sends it to the session it is with. */
    start(thread: Omit<Thread, "id" | "replies" | "state" | "session">): Thread {
      const to = targetFor(thread.root);
      const started = startThread({ ...thread, ...(to ? { session: to } : {}) });
      if (to) send(started.id, askPrompt(started), to);
      return started;
    },
    /** The person's reply. A thread whose session ended goes on with the one a new thread would go to, told the
     * whole of it. */
    reply(thread: Thread, text: string): void {
      replyToThread(thread.id, "You", text, true);
      const moved = !isLive(thread.session);
      const to = moved ? targetFor(thread.root) : thread.session;
      if (!to) return;
      if (moved) setThread(thread.id, { session: to });
      const replies = [...thread.replies, { author: "You", text }];
      send(thread.id, replyPrompt({ ...thread, replies }, text, moved), to);
    },
  };
}

export type ThreadSender = ReturnType<typeof useThreadSender>;

/** A thread an agent started knows only its pane: the session's id is kept once it is seen live, so a later session
 * in a reused pane is never taken for it. */
export function useClaimSessions(threads: readonly Thread[], sessions: readonly LiveSession[]): void {
  useEffect(() => {
    for (const thread of threads) {
      if (!thread.session || thread.session.id) continue;
      const live = sessions.find((one) => one.pane === thread.session!.pane);
      if (live) setThread(thread.id, { session: { pane: live.pane, id: live.id, agent: live.agent, cwd: live.cwd } });
    }
  }, [threads, sessions]);
}

/** A thread as the diff's comment card draws it, with where it stands as the tag on its corner. */
function threadNote(thread: Thread, status: string, at: string): DiffNote {
  return {
    id: thread.id,
    path: at,
    author: thread.author ?? "You",
    text: thread.text,
    replies: thread.replies,
    tag: status,
    ...(thread.state === "resolved" ? { state: "resolved" } : {}),
  };
}

/** Threads' cards, each with its reply box, as a diff's comments are drawn. */
export function ThreadCards({
  threads,
  sender,
  name,
}: {
  threads: readonly Thread[];
  sender: ThreadSender;
  /** What the reply box is about, for its label, e.g. "line 4". */
  name: (thread: Thread) => string;
}) {
  const [replying, setReplying] = useState<string | null>(null);
  const answer = ({ note, action }: NoteAnswer) => {
    if (!note.id) return;
    if (action === "delete") deleteThread(note.id);
    else setThread(note.id, { state: action === "resolved" ? "resolved" : "open" });
  };
  return (
    <>
      {threads.map((thread) => {
        const with_ = sender.isLive(thread.session) ? (liveOf(thread.session, sender.sessions) ?? thread.session) : sender.targetFor(thread.root);
        return (
          <div key={thread.id} className="thread">
            <NoteCard note={threadNote(thread, sender.statusOf(thread), name(thread))} actions={THREAD_ACTIONS} onAnswer={answer} />
            {thread.state === "resolved" ? null : replying === thread.id ? (
              <NoteComposer
                line={0}
                label={`Reply on ${name(thread)}`}
                placeholder={`Reply to ${with_ ? sessionLabel(with_) : "the agent"}`}
                submitLabel="Reply"
                onSubmit={(text) => {
                  sender.reply(thread, text);
                  setReplying(null);
                }}
                onCancel={() => setReplying(null)}
              />
            ) : (
              <button type="button" className="gen-button borderless thread-reply" onClick={() => setReplying(thread.id)}>
                Reply
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The box a new thread is written in, naming who it goes to. */
export function ThreadComposer({
  root,
  sender,
  name,
  onSubmit,
  onCancel,
}: {
  root: string;
  sender: ThreadSender;
  /** What it is about, for its label, e.g. "lines 3–7". */
  name: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const to = sender.targetFor(root);
  return (
    <NoteComposer
      line={0}
      label={`Comment on ${name}`}
      placeholder={to ? `Ask ${to.agent ?? "the agent"}, or tell it what to change` : "No agent runs in a session here to send it to"}
      submitLabel={to ? `Send to ${sessionLabel(to)}` : "Keep"}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/** The sessions threads go to, from the nearest provider. */
export const useThreadPeople = (): ThreadPeople => useContext(ThreadPeopleContext);
