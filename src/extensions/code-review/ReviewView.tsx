import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitBranchDiff,
  gitCurrentBranch,
  ghPrDiff,
  ghPrForBranch,
  ghPrReview,
  ghStatus,
  openUrl,
  resolveDir,
  reviewDecisionsPrompt,
  splitPatch,
  threadLine,
  type BranchDiff,
  type DiffNote,
  type PrReview,
  type PrSummary,
  type ReviewThread,
  type Session,
  type ThreadVerdict,
} from "roer";
import { Button, DiffView, EmptyState, type NewNote, type NoteAction, type NoteAnswer } from "roer/ui";

import {
  commentNote,
  lineText,
  localReviewPrompt,
  newCommentId,
  onCommentsChanged,
  ready as readyToSend,
  reviewRequestPrompt,
  storedComments,
  storeBase,
  diffSpots,
  spot,
  updateComments,
  type LocalComment,
} from "./local";

export interface ReviewViewProps {
  session: Session | null;
  active: boolean;
  /** The prompt went to the session; show it. */
  onSent?: () => void;
  /** Asks for the Pull Request tab, which is where one is opened. */
  onOpenPullRequest?: () => void;
  /** How many threads are still waiting on a decision. */
  onOpenCount?: (count: number) => void;
}

/** A decision, and whether it has gone to the agent yet. */
interface Decided {
  verdict: ThreadVerdict;
  sent: boolean;
}

type Loaded =
  | { kind: "loading" }
  | { kind: "message"; text: string }
  | { kind: "noPr" }
  | { kind: "ready"; dir: string; pr: PrSummary; diff: string; review: PrReview };

/** The branch's own diff, which needs no pull request and no GitHub. */
type Local =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  /** `branch` is git's, as the `add_comments` tool reads it; `asked` the base it was compared with, if not the default. */
  | { kind: "ready"; diff: BranchDiff; branch: string | null; asked?: string };

const storeKey = (pr: PrSummary) => `roer:review:${pr.url}`;

/** Decisions are kept per pull request, so a reload or a session switch does not lose them. */
function stored(pr: PrSummary): Record<string, Decided> {
  try {
    const raw = localStorage.getItem(storeKey(pr));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, Decided>) : {};
  } catch {
    return {};
  }
}

function store(pr: PrSummary, decided: Record<string, Decided>): void {
  try {
    localStorage.setItem(storeKey(pr), JSON.stringify(decided));
  } catch {
    /* kept for as long as the tab is open */
  }
}

function agentName(session: Session | null): string {
  const agent = session?.agent;
  return agent ? agent[0].toUpperCase() + agent.slice(1) : "the agent";
}

/** A thread as a note in the diff: on its line, or heading its file once the line has gone. */
function threadNote(thread: ReviewThread, decided: Decided | undefined): DiffNote {
  const [first, ...rest] = thread.comments;
  const was = threadLine(thread);
  const tags = [
    thread.isResolved ? "resolved" : null,
    thread.isOutdated ? (was === null ? "outdated" : `outdated · line ${was}`) : null,
    decided?.sent ? "sent" : null,
  ].filter(Boolean);
  return {
    id: thread.id,
    path: thread.path,
    ...(thread.line === null || thread.isOutdated ? {} : { line: thread.line }),
    ...(thread.diffSide === "LEFT" ? { side: "old" as const } : {}),
    author: first?.author ?? "ghost",
    text: first?.body ?? "",
    replies: rest.map((comment) => ({ author: comment.author, text: comment.body })),
    ...(tags.length > 0 ? { tag: tags.join(" · ") } : {}),
    ...(first?.url ? { url: first.url } : {}),
    ...(decided ? { state: decided.verdict.kind } : {}),
    ...(decided?.verdict.kind === "instruct" ? { answer: decided.verdict.text } : {}),
  };
}

/**
 * The branch's pull request as a reviewer left it: GitHub's diff, with every
 * review thread drawn on its line. Each thread is accepted, declined, or
 * given an instruction, and the decisions go to the session's agent together.
 */
export function ReviewView({ session, active, onSent, onOpenPullRequest, onOpenCount }: ReviewViewProps) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, Decided>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [reveal, setReveal] = useState<{ path: string; line: number; side?: "old" | "new"; seq: number }>();
  const [sending, setSending] = useState(false);
  const [local, setLocal] = useState<Local>({ kind: "loading" });
  const [comments, setComments] = useState<LocalComment[]>([]);
  /** Picked by hand; until then the pull request when there is one. */
  const [picked, setPicked] = useState<"pr" | "local" | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);
  const generation = useRef(0);
  /** The session and branch the pull request on screen was loaded for. */
  const loadedFor = useRef<string | null>(null);

  const cwd = session?.cwd;
  const pane = session?.pane;
  const branch = session?.branch;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    setRefreshing(true);
    setError(null);
    // Another branch's pull request, and what was decided on it, must not stay on screen (or be sent) while
    // this one's is looked up, or if looking it up fails.
    const key = `${cwd ?? ""}\0${pane ?? ""}\0${branch ?? ""}`;
    if (loadedFor.current !== key) {
      loadedFor.current = key;
      setLoaded({ kind: "loading" });
      setDecided({});
    }
    // The local diff needs no GitHub: it is read at once against the default base, and again only if
    // the pull request turns out to go into some other branch.
    const readLocal = async (base?: string) => {
      try {
        const dir = await resolveDir(cwd, pane);
        const diff = await gitBranchDiff(dir, base);
        const onBranch = await gitCurrentBranch(diff.root).catch(() => null);
        if (!current()) return;
        storeBase(diff.root, onBranch, base);
        setComments(storedComments(diff.root, onBranch));
        setLocal({ kind: "ready", diff, branch: onBranch, ...(base ? { asked: base } : {}) });
        return diff;
      } catch (cause) {
        if (current()) setLocal({ kind: "error", text: String(cause) });
      }
    };
    const localFirst = readLocal();
    let localAgain: Promise<unknown> = Promise.resolve();
    try {
      const dir = await resolveDir(cwd, pane);
      const gh = await ghStatus(dir);
      if (!current()) return;
      if (!gh.installed || !gh.authenticated || !gh.repo) {
        setLoaded({ kind: "message", text: gh.message ?? "This directory is not in a GitHub repository." });
        return;
      }
      const pr = await ghPrForBranch(dir);
      if (!current()) return;
      if (!pr) {
        setLoaded({ kind: "noPr" });
        return;
      }
      localAgain = localFirst.then((diff) => {
        const base = diff?.base ?? "";
        if (base !== pr.baseRefName && base !== `origin/${pr.baseRefName}`) return readLocal(pr.baseRefName);
      });
      const [diff, review] = await Promise.all([ghPrDiff(dir, pr.number), ghPrReview(dir, pr.number)]);
      if (!current()) return;
      setDecided(stored(pr));
      setLoaded({ kind: "ready", dir, pr, diff, review });
    } catch (cause) {
      if (current()) setError(String(cause));
    } finally {
      await localFirst;
      await localAgain;
      if (current()) setRefreshing(false);
    }
  }, [cwd, pane, branch]);

  // Again whenever the tab comes to the top: comments land while it is away.
  useEffect(() => {
    if (active) void load();
  }, [active, load, branch]);

  const mode = picked ?? (loaded.kind === "ready" ? "pr" : loaded.kind === "loading" ? null : "local");

  // The local diff is the worktree's: it follows every save while it is on screen.
  const changed = session?.changed;
  useEffect(() => {
    if (!active || mode !== "local" || !changed || local.kind !== "ready" || changed.root !== local.diff.root) return;
    const { asked } = local;
    const root = local.diff.root;
    // A save can come with a checkout: the branch is read again with the diff, and comments go under it. A
    // load that starts meanwhile is the newer answer, so this one is dropped.
    const mine = generation.current;
    void Promise.all([gitBranchDiff(root, asked), gitCurrentBranch(root).catch(() => null)])
      .then(([diff, onBranch]) => {
        if (mine !== generation.current) return;
        setComments(storedComments(diff.root, onBranch));
        setLocal({ kind: "ready", diff, branch: onBranch, ...(asked ? { asked } : {}) });
      })
      .catch((cause: unknown) => {
        if (mine === generation.current) setLocal({ kind: "error", text: String(cause) });
      });
    // Keyed on the batch of changes alone: a fresh diff is the answer to it, not a reason for another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);

  const ready = loaded.kind === "ready" ? loaded : null;
  const threads = useMemo(() => ready?.review.threads ?? [], [ready]);
  const open = threads.filter((thread) => !thread.isResolved);
  const undecided = open.filter((thread) => !decided[thread.id]);
  const unsent = threads.filter((thread) => decided[thread.id] && !decided[thread.id].sent);

  // An agent's comments wait on the person as much as a reviewer's threads do.
  const awaiting = comments.filter((c) => c.author && !c.verdict);
  useEffect(() => {
    onOpenCount?.(undecided.length + awaiting.length);
  }, [onOpenCount, undecided.length, awaiting.length]);

  const notes = useMemo(
    () => threads.filter((t) => showResolved || !t.isResolved).map((t) => threadNote(t, decided[t.id])),
    [threads, decided, showResolved],
  );

  const agent = agentName(session);
  const actions = useMemo<NoteAction[]>(
    () => [
      { label: "Accept", value: "accept", primary: true, done: "Accepted" },
      { label: "Decline", value: "decline", done: "Declined" },
      { label: "Instruct", value: "instruct", input: `Tell ${agent} how to address this`, done: "Your instruction" },
    ],
    [agent],
  );

  const decide = useCallback(
    ({ note, action, text }: NoteAnswer) => {
      if (!ready || !note.id) return;
      const id = note.id;
      setDecided((current) => {
        const next = { ...current };
        if (action === "accept" || action === "decline") next[id] = { verdict: { kind: action }, sent: false };
        else if (action === "instruct" && text) next[id] = { verdict: { kind: "instruct", text }, sent: false };
        else delete next[id];
        store(ready.pr, next);
        return next;
      });
    },
    [ready],
  );

  // Round the threads still to decide, from the one shown last.
  const shownId = useRef<string | null>(null);
  const nextComment = () => {
    if (undecided.length === 0) return;
    const shown = undecided.findIndex((thread) => thread.id === shownId.current);
    const target = undecided[(shown + 1) % undecided.length];
    shownId.current = target.id;
    setReveal((last) => ({
      path: target.path,
      // An outdated thread heads its file: its first change is as near as it gets.
      line: target.isOutdated ? 0 : (target.line ?? 0),
      side: target.diffSide === "LEFT" ? "old" : "new",
      seq: (last?.seq ?? 0) + 1,
    }));
  };

  const send = async () => {
    if (!ready || !session || unsent.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const prompt = reviewDecisionsPrompt(
        ready.pr,
        unsent.map((thread) => ({ thread, verdict: decided[thread.id].verdict })),
      );
      await session.send(prompt);
      setDecided((current) => {
        const next = { ...current };
        for (const thread of unsent) next[thread.id] = { ...next[thread.id], sent: true };
        store(ready.pr, next);
        return next;
      });
      onSent?.();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSending(false);
    }
  };

  const localReady = local.kind === "ready" ? local.diff : null;
  const localBranch = local.kind === "ready" ? local.branch : null;
  // Checked against every fresh diff: an edit can move a commented line out of its hunk, or the file out of the
  // diff altogether.
  const { localNotes, strays } = useMemo(() => {
    const patch = localReady?.diff ?? "";
    const files = new Set(splitPatch(patch).map((file) => file.path));
    const drawn = diffSpots(patch);
    return {
      localNotes: comments
        .filter((c) => files.has(c.path))
        .map((c) => commentNote(c, agent, drawn.has(spot(c.path, c.side, c.line)))),
      strays: comments.filter((c) => !files.has(c.path)),
    };
  }, [comments, agent, localReady]);
  const toSend = readyToSend(comments);

  // An agent's tool call can add comments at any time; the tab shows them as they land.
  const localRoot = localReady?.root;
  useEffect(() => {
    if (!localRoot) return;
    return onCommentsChanged(() => setComments(storedComments(localRoot, localBranch)));
  }, [localRoot, localBranch]);

  const setKept = useCallback(
    (update: (current: LocalComment[]) => LocalComment[]) => {
      if (!localReady) return;
      setComments(updateComments(localReady.root, localBranch, update));
    },
    [localReady, localBranch],
  );

  const addComment = useCallback(
    (note: NewNote) => {
      if (!localReady) return;
      const code = lineText(localReady.diff, note.path, note.line, note.side);
      const id = newCommentId();
      setSentNote(null);
      setKept((current) => [...current, { id, ...note, code }]);
    },
    [localReady, setKept],
  );

  const answerLocal = useCallback(
    ({ note, action, text }: NoteAnswer) => {
      if (action === "delete") {
        setKept((current) => current.filter((c) => c.id !== note.id));
        return;
      }
      const verdict: ThreadVerdict | undefined =
        action === "accept" || action === "decline"
          ? { kind: action }
          : action === "instruct" && text
            ? { kind: "instruct", text }
            : undefined;
      setKept((current) =>
        current.map((c) => {
          if (c.id !== note.id) return c;
          const { verdict: _, ...rest } = c;
          return verdict ? { ...rest, verdict } : rest;
        }),
      );
    },
    [setKept],
  );

  const askForReview = async () => {
    if (!localReady || !session) return;
    setError(null);
    try {
      await session.send(reviewRequestPrompt(localReady.base));
      setSentNote(`Asked ${agent} for a review: its comments will show here.`);
      onSent?.();
    } catch (cause) {
      setError(String(cause));
    }
  };

  const sendLocal = async () => {
    if (!localReady || !session || toSend.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const sent = toSend;
      await session.send(localReviewPrompt(localReady.base, sent));
      // Sent comments are done with: the agent is about to move the lines they sat on.
      setKept((current) => current.filter((c) => !sent.some((one) => one.id === c.id)));
      setSentNote(`Sent ${sent.length} ${sent.length === 1 ? "comment" : "comments"} to ${agent}.`);
      onSent?.();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSending(false);
    }
  };

  if (!session) return <p className="muted pad">No session on the stage.</p>;

  const modes = (
    <div className="seg" role="group" aria-label="What to review">
      <button type="button" className={mode === "pr" ? "on" : undefined} aria-pressed={mode === "pr"} onClick={() => setPicked("pr")}>
        Pull request
      </button>
      <button
        type="button"
        className={mode === "local" ? "on" : undefined}
        aria-pressed={mode === "local"}
        onClick={() => setPicked("local")}
      >
        Local changes
      </button>
    </div>
  );

  if (mode === "local") {
    const since = localReady?.base
      ? `${localReady.commits} ${localReady.commits === 1 ? "commit" : "commits"} since ${localReady.base}, and what is not committed`
      : "what is not committed";
    return (
      <div className="review">
        <header className="review-head">
          <strong>Local changes</strong>
          {localReady ? <span className="muted">{since}</span> : null}
          <span className="review-spacer" />
          {modes}
          <Button onClick={() => void load()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button onClick={() => void askForReview()} disabled={!localReady || !localReady.diff || !session.pane}>
            Review with {agent}
          </Button>
          <Button variant="primary" onClick={() => void sendLocal()} disabled={sending || toSend.length === 0 || !session.pane}>
            Send {toSend.length} to {agent}
          </Button>
        </header>

        {error ? <p className="error">{error}</p> : null}
        {localReady?.note ? <p className="notice">{localReady.note}</p> : null}
        {sentNote ? <p className="notice">{sentNote}</p> : null}
        {strays.length > 0 ? (
          <p className="notice">
            {strays.length === 1 ? "A comment is" : `${strays.length} comments are`} on{" "}
            {strays.map((c) => `${c.path}:${c.line}`).join(", ")}, which this diff no longer changes. They go
            with the rest when you send; delete them if they no longer apply.{" "}
            <button
              type="button"
              className="link"
              onClick={() => setKept((current) => current.filter((c) => !strays.some((one) => one.id === c.id)))}
            >
              Delete them
            </button>
          </p>
        ) : null}

        {local.kind === "loading" ? <EmptyState variant="loading" text="Reading the branch…" /> : null}
        {local.kind === "error" ? <EmptyState variant="error" text="Could not read the local changes" detail={local.text} /> : null}
        {localReady ? (
          <>
            {localReady.diff && comments.length === 0 && !sentNote ? (
              <p className="muted pad">
                Hover a line and press + to comment on it, or ask {agent} to review and answer its comments. Send
                hands every comment to {agent} at once.
              </p>
            ) : null}
            <DiffView
              patch={localReady.diff}
              title={session.branch ?? "Local changes"}
              layout="unified"
              emptyText="Nothing has changed on this branch yet."
              notes={localNotes}
              onNoteAnswer={answerLocal}
              onAddNote={addComment}
              aria-label="Local changes"
            />
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="review">
      <header className="review-head">
        {ready ? (
          <>
            <strong>
              <button type="button" className="link" onClick={() => void openUrl(ready.pr.url)}>
                #{ready.pr.number}
              </button>{" "}
              {ready.pr.title}
            </strong>
            <span className="muted">
              {open.length} open · {undecided.length} to decide
            </span>
          </>
        ) : (
          <strong>Review</strong>
        )}
        <span className="review-spacer" />
        {modes}
        {ready ? (
          <>
            <label className="gen-checkbox">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
              <span>Show resolved</span>
            </label>
            <Button variant="borderless" onClick={nextComment} disabled={undecided.length === 0}>
              Next comment
            </Button>
          </>
        ) : null}
        <Button onClick={() => void load()} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
        {ready ? (
          <Button
            variant="primary"
            onClick={() => void send()}
            disabled={sending || unsent.length === 0 || !session.pane}
          >
            Send {unsent.length} to {agent}
          </Button>
        ) : null}
      </header>

      {error ? <p className="error">{error}</p> : null}
      {awaiting.length > 0 ? (
        <p className="notice">
          {awaiting[0].author} left {awaiting.length} {awaiting.length === 1 ? "comment" : "comments"} on your local
          changes.{" "}
          <button type="button" className="link" onClick={() => setPicked("local")}>
            Show them
          </button>
        </p>
      ) : null}

      {loaded.kind === "loading" ? <p className="muted pad">Loading the pull request…</p> : null}
      {loaded.kind === "message" ? <p className="muted pad">{loaded.text}</p> : null}
      {loaded.kind === "noPr" ? (
        <p className="muted pad">
          This branch has no pull request yet.{" "}
          {onOpenPullRequest ? (
            <button type="button" className="link" onClick={onOpenPullRequest}>
              Open one
            </button>
          ) : null}
        </p>
      ) : null}

      {ready ? (
        <>
          {ready.review.truncated ? (
            <p className="notice">
              This pull request has more review comments than Roer loads at once; some are not shown.
            </p>
          ) : null}
          <DiffView
            patch={ready.diff}
            title={`${ready.pr.headRefName} → ${ready.pr.baseRefName}`}
            layout="unified"
            emptyText="This pull request changes nothing."
            notes={notes}
            noteActions={actions}
            onNoteAnswer={decide}
            reveal={reveal}
            aria-label="Pull request diff"
          />
        </>
      ) : null}
    </div>
  );
}
