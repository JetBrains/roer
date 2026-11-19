/**
 * Threads: a comment on something on screen, sent to a session's agent, answered through `threads__answer`, and
 * replied to from where it was left. One service for every view that takes comments: a file's lines, a part of a
 * Generative UI view, an element of an extension's tab. A thread may be about several things at once (a range of
 * lines, three boxes of a diagram), each an anchor, and shows on each of them.
 *
 * Kept in Roer's shared storage, so the window and a browser page show the same threads and an agent's answer
 * reaches whichever has them open. Each thread is with one session, by pane and session id, and everything said in
 * it goes there.
 */
import { useEffect, useMemo, useState } from "react";

import { onSharedStorage, sharedStorage } from "./sharedStorage";

/** What a thread is about. A line range of a file, or a part of a view by the id the view gives it. */
export type Anchor =
  | {
      kind: "line";
      path: string;
      line: number;
      /** The last line, for a range. */
      end?: number;
      /** The lines as they read when the thread was started: numbers move as the agent edits. */
      code: string;
      /** A branch no worktree has checked out, when the file was read from git at it. */
      branch?: string;
      /** The blob of the content it was written on: a thread belongs to the revision it was left on, and is moved
       * from it to what is on screen through the diff between the two. */
      blob?: string;
      /** A line the change removed, counted in the file as it was before: left in Changes, shown there alone. */
      side?: "old";
      /** The commit it was left on in Changes, its lines counted as that commit left the file; shown there alone. */
      commit?: { hash: string; short: string; subject: string };
    }
  | {
      kind: "part";
      /** The part's id in its view: a component's, a node's, a `data-roer-id`. */
      id: string;
      /** What the person sees it as, for the prompt. */
      label?: string;
    };

/** The session a thread is with. A pane alone can name a later session once tmux starts over, so the session's id
 * is kept with it as soon as it is known. */
export interface ThreadSession {
  pane: string;
  id?: string;
  /** "claude", "codex", …, as it was when the thread was pinned. */
  agent?: string;
  /** The folder it works in, to name it by. */
  cwd?: string;
}

/** A live session an agent runs in. */
export interface LiveSession {
  pane: string;
  id: string;
  agent: string;
  cwd: string;
  busy?: boolean;
}

export interface Thread {
  id: string;
  /** The repository (the worktree) it is about. */
  root: string;
  /** The view it was left in, e.g. `ui:<surfaceId>`; absent for a thread on a file's lines. */
  view?: string;
  /** The view's title, for the prompt. */
  viewTitle?: string;
  anchors: Anchor[];
  /** Who started it: an agent's name, for one an agent left with `threads__comment`; absent for the person's. */
  author?: string;
  session?: ThreadSession;
  text: string;
  /** What the person wants: an answer to a question, which leaves the code alone, or a change made. A thread left
   * without saying, as a file's are, is a change or a question as its words say. */
  intent?: "ask" | "change";
  replies: ThreadReply[];
  state: "open" | "resolved";
  /** The last word is the person's, and it has gone to the agent: an answer is due. */
  awaiting?: boolean;
  /** How many of its messages (the first and the replies) the person has seen; absent counts their own as seen. */
  seen?: number;
  /** When its worktree or branch was first found gone (ms); absent while it is there. See `sweepThreads`. */
  goneSince?: number;
  /** What is still to be typed into its session, oldest first: kept with the thread, so whichever view is open
   * sends it once the session is free, and none is lost with the view it was written in. */
  outbox?: Outgoing[];
  /** A send that failed is tried again from then (ms), each time a little later; `tries` counts the failures. */
  retryAt?: number;
  tries?: number;
  /** A view is typing it now (ms): no other takes the same one meanwhile. */
  sendingSince?: number;
}

/** A message under a thread's first one. An agent's answer may carry a view: Generative UI messages (A2UI, as
 * `show_ui` takes them), drawn in the thread under its words rather than in the side panel. */
export interface ThreadReply {
  author: string;
  text: string;
  ui?: unknown[];
}

/** One prompt waiting for a thread's session: the thread itself, or one of the person's replies. */
export type Outgoing = { kind: "ask" } | { kind: "reply"; text: string };

/** The first message and every reply. */
export const messagesIn = (thread: Thread): number => 1 + thread.replies.length;

/** The thread waits on the person: an agent spoke last, and they have not seen it yet. */
export function forYou(thread: Thread): boolean {
  if (thread.state !== "open" || thread.goneSince !== undefined) return false;
  const last = thread.replies.at(-1)?.author ?? (thread.author ? thread.author : "You");
  if (last === "You") return false;
  return (thread.seen ?? (thread.author ? 0 : 1)) < messagesIn(thread);
}

/** The person has seen every message in thread `id`. */
export function markSeen(id: string): void {
  updateThreads((current) =>
    current.map((thread) => (thread.id === id && thread.seen !== messagesIn(thread) ? { ...thread, seen: messagesIn(thread) } : thread)),
  );
}

/** Where a thread is, in a few words for a list: the file and its lines, or the view's parts. */
export function placeOf(thread: Thread): string {
  const line = thread.anchors.find((a): a is Extract<Anchor, { kind: "line" }> => a.kind === "line");
  if (line) return `${line.path.split("/").pop()}:${line.line}${line.end && line.end > line.line ? `–${line.end}` : ""}`;
  const parts = thread.anchors.flatMap((a) => (a.kind === "part" ? [a.label ?? a.id] : []));
  return parts.length > 0 ? parts.join(", ") : (thread.viewTitle ?? thread.view ?? "");
}

const KEY = "roer:threads";

export function allThreads(): Thread[] {
  try {
    const parsed: unknown = JSON.parse(sharedStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as Thread[]) : [];
  } catch {
    return [];
  }
}

/** Reads, changes and writes back every thread, so a view and a tool call never write over each other. */
export function updateThreads(update: (current: Thread[]) => Thread[]): Thread[] {
  const next = update(allThreads());
  try {
    if (next.length === 0) sharedStorage.removeItem(KEY);
    else sharedStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* kept for as long as the window is open */
  }
  return next;
}

/** Called whenever any thread changes: in this view, another, or by an agent's tool call. */
export const onThreadsChanged = (listener: () => void): (() => void) =>
  onSharedStorage((key) => {
    if (key === KEY) listener();
  });

/** A new thread's id: given ahead of the thread itself where a prompt naming it goes out before it is kept. */
export const newThreadId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function startThread(
  thread: Omit<Thread, "id" | "replies" | "state"> & { id?: string; replies?: Thread["replies"] },
): Thread {
  const replies = thread.replies ?? [];
  // The person has read their own, and every reply of theirs under it; an agent's is for them to see.
  const seen = thread.author ? (replies.length > 0 && replies.every((one) => one.author === "You") ? 1 + replies.length : 0) : 1;
  const started: Thread = { ...thread, id: thread.id ?? newThreadId(), replies, state: "open", seen };
  updateThreads((current) => [...current, started]);
  return started;
}

/** Adds `text` under thread `id`; false when there is no such thread. `mine` says an answer is now due. */
export function replyToThread(id: string, author: string, text: string, mine: boolean, ui?: unknown[]): boolean {
  let found = false;
  updateThreads((current) =>
    current.map((thread) => {
      if (thread.id !== id) return thread;
      found = true;
      const replies = [...thread.replies, { author, text, ...(ui && ui.length > 0 ? { ui } : {}) }];
      // Their own reply means they have read everything above it.
      return { ...thread, state: "open", awaiting: mine, replies, ...(mine ? { seen: 1 + replies.length } : {}) };
    }),
  );
  return found;
}

/** Queues `item` to be typed into thread `id`'s session. */
export function queueOnThread(id: string, item: Outgoing): void {
  updateThreads((current) =>
    current.map((thread) => (thread.id === id ? { ...thread, outbox: [...(thread.outbox ?? []), item] } : thread)),
  );
}

export function setThread(
  id: string,
  change: Partial<Pick<Thread, "state" | "awaiting" | "session" | "outbox" | "retryAt" | "tries" | "sendingSince">>,
): void {
  updateThreads((current) => current.map((thread) => (thread.id === id ? { ...thread, ...change } : thread)));
}

export function deleteThread(id: string): void {
  updateThreads((current) => current.filter((thread) => thread.id !== id));
}

/** A thread to show in the Changes tab: one on a removed line or a commit, which only Changes draws. Kept until the
 * tab asks, since it may come up only after it is asked for. */
let changesReveal: { id: string; seq: number } | null = null;
const revealListeners = new Set<() => void>();

export function revealInChanges(id: string): void {
  changesReveal = { id, seq: (changesReveal?.seq ?? 0) + 1 };
  for (const listener of revealListeners) listener();
}

/** The thread last asked to be shown in Changes, each ask a new `seq`. */
export function useChangesReveal(): { id: string; seq: number } | null {
  const [asked, setAsked] = useState(changesReveal);
  useEffect(() => {
    const listener = () => setAsked(changesReveal);
    revealListeners.add(listener);
    listener();
    return () => void revealListeners.delete(listener);
  }, []);
  return asked;
}

/** Whether only Changes draws the thread: about a removed line, or a line as a commit left it, not the file as it is. */
export const changesOnly = (thread: Thread): boolean =>
  thread.anchors.some((a) => a.kind === "line" && (!!a.side || !!a.commit));

/** The threads `pick` keeps, kept in step with every change to any of them. */
export function useThreads(pick: (thread: Thread) => boolean, deps: readonly unknown[]): Thread[] {
  const [all, setAll] = useState<Thread[]>(allThreads);
  useEffect(() => {
    setAll(allThreads());
    return onThreadsChanged(() => setAll(allThreads()));
  }, []);
  // `pick` is this render's; `deps` are what it picks by.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => all.filter(pick), [all, ...deps]);
}

/** The threads on one file's lines in one worktree (on `branch`, for one read from git). */
export const useFileThreads = (
  root: string,
  path: string,
  branch: string | undefined,
  /** For a worktree's own file: the branch it has checked out, and every checkout of its repository. */
  here?: { branch?: string; checkouts: readonly string[] },
): Thread[] =>
  useThreads(
    (t) =>
      !t.view &&
      t.anchors.some(
        (a) =>
          a.kind === "line" &&
          a.path === path &&
          // On the branch the tab shows, or, in a tab showing the content a thread was written on, that thread.
          // A removed line, or a line as a commit left it, is not in the file as it is: those are Changes' alone.
          !a.side &&
          !a.commit &&
          ((t.root === root && (a.branch === branch || (!!branch && a.blob === branch))) ||
            // Left on this checkout's branch, read from git in another checkout of the repository before this one
            // had it checked out.
            (!!here?.branch && a.branch === here.branch && t.root !== root && here.checkouts.includes(t.root))),
      ),
    [root, path, branch, here?.branch, here?.checkouts],
  );

/** The threads left in one view of one repository. */
export const useViewThreads = (root: string | null, view: string): Thread[] =>
  useThreads((t) => !!root && t.root === root && t.view === view, [root, view]);

/** Whether `cwd` is `root` or somewhere under it. */
const within = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root.replace(/\/+$/, "")}/`);

/** The live session a thread is with; undefined once it has ended, or before its pane has been seen. */
export function liveOf(session: ThreadSession | undefined, sessions: readonly LiveSession[]): LiveSession | undefined {
  if (!session) return undefined;
  return sessions.find((one) => one.pane === session.pane && (!session.id || one.id === session.id));
}

/**
 * Who a new thread about `root` goes to: the stage's session when it works there, else another live session that
 * does, else the stage's own. The repository's own sessions first, since the work on it is there; the stage's as
 * the one the person is looking at.
 */
export function pickSession(
  root: string,
  stage: { pane?: string; root: string | null; agent?: string | null } | null | undefined,
  sessions: readonly LiveSession[],
): ThreadSession | undefined {
  const pin = (one: LiveSession): ThreadSession => ({ pane: one.pane, id: one.id, agent: one.agent, cwd: one.cwd });
  const staged = stage?.pane ? sessions.find((one) => one.pane === stage.pane) : undefined;
  if (staged && stage?.root === root) return pin(staged);
  const here = sessions.find((one) => within(one.cwd, root));
  if (here) return pin(here);
  if (staged) return pin(staged);
  return stage?.pane && stage.agent ? { pane: stage.pane, agent: stage.agent } : undefined;
}

/** A session's name in a thread: its agent, and the folder it works in. */
export function sessionLabel(session: ThreadSession | LiveSession): string {
  const folder = session.cwd?.replace(/\/+$/, "").split("/").pop();
  return [session.agent ?? "agent", folder].filter(Boolean).join(" · ");
}

/** A fence that the code inside it cannot close. */
function fence(code: string): string {
  let ticks = "```";
  while (code.includes(ticks)) ticks += "`";
  return ticks;
}

export const ANSWER_TOOL = "threads__answer";

const lines = (a: Extract<Anchor, { kind: "line" }>) =>
  `${a.side === "old" ? "removed " : ""}${a.end && a.end > a.line ? `lines ${a.line}–${a.end}` : `line ${a.line}`}`;

/** What a thread is about, as the agent is told: each anchor, with its code for a file's lines. */
export function whereOf(thread: Thread): string[] {
  const out: string[] = [];
  const at = (a: Anchor) =>
    a.kind === "line"
      ? `\`${a.path}\` ${lines(a)}${a.commit ? ` as commit ${a.commit.short} ("${a.commit.subject}") left it` : a.branch ? ` as the branch \`${a.branch}\` has it` : ""}`
      : `"${a.label ?? a.id}" (\`${a.id}\`)`;
  const view = thread.view ? ` in my Roer view "${thread.viewTitle ?? thread.view}" (\`${thread.view}\`)` : "";
  out.push(`${thread.anchors.length > 1 ? "These, together" : "This"}${view}, in ${thread.root}:`);
  for (const a of thread.anchors) {
    out.push(`- ${at(a)}`);
    if (a.kind === "line" && a.code.trim()) {
      const f = fence(a.code);
      out.push(f, a.code, f);
    }
  }
  return out;
}

/** The prompt that starts a thread: the person's words are what to do; the answer comes back through the tool. */
export function askPrompt(thread: Thread): string {
  return [
    `I left a comment in Roer.`,
    ...whereOf(thread),
    "",
    thread.text,
    "",
    (thread.intent === "ask"
      ? `This is a question: answer it in the thread with the ${ANSWER_TOOL} tool, thread "${thread.id}". Don't change any files for it; if it calls for a change, say what you would change and I'll ask for it.`
      : `Do what it asks, then answer in the thread with the ${ANSWER_TOOL} tool, thread "${thread.id}": what you did, or your answer to my question.`) +
      (thread.anchors.some((a) => a.kind === "line")
        ? " Line numbers are as the file was when I wrote it; if they have moved, find the spot by the quoted code."
        : ""),
  ].join("\n");
}

/** The prompt for a reply: the whole thread when it is new to the session, which an agent's own thread is not. */
export function replyPrompt(thread: Thread, text: string, whole = false): string {
  const before = whole
    ? [
        `This is Roer's thread "${thread.id}".`,
        ...whereOf(thread),
        "",
        `${thread.author ?? "I"} wrote: ${thread.text}`,
        ...thread.replies.slice(0, -1).map((one) => `${one.author === "You" ? "I" : one.author} wrote: ${one.text}`),
        "",
        "Now I replied:",
      ]
    : [`I replied in Roer's thread "${thread.id}":`];
  return [...before, "", text, "", `Answer with the ${ANSWER_TOOL} tool, thread "${thread.id}".`].join("\n");
}

/** Where a line thread is in the content on screen, and whether its lines are still what it was written on. */
export interface Placed {
  line: number;
  end: number;
  outdated: boolean;
}

/**
 * Moves a thread's lines from the content it was written on to the content on screen, through the diff between
 * them (`git diff -U0`, so hunks only). Lines no hunk touched move by what was added and removed above them; a hunk
 * that changed any of them, or put lines between them, makes the thread outdated, left where its first line went.
 */
export function placeThrough(diff: string, line: number, end: number): Placed {
  let shift = 0;
  let outdated = false;
  for (const header of diff.split("\n").filter((one) => one.startsWith("@@"))) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!m) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount === 0) {
      // `-5,0` adds lines after line 5: above the thread, between its lines, or after it.
      if (oldStart < line) shift += newCount;
      else if (oldStart < end) outdated = true;
    } else {
      // `-5,2` changes lines 5 and 6: above the thread, over any of its lines, or after it.
      const last = oldStart + oldCount - 1;
      if (last < line) shift += newCount - oldCount;
      else if (oldStart <= end) outdated = true;
    }
  }
  return { line: Math.max(1, line + shift), end: Math.max(1, end + shift), outdated };
}

/** A thread's lines found by their words, for one whose content can no longer be diffed: where they are nearest to
 * where they were, or outdated where they were when the words are nowhere. */
export function placeByCode(code: string, lines: readonly string[], line: number, end: number): Placed {
  const want = code.split("\n");
  const at = (start: number) => want.every((text, i) => lines[start - 1 + i] === text);
  if (!code.trim() || at(line)) return { line, end, outdated: false };
  for (let step = 1; step < lines.length; step += 1) {
    for (const start of [line - step, line + step]) {
      if (start >= 1 && start + want.length - 1 <= lines.length && at(start)) {
        return { line: start, end: start + want.length - 1, outdated: false };
      }
    }
  }
  return { line, end, outdated: true };
}
