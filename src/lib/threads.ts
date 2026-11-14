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
  replies: { author: string; text: string }[];
  state: "open" | "resolved";
  /** The last word is the person's, and it has gone to the agent: an answer is due. */
  awaiting?: boolean;
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

const newId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function startThread(thread: Omit<Thread, "id" | "replies" | "state">): Thread {
  const started: Thread = { ...thread, id: newId(), replies: [], state: "open" };
  updateThreads((current) => [...current, started]);
  return started;
}

/** Adds `text` under thread `id`; false when there is no such thread. `mine` says an answer is now due. */
export function replyToThread(id: string, author: string, text: string, mine: boolean): boolean {
  let found = false;
  updateThreads((current) =>
    current.map((thread) => {
      if (thread.id !== id) return thread;
      found = true;
      return { ...thread, state: "open", awaiting: mine, replies: [...thread.replies, { author, text }] };
    }),
  );
  return found;
}

export function setThread(id: string, change: Partial<Pick<Thread, "state" | "awaiting" | "session">>): void {
  updateThreads((current) => current.map((thread) => (thread.id === id ? { ...thread, ...change } : thread)));
}

export function deleteThread(id: string): void {
  updateThreads((current) => current.filter((thread) => thread.id !== id));
}

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
export const useFileThreads = (root: string, path: string, branch: string | undefined): Thread[] =>
  useThreads(
    (t) => t.root === root && !t.view && t.anchors.some((a) => a.kind === "line" && a.path === path && a.branch === branch),
    [root, path, branch],
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

const lines = (a: Extract<Anchor, { kind: "line" }>) => (a.end && a.end > a.line ? `lines ${a.line}–${a.end}` : `line ${a.line}`);

/** What a thread is about, as the agent is told: each anchor, with its code for a file's lines. */
export function whereOf(thread: Thread): string[] {
  const out: string[] = [];
  const at = (a: Anchor) =>
    a.kind === "line" ? `\`${a.path}\` ${lines(a)}${a.branch ? ` as the branch \`${a.branch}\` has it` : ""}` : `"${a.label ?? a.id}" (\`${a.id}\`)`;
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
    `Do what it asks, then answer in the thread with the ${ANSWER_TOOL} tool, thread "${thread.id}": what you did, or your answer to my question.` +
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
