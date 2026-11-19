/**
 * What every view that takes comments draws and does the same way: the thread cards, their replies, and getting
 * each prompt to the session its thread is with when that session is free. Where a view keeps its threads and what
 * they are anchored to is the view's own; see `lib/threads`.
 */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import { NoteCard, NoteComposer, type NoteAnswer } from "./DiffNote";
import type { Session } from "./extensions/api";
import type { DiffNote } from "./lib/diff";
import { sendToSession } from "./lib/github";
import {
  allThreads,
  askPrompt,
  deleteThread,
  forYou,
  liveOf,
  markSeen,
  messagesIn,
  pickSession,
  queueOnThread,
  replyPrompt,
  replyToThread,
  sessionLabel,
  setThread,
  startThread,
  updateThreads,
  useThreads,
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

/** A view mid-send holds a thread this long at most; past it, a send that never came back is taken as lost. */
const CLAIM_FOR = 60_000;
/** How long a failed send waits before it is tried again: doubling from this, up to `RETRY_MAX`. */
const RETRY_FIRST = 15_000;
const RETRY_MAX = 5 * 60_000;
/** How often the outbox is looked at with nothing else happening: a session coming free, a retry falling due. */
const OUTBOX_TICK = 3_000;

const sessionOf = (live: LiveSession): ThreadSession => ({ pane: live.pane, id: live.id, agent: live.agent, cwd: live.cwd });

/** Where thread `thread`'s next prompt goes now: its own session while that is there, else the one a new thread
 * would go to, which is told the whole thread. */
function destinationOf(thread: Thread, { stage, sessions = NO_SESSIONS }: ThreadPeople) {
  const own = thread.session;
  const ownThere = !!own && (!!liveOf(own, sessions) || (stage?.pane === own.pane && !!stage.agent));
  if (own && ownThere) return { to: own, moved: false };
  const to = pickSession(thread.root, stage, sessions);
  return to ? { to, moved: true } : null;
}

/**
 * Types each thread's waiting prompts into its session when that session is free, oldest first; the threads waiting
 * on another session do not hold one up. The outbox is kept with the threads, so any view sending them, or the
 * app's own, sends what another view queued; a view claims a thread while it types, so two never send the same.
 */
export function useThreadOutbox(people: ThreadPeople, on = true): void {
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const sending = useRef(false);
  const [tick, setTick] = useState(0);
  const pending = useThreads((thread) => (thread.outbox?.length ?? 0) > 0, []);

  useEffect(() => {
    if (!on || pending.length === 0) return;
    const every = window.setInterval(() => setTick((n) => n + 1), OUTBOX_TICK);
    return () => window.clearInterval(every);
  }, [on, pending.length]);

  useEffect(() => {
    if (!on || sending.current) return;
    const { stage, sessions = NO_SESSIONS } = peopleRef.current;
    const now = Date.now();
    for (const thread of allThreads()) {
      const item = thread.outbox?.[0];
      if (!item) continue;
      if (thread.sendingSince !== undefined && now - thread.sendingSince < CLAIM_FOR) continue;
      if (thread.retryAt !== undefined && now < thread.retryAt) continue;
      const where = destinationOf(thread, peopleRef.current);
      if (!where) continue;
      const { to, moved } = where;
      const live = liveOf(to, sessions);
      const staged = stage?.pane === to.pane && !!stage.agent;
      const free = live ? !live.busy && !(staged && stage.busy) : staged && !stage.busy;
      if (!free) continue;

      const prompt = item.kind === "ask" ? askPrompt(thread) : replyPrompt(thread, item.text, moved);
      sending.current = true;
      setThread(thread.id, { sendingSince: now, ...(moved ? { session: to } : {}) });
      const typed = staged ? stage.send(prompt) : sendToSession(to.pane, prompt);
      typed
        .then(() =>
          updateThreads((current) =>
            current.map((one) => {
              if (one.id !== thread.id) return one;
              const { sendingSince: _s, retryAt: _r, tries: _t, ...rest } = one;
              const outbox = (one.outbox ?? []).slice(1);
              return { ...rest, awaiting: true, session: live ? sessionOf(live) : to, ...(outbox.length > 0 ? { outbox } : { outbox: undefined }) };
            }),
          ),
        )
        .catch((cause: unknown) => {
          console.error("roer: could not send a comment to its session", cause);
          const tries = (thread.tries ?? 0) + 1;
          setThread(thread.id, { sendingSince: undefined, tries, retryAt: Date.now() + Math.min(RETRY_FIRST * 2 ** (tries - 1), RETRY_MAX) });
        })
        .finally(() => {
          sending.current = false;
          setTick((n) => n + 1);
        });
      return;
    }
  }, [on, pending, people.stage, people.sessions, tick]);
}

/** Starting, replying to and sending threads, for one view. */
export function useThreadSender({ stage, sessions = NO_SESSIONS }: ThreadPeople) {
  useThreadOutbox({ stage, sessions });

  const queued = (thread: Thread) => (thread.outbox?.length ?? 0) > 0;

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
      if (queued(thread)) {
        if (thread.retryAt !== undefined) return `${label} · could not send it, trying again`;
        if (!destinationOf(thread, { stage, sessions })) return "waiting for a session in this repository";
        return `${label} · waiting for it to be free`;
      }
      if (thread.awaiting) return `${label} · ${liveOf(thread.session, sessions)?.busy ? "working on it" : "waiting for an answer"}`;
      if (thread.author && thread.replies.every((one) => one.author !== "You")) return `${label} · for you`;
      return label;
    },
    /** Starts the person's thread and sends it to the session it is with. */
    start(thread: Omit<Thread, "id" | "replies" | "state" | "session">): Thread {
      const to = targetFor(thread.root);
      // Queued with it: sent once its session is free, or once there is a session for its repository at all.
      return startThread({ ...thread, ...(to ? { session: to } : {}), outbox: [{ kind: "ask" }] });
    },
    /** The thread's session for a live pane: the one a prompt about it was just typed into by its view. */
    pinned(pane: string): ThreadSession {
      const live = sessions.find((one) => one.pane === pane);
      return live ? sessionOf(live) : { pane, ...(stage?.pane === pane && stage.agent ? { agent: stage.agent, cwd: stage.cwd } : {}) };
    },
    /** The person's reply. A thread whose session ended goes on with the one a new thread would go to, told the
     * whole of it. */
    reply(thread: Thread, text: string): void {
      // Not yet due an answer: that is once it has been typed into a session.
      replyToThread(thread.id, "You", text, false);
      queueOnThread(thread.id, { kind: "reply", text });
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

/**
 * The threads collapsed by hand, each with how many messages it had then: one that gets a new message opens again,
 * so an answer is never left folded away. Kept in this browser across views and launches, like a diff's layout.
 */
const COLLAPSED_KEY = "roer:threads-collapsed";
const collapsedListeners = new Set<() => void>();
/** The last value read and what it parsed to: the same object while the stored text is the same. */
let collapsedRead: { raw: string | null; value: Record<string, number> } = { raw: null, value: {} };

function collapsedAll(): Record<string, number> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COLLAPSED_KEY);
  } catch {
    return collapsedRead.value;
  }
  if (raw === collapsedRead.raw) return collapsedRead.value;
  let value: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object") value = parsed as Record<string, number>;
  } catch {
    /* unreadable: nothing collapsed */
  }
  collapsedRead = { raw, value };
  return value;
}

function setCollapsed(thread: Thread, on: boolean): void {
  const { [thread.id]: _, ...rest } = collapsedAll();
  const next = on ? { ...rest, [thread.id]: messagesIn(thread) } : rest;
  const raw = JSON.stringify(next);
  collapsedRead = { raw, value: next };
  try {
    localStorage.setItem(COLLAPSED_KEY, raw);
  } catch {
    /* kept for as long as the window is open */
  }
  for (const listener of collapsedListeners) listener();
}

const subscribeCollapsed = (listener: () => void) => {
  collapsedListeners.add(listener);
  return () => collapsedListeners.delete(listener);
};

/** Whether `thread` is collapsed: by hand, and nothing said in it since. */
const isCollapsed = (all: Record<string, number>, thread: Thread) => all[thread.id] !== undefined && all[thread.id] >= messagesIn(thread);

/** Whether a key press is the person's own reply shortcut: R alone, not typed into a field. */
const isReplyKey = (event: KeyboardEvent<HTMLElement>) =>
  event.key.toLowerCase() === "r" &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]"));

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
  seeing = true,
  flash = null,
  tagFor,
  extra,
}: {
  threads: readonly Thread[];
  sender: ThreadSender;
  /** What the reply box is about, for its label, e.g. "line 4". */
  name: (thread: Thread) => string;
  /** Whether they are in front of the person, which is what makes a new answer seen; a hidden tab's are not. */
  seeing?: boolean;
  /** A thread just asked for, drawn flashing so the eye finds it. */
  flash?: string | null;
  /** A word put before a thread's status on its corner, e.g. "outdated". */
  tagFor?: (thread: Thread) => string | undefined;
  /** More under a thread's card, e.g. a way to see it on the content it was written on. */
  extra?: (thread: Thread) => ReactNode;
}) {
  const [replying, setReplying] = useState<string | null>(null);
  const collapsed = useSyncExternalStore(subscribeCollapsed, collapsedAll);
  // An answer on screen is an answer read: it leaves "Needs you".
  useEffect(() => {
    if (!seeing || document.visibilityState === "hidden") return;
    for (const thread of threads) if (forYou(thread)) markSeen(thread.id);
  }, [seeing, threads]);
  const answer = ({ note, action }: NoteAnswer) => {
    if (!note.id) return;
    if (action === "delete") deleteThread(note.id);
    else setThread(note.id, { state: action === "resolved" ? "resolved" : "open" });
  };
  return (
    <>
      {threads.map((thread) => {
        const with_ = sender.isLive(thread.session) ? (liveOf(thread.session, sender.sessions) ?? thread.session) : sender.targetFor(thread.root);
        const folded = isCollapsed(collapsed, thread);
        const canReply = thread.state !== "resolved";
        return (
          <div
            key={thread.id}
            className={thread.id === flash ? "thread flash" : "thread"}
            data-thread={thread.id}
            // Focused by a click in it, by Tab, or by stepping to it: R then replies, as the Reply button says.
            tabIndex={-1}
            onKeyDown={(event) => {
              if (!canReply || replying === thread.id || !isReplyKey(event)) return;
              event.preventDefault();
              event.stopPropagation();
              if (folded) setCollapsed(thread, false);
              setReplying(thread.id);
            }}
          >
            <NoteCard
              note={threadNote(thread, [tagFor?.(thread), sender.statusOf(thread)].filter(Boolean).join(" · "), name(thread))}
              actions={THREAD_ACTIONS}
              onAnswer={answer}
              collapsed={folded && replying !== thread.id}
              onToggle={() => setCollapsed(thread, !folded)}
            />
            {folded && replying !== thread.id ? null : extra?.(thread)}
            {!canReply || (folded && replying !== thread.id) ? null : replying === thread.id ? (
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
              <button
                type="button"
                className="gen-button borderless thread-reply"
                title="Reply (R)"
                aria-label="Reply"
                aria-keyshortcuts="R"
                onClick={() => setReplying(thread.id)}
              >
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
