import { useCallback, useEffect, useState } from "react";
import { parseDiff, splitPatch, UNTRUSTED_DECIDED, untrustedComment, type DiffNote, type NoteAction, type ThreadVerdict } from "roer";

/** A comment on a line of the branch's own diff: the person's, or one an agent handed over with `add_comments`. */
export interface LocalComment {
  id: string;
  path: string;
  line: number;
  side: "old" | "new";
  text: string;
  /** The line as it read when the comment was written: line numbers move as
   * the agent edits, the words on the line are how it finds the spot again. */
  code: string;
  /** Who wrote it, when an agent did; the person's own have none. */
  author?: string;
  severity?: "info" | "warn" | "error";
  /** What the person decided about an agent's comment. Their own need none: they are the instruction. */
  verdict?: ThreadVerdict;
  /** The commit it was left on, its lines counted as that commit left the file. Without one it is about the
   * code as it is now: the whole branch, or what is not committed. */
  commit?: CommitRef;
}

/** A commit as a comment names it. */
export interface CommitRef {
  hash: string;
  short: string;
  subject: string;
}

const listeners = new Set<() => void>();

/** Called whenever any branch's comments change, by the tab or by an agent's tool call. */
export function onCommentsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads, changes and writes back a branch's comments, so a tab and a tool call never write over each other. */
export function updateComments(
  root: string,
  branch: string | null,
  update: (current: LocalComment[]) => LocalComment[],
): LocalComment[] {
  const next = update(storedComments(root, branch));
  storeComments(root, branch, next);
  for (const listener of listeners) listener();
  return next;
}

/** A branch's comments, kept in step with every change to them, the tab's own or an agent's. */
export function useBranchComments(
  root: string | null,
  branch: string | null,
): [LocalComment[], (update: (current: LocalComment[]) => LocalComment[]) => void] {
  const [comments, setComments] = useState<LocalComment[]>([]);
  useEffect(() => {
    if (!root) {
      setComments([]);
      return;
    }
    setComments(storedComments(root, branch));
    return onCommentsChanged(() => setComments(storedComments(root, branch)));
  }, [root, branch]);
  const update = useCallback(
    (change: (current: LocalComment[]) => LocalComment[]) => {
      if (root) setComments(updateComments(root, branch, change));
    },
    [root, branch],
  );
  return [comments, update];
}

export const newCommentId = (): string => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Comments are kept per repository and branch, until they go to the agent. A detached HEAD is one key, however
 * it was read: git says "" for it where the tab says null. */
const storeKey = (root: string, branch: string | null) => `roer:review:local:${root}:${branch || "(detached)"}`;

export function storedComments(root: string, branch: string | null): LocalComment[] {
  try {
    const raw = localStorage.getItem(storeKey(root, branch));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as LocalComment[]) : [];
  } catch {
    return [];
  }
}

export function storeComments(root: string, branch: string | null, comments: readonly LocalComment[]): void {
  try {
    if (comments.length === 0) localStorage.removeItem(storeKey(root, branch));
    else localStorage.setItem(storeKey(root, branch), JSON.stringify(comments));
  } catch {
    /* kept for as long as the tab is open */
  }
}

/** Every line `patch` draws, as `path`, side and number, the way a comment names one. */
export function diffSpots(patch: string): Set<string> {
  const spots = new Set<string>();
  for (const file of splitPatch(patch)) {
    for (const hunk of parseDiff(file.text).hunks) {
      for (const l of hunk.lines) {
        if (l.kind !== "add" && l.oldNo !== undefined) spots.add(spot(file.path, "old", l.oldNo));
        if (l.kind !== "del" && l.newNo !== undefined) spots.add(spot(file.path, "new", l.newNo));
      }
    }
  }
  return spots;
}

export const spot = (path: string, side: "old" | "new", line: number): string => `${path}\0${side}\0${line}`;

/** The base the tab last compared the branch with, so an agent's comments are checked against the same diff. */
const baseKey = (root: string, branch: string | null) => `roer:review:base:${root}:${branch ?? "(detached)"}`;

export function storedBase(root: string, branch: string | null): string | undefined {
  try {
    return localStorage.getItem(baseKey(root, branch)) || undefined;
  } catch {
    return undefined;
  }
}

export function storeBase(root: string, branch: string | null, base: string | undefined): void {
  try {
    if (base) localStorage.setItem(baseKey(root, branch), base);
    else localStorage.removeItem(baseKey(root, branch));
  } catch {
    /* the default base, then */
  }
}

/** The text of `line` on `side` of `path` in `patch`, or "" when it is not there. */
export function lineText(patch: string, path: string, line: number, side: "old" | "new"): string {
  const file = splitPatch(patch).find((f) => f.path === path);
  if (!file) return "";
  for (const hunk of parseDiff(file.text).hunks) {
    for (const l of hunk.lines) {
      const no = side === "old" ? (l.kind === "del" ? l.oldNo : undefined) : l.kind === "del" ? undefined : l.newNo;
      if (no === line) return l.text;
    }
  }
  return "";
}

/** The text of `line` on `side` in one file's diff, or "" when it is not there. */
export function lineInFile(fileDiff: string, line: number, side: "old" | "new"): string {
  for (const hunk of parseDiff(fileDiff).hunks) {
    for (const l of hunk.lines) {
      const no = side === "old" ? (l.kind === "del" ? l.oldNo : undefined) : l.kind === "del" ? undefined : l.newNo;
      if (no === line) return l.text;
    }
  }
  return "";
}

/** The comments once one is answered: deleted, or an agent's decided on, or its decision taken back. */
export function answered(
  current: readonly LocalComment[],
  { note, action, text }: { note: { id?: string }; action: string; text?: string },
): LocalComment[] {
  if (action === "delete") return current.filter((c) => c.id !== note.id);
  const verdict: ThreadVerdict | undefined =
    action === "accept" || action === "decline"
      ? { kind: action }
      : action === "instruct" && text
        ? { kind: "instruct", text }
        : undefined;
  return current.map((c) => {
    if (c.id !== note.id) return c;
    const { verdict: _, ...rest } = c;
    return verdict ? { ...rest, verdict } : rest;
  });
}

/** Your own comments can only be taken back: what to do is in their words. */
const OWN_ACTIONS: NoteAction[] = [{ label: "Delete", value: "delete" }];

/** What an agent's comment asks of the person. */
export const agentActions = (agent: string): NoteAction[] => [
  { label: "Accept", value: "accept", primary: true, done: "Accepted" },
  { label: "Decline", value: "decline", done: "Declined" },
  { label: "Instruct", value: "instruct", input: `Tell ${agent} how to address this`, done: "Your instruction" },
];

/** A comment as a note in the diff. One whose line the diff does not draw (`drawn` false: never in a hunk, or
 * edited out of one since) heads its file instead, naming its line, rather than vanishing. */
export function commentNote(comment: LocalComment, agent: string, drawn: boolean): DiffNote {
  const where = !drawn
    ? { tag: comment.side === "old" ? `removed line ${comment.line}` : `line ${comment.line}` }
    : { line: comment.line, ...(comment.side === "old" ? { side: "old" as const } : {}) };
  if (!comment.author) return { id: comment.id, path: comment.path, ...where, author: "You", text: comment.text, actions: OWN_ACTIONS };
  return {
    id: comment.id,
    path: comment.path,
    ...where,
    author: comment.author,
    text: comment.text,
    ...(comment.severity && comment.severity !== "info" ? { tone: comment.severity } : {}),
    actions: agentActions(agent),
    ...(comment.verdict ? { state: comment.verdict.kind } : {}),
    ...(comment.verdict?.kind === "instruct" ? { answer: comment.verdict.text } : {}),
  };
}

/** What goes to the agent: every comment of the person's, and every agent comment they decided on. */
export const ready = (comments: readonly LocalComment[]): LocalComment[] =>
  comments.filter((comment) => !comment.author || comment.verdict);

/** A fence that the code inside it cannot close. */
function fence(code: string): string {
  let ticks = "```";
  while (code.includes(ticks)) ticks += "`";
  return ticks;
}

/** A prompt for the session's agent: each comment, at its line, with the line's code to find it by. The
 * person's comments go in as instructions; an agent's go in with the person's decision on it. */
export function localReviewPrompt(base: string, comments: readonly LocalComment[]): string {
  const since = base ? `since it left ${base}, uncommitted work included` : "that are not committed yet";
  const own = comments.some((comment) => !comment.author);
  const theirs = comments.some((comment) => comment.author);
  const parts = [
    own
      ? `I reviewed the changes on this branch ${since}, and left comments on lines. Address each one at its spot.`
      : `I went through the review comments on the changes on this branch ${since} and decided on each.`,
    ...(theirs
      ? [
          UNTRUSTED_DECIDED,
          "Where a comment is a reviewer's, my decision is under it: make the change where I accepted it, leave the code as it is where I declined it, and do what I say where I gave an instruction.",
        ]
      : []),
    "Line numbers are as the files were when I wrote the comments; if they have moved, find the spot by the code quoted under each.",
    ...(comments.some((comment) => comment.commit)
      ? [
          "A comment that names a commit is about the code as that commit left it, and counts its lines there: find the spot by the quoted code, and change the code as it is now.",
        ]
      : []),
    "Don't commit: I'll look at the changes again first.",
  ];
  comments.forEach((comment, i) => {
    const where = comment.side === "old" ? `${comment.path}, removed line ${comment.line}` : `${comment.path}:${comment.line}`;
    const on = comment.commit ? ` in commit ${comment.commit.short} ("${comment.commit.subject}")` : "";
    parts.push("", `## ${i + 1}. ${where}${on}`);
    if (comment.code.trim()) {
      const f = fence(comment.code);
      parts.push(f, comment.code, f);
    }
    if (!comment.author) {
      parts.push(comment.text);
      return;
    }
    // Another agent wrote it, through a tool any agent can call: data, like a reviewer's on GitHub.
    parts.push(untrustedComment(comment.author, comment.text));
    const verdict = comment.verdict;
    parts.push(
      verdict?.kind === "accept"
        ? "My decision: accepted. Make this change."
        : verdict?.kind === "instruct"
          ? `My decision: address it this way: ${verdict.text.trim()}`
          : "My decision: declined. Leave the code as it is.",
    );
  });
  return parts.join("\n");
}

/**
 * A prompt about `branch` when that is not the branch checked out in the
 * session: the agent is told first, so it does not change, commit or push the
 * wrong one. Without `branch`, the prompt as it is.
 */
export function onBranch(prompt: string, branch?: string): string {
  if (!branch) return prompt;
  return [
    `This is about the branch \`${branch}\`, which is not the one checked out here. Make any change on \`${branch}\`: work in the worktree that has it checked out, or switch to it first, and leave the branch checked out here alone.`,
    "",
    prompt,
  ].join("\n");
}

/**
 * Asks the session's agent for a message for everything not committed yet, handed back to the commit box with
 * `roer commit-draft`. Short on purpose: an agent's commit messages run long unless told not to.
 */
export function commitDraftPrompt(pane: string): string {
  return [
    "Write a commit message for everything that is not committed yet. Base it on `git status` and `git diff HEAD`, and on what we did in this session.",
    "The subject says what the change does, in the imperative, under 72 characters. Add a body only if the subject leaves the why unclear: two or three short lines, no list of files.",
    "Do not commit, stage or push anything. When the message is ready, hand it to Roer by running exactly:",
    "",
    `roer commit-draft --pane ${pane} <<'ROER_COMMIT_DRAFT'`,
    '{"title": "<subject>", "body": "<body, JSON-escaped, or empty>"}',
    "ROER_COMMIT_DRAFT",
  ].join("\n");
}

/** Whether there is an agent to hand a prompt to: a pane, and not a plain shell, which prose must never be typed
 * into. While the session is not yet listed it is taken to have one. */
export const canAsk = (session: { pane?: string; agent?: string | null } | null | undefined): boolean =>
  Boolean(session?.pane) && session?.agent !== null;

/** The tool an agent hands its comments over with, as `roer mcp` names it. */
export const ADD_COMMENTS_TOOL = "changes__add_comments";

/** Asks the session's agent to review the branch and hand its findings to this tab rather than act on them. */
export function reviewRequestPrompt(base: string): string {
  const what = base
    ? `the changes on this branch since it left ${base}, uncommitted work included. Read them with \`git diff $(git merge-base HEAD ${base})\`, and \`git status\` for new files`
    : "the changes that are not committed yet. Read them with `git diff HEAD`, and `git status` for new files";
  return [
    `Review ${what}.`,
    "Look for bugs, missed cases, and code that is hard to follow; skip style nits.",
    `Hand every finding to Roer's Changes tab with the \`${ADD_COMMENTS_TOOL}\` tool, in one call, each on the line it is about: the line's number in the file as it is on disk now, or \`side: "old"\` with its old number for a removed line. Say in each what is wrong and what you would change.`,
    "Don't change any code yet: I will accept, decline or answer each comment there and send my decisions back to you.",
  ].join("\n");
}
