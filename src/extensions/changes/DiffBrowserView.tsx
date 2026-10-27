import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DiffPane,
  gitBlob,
  gitBranchCommits,
  gitBranchDiff,
  gitBranches,
  gitChanges,
  gitCommitDiff,
  gitCommitFiles,
  gitCurrentBranch,
  gitDiff,
  gitRoot,
  isNextCommit,
  isPrevCommit,
  isUntracked,
  resolveDir,
  shortcutLabel,
  splitPatch,
  useHotkey,
  type useStartSession,
  type BranchDiff,
  type Changes,
  type Commit,
  type FileChange,
  type FilesChanged,
} from "roer";
import type { NewNote, NoteAnswer } from "roer/ui";

import { CommitBox } from "./CommitBox";
import { ReviewMenu } from "./ReviewMenu";
import { answered, commentNote, lineInFile, newCommentId, reviewRequestPrompt, type LocalComment } from "./local";

export interface DiffBrowserViewProps {
  /** Where to put the base picker, Refresh and the commit stepper: the bar of the tab around it. Without it they
   * sit in a bar of the view's own. */
  toolbar?: HTMLElement | null;
  /** The branch to show, picked by the tab around it, which then has the picker; without it the view has its own. */
  branch?: string;
  /** Directory the session was opened in; the repository is whatever holds it. */
  cwd?: string;
  /** The session's pane, so a `cd` inside it moves this view with it. */
  pane?: string;
  /** Whether the view is on top, which is when it takes the keyboard. */
  active: boolean;
  /** The last thing a worktree watch reported, so the local-changes slot
   * does not have to be left and come back to before it moves. */
  changed?: FilesChanged | null;
  /** The branch's comments, to draw on the slot they belong to: a commit's on that commit, the rest on what is
   * not committed. Without `onComments` the view takes none. */
  comments?: readonly LocalComment[];
  onComments?: (update: (current: LocalComment[]) => LocalComment[]) => void;
  /** Who the comments go to, for the buttons on an agent's. */
  agent?: string;
  /** Types a prompt into the session, which is how the commit box asks the agent for a message. */
  send?: (text: string) => Promise<void>;
  /** Starts a new session in `cwd` on a prompt, for a review asked of a fresh one; absent where none can start. */
  startSession?: ReturnType<typeof useStartSession>;
  /** A review was asked for: of the stage's session, or of a new one, which is named the reviewer once it hands
   * its comments over. */
  onReviewAsked?: (by: "here" | "new") => void;
  /** A comment to show, by its id, each time `seq` changes: the slot it is on, then the comment itself. */
  showComment?: { id: string; seq: number };
  /** A prompt went to the session; show it. */
  onSent?: () => void;
  /** The local changes were committed; the new commit's short hash. */
  onCommitted?: (short: string) => void;
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One step of the browser: the branch's whole change, what is not committed, or one commit. */
type Slot = { kind: "all" } | { kind: "local" } | { kind: "commit"; commit: Commit; n: number };

const slotKey = (slot: Slot): string => (slot.kind === "commit" ? slot.commit.hash : slot.kind);

/**
 * One browser for everything a branch has changed: all of it at once since it
 * left its base (what its pull request will show), then the worktree's own
 * uncommitted edits, then each of its commits, oldest first — rather than a
 * separate view for each. The branch as a whole comes first so the view
 * never opens on an empty slot when the work is all committed; it is left out
 * when there are no commits, since then it would be the uncommitted edits
 * twice. Those only show while `branch` is the one actually checked out:
 * they are relative to `HEAD`, so they mean nothing next to some other
 * branch's history you're just browsing, and only once there are some.
 */
export function DiffBrowserView({
  toolbar,
  branch: given,
  cwd,
  pane,
  active,
  changed,
  comments,
  onComments,
  agent = "the agent",
  send,
  startSession,
  onReviewAsked,
  showComment,
  onSent,
  onCommitted,
}: DiffBrowserViewProps) {
  const [root, setRoot] = useState<string | null>(null);
  // Discovery found no repository at all, which has nothing to diff: said so
  // rather than left as an empty view.
  const [notRepo, setNotRepo] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [own, setBranch] = useState("");
  const branch = given || own;
  const [base, setBase] = useState("");
  const [currentBranch, setCurrentBranch] = useState("");
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  /** The slot picked, by its key; null is the first one. A key rather than a place, so a slot coming or going
   * (the edits being committed, say) does not move the view onto another. */
  const [picked, setPicked] = useState<string | null>(null);
  const [whole, setWhole] = useState<BranchDiff | null>(null);
  const [wholeError, setWholeError] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Changes["files"] | null>(null);
  // Which commit `commitFiles` are, so nothing is pointed into the last commit's for the moment after a switch.
  const [commitFilesOf, setCommitFilesOf] = useState<string | null>(null);
  const [commitFilesError, setCommitFilesError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const [localChanges, setLocalChanges] = useState<Changes | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localToken, setLocalToken] = useState(0);

  const dir = useCallback(() => resolveDir(cwd, pane), [cwd, pane]);

  // The stage keeps this view mounted across session switches, and a `cd`
  // moves `pane` to a new directory without remounting anything — so a new
  // `cwd`/`pane` means the repository discovered below may no longer be the
  // right one. Clearing it here makes the discovery effect run again instead
  // of continuing to show the previous session's branches and commits.
  useEffect(() => {
    setRoot(null);
    setNotRepo(false);
    setBranches([]);
    setBranch("");
    setBase("");
    setCurrentBranch("");
    setCommits(null);
    setCommitsError(null);
    setPicked(null);
    setWhole(null);
  }, [cwd, pane]);

  // Discovers the repository once, along with its branches and the one the
  // session is on — the sensible default for "which branch" the first time
  // this comes on screen, and what the local-changes slot compares itself
  // against to decide whether it belongs in the list at all.
  useEffect(() => {
    if (!active || root) return;
    let cancelled = false;

    void dir()
      .then(async (at) => {
        const [rootDir, names, current] = await Promise.all([
          gitRoot(at),
          gitBranches(at),
          gitCurrentBranch(at),
        ]);
        if (cancelled) return;
        if (!rootDir) {
          setNotRepo(true);
          return;
        }
        setRoot(rootDir);
        setBranches(names);
        setCurrentBranch(current);
        const branchToUse = given || current || names[0] || "";
        setBranch((existing) => existing || branchToUse);
        // `main` when the repository has one; otherwise anything but the
        // branch itself, since diffing a branch against its own name is
        // always empty.
        setBase(
          (existing) =>
            existing ||
            (names.includes("main") ? "main" : names.find((name) => name !== branchToUse) ?? names[0] ?? ""),
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCommitsError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [active, dir, root, given]);

  // Whether the worktree's own uncommitted edits belong in this list: only
  // when the picker is showing the branch actually checked out. Browsing
  // some other branch's history has nothing to do with what's sitting
  // uncommitted on disk right now. Branch discovery (for the commits list)
  // and the local-changes load are two separate round trips, so until both
  // branches are known this assumes local changes belong — the ordinary case
  // — rather than hiding them while discovery is still in flight.
  const hasLocal =
    localChanges !== null &&
    (branch === "" || currentBranch === "" || branch === currentBranch);

  // The commits `branch` has that `base` does not, whenever either changes —
  // or Refresh is asked for, since new commits may have landed since.
  useEffect(() => {
    if (!root || !branch || !base) return;
    let cancelled = false;

    void gitBranchCommits(root, branch, base)
      .then((next) => {
        if (cancelled) return;
        setCommits(next);
        setCommitsError(null);
        // Back to the first slot, which is the branch as a whole once there are commits.
        setPicked(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCommits(null);
        setCommitsError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [root, branch, base, currentBranch, token]);

  // Another branch than the one checked out is diffed as its commits alone.
  const head = currentBranch && branch && branch !== currentBranch ? branch : undefined;

  // The branch's whole change since its base, uncommitted edits included, read again after every edit: what
  // the first slot shows.
  useEffect(() => {
    if (!active || !root || !branch || !base) return;
    let cancelled = false;
    void gitBranchDiff(root, base, head)
      .then((next) => {
        if (cancelled) return;
        setWhole(next);
        setWholeError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setWhole(null);
        setWholeError(String(cause));
      });
    return () => {
      cancelled = true;
    };
    // `localToken` too: an edit changes the whole as much as the uncommitted part.
  }, [active, root, branch, base, head, token, localToken]);

  const localCount = localChanges?.files.length ?? 0;
  const slots = useMemo((): Slot[] => {
    const list: Slot[] = [];
    const n = commits?.length ?? 0;
    if (n > 0) list.push({ kind: "all" });
    if (hasLocal && (localCount > 0 || n === 0)) list.push({ kind: "local" });
    (commits ?? []).forEach((one, i) => list.push({ kind: "commit", commit: one, n: i }));
    return list;
  }, [commits, hasLocal, localCount]);
  const count = slots.length;
  const at = Math.max(0, slots.findIndex((one) => slotKey(one) === picked));
  const slot: Slot | undefined = slots[at];
  const isLocalSelected = slot?.kind === "local";
  const isAll = slot?.kind === "all";
  const commit = slot?.kind === "commit" ? slot.commit : undefined;
  const commitIndex = slot?.kind === "commit" ? slot.n : 0;

  // The files one commit touched, against its own parent. Skipped for the
  // local-changes slot, which already has its own files from the load below.
  useEffect(() => {
    if (!root || !commit) {
      setCommitFiles(null);
      return;
    }
    // Cleared up front, not just on failure: without this, `DiffPane` briefly
    // renders the previous commit's files under the new commit's title while
    // this request is in flight.
    setCommitFiles(null);
    setCommitFilesError(null);
    let cancelled = false;

    void gitCommitFiles(root, commit.hash)
      .then((next) => {
        if (cancelled) return;
        setCommitFiles(next);
        setCommitFilesOf(commit.hash);
        setCommitFilesError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCommitFiles(null);
        setCommitFilesError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [root, commit]);

  // Everything below mirrors what a standalone "local changes" view does —
  // reload on arrival, reload on a worktree watch, never more than one
  // reload queued behind a running one — just aimed at `localChanges`
  // instead of a view of its own.
  const shownLocalRoot = useRef<string | null>(null);
  const loadingLocal = useRef(false);
  const pendingLocal = useRef(false);
  const handledLocal = useRef<FilesChanged | null>(null);

  useEffect(() => {
    if (!active) {
      loadingLocal.current = false;
      pendingLocal.current = false;
      return;
    }
    let cancelled = false;
    loadingLocal.current = true;

    void dir()
      .then(gitChanges)
      .then((next) => {
        if (cancelled) return;
        shownLocalRoot.current = next.root;
        setLocalChanges(next);
        setLocalError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLocalChanges(null);
        setLocalError(String(cause));
      })
      .finally(() => {
        if (cancelled) return;
        loadingLocal.current = false;
        if (pendingLocal.current) {
          pendingLocal.current = false;
          setLocalToken((one) => one + 1);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, dir, localToken]);

  useEffect(() => {
    if (!changed || changed === handledLocal.current) return;
    handledLocal.current = changed;
    if (!active) return;
    if (loadingLocal.current) {
      pendingLocal.current = true;
      return;
    }
    if (shownLocalRoot.current === null || changed.root !== shownLocalRoot.current) return;
    setLocalToken((one) => one + 1);
  }, [active, changed]);

  const wholeFiles = useMemo(() => (whole ? splitPatch(whole.diff) : null), [whole]);
  // As the file tree wants them: what git did to each file, and how much.
  const wholeChanges = useMemo(
    (): FileChange[] | null =>
      wholeFiles?.map((file) => ({
        path: file.path,
        staged: ".",
        unstaged: file.status,
        added: file.added,
        deleted: file.deleted,
        renamedFrom: file.renamedFrom ?? null,
        binary: file.binary,
        counted: !file.binary,
      })) ?? null,
    [wholeFiles],
  );

  const loadDiff = useCallback(
    (path: string, untracked: boolean) => {
      if (isAll) {
        const file = wholeFiles?.find((one) => one.path === path);
        return file ? Promise.resolve(file.text) : Promise.reject(new Error(`${path} is not in the branch's diff`));
      }
      if (isLocalSelected) {
        const at = localChanges?.root;
        if (!at) return Promise.reject(new Error("no repository loaded yet"));
        return gitDiff(at, path, untracked);
      }
      if (!root || !commit) return Promise.reject(new Error("no commit selected"));
      return gitCommitDiff(root, commit.hash, path);
    },
    [isAll, wholeFiles, isLocalSelected, root, localChanges, commit],
  );

  // A file whole, on either side of the slot's diff: for a picture, and for Markdown read rendered.
  const loadFile = useCallback(
    (path: string, side: "old" | "new"): Promise<string | null> => {
      if (isLocalSelected) {
        const at = localChanges?.root;
        return at ? gitBlob(at, path, side === "old" ? "HEAD" : undefined) : Promise.resolve(null);
      }
      if (!root) return Promise.resolve(null);
      if (isAll) return whole ? gitBlob(root, path, side === "old" ? whole.from : head) : Promise.resolve(null);
      if (!commit) return Promise.resolve(null);
      return gitBlob(root, path, side === "old" ? `${commit.hash}^` : commit.hash);
    },
    [isLocalSelected, localChanges, root, isAll, whole, head, commit],
  );

  // The comments of the slot on screen. Lines are counted where the slot counts them: a commit's as it left the
  // file, the rest in the file as it is now.
  const notes = useMemo(
    () =>
      (comments ?? [])
        .filter((c) => (isLocalSelected || isAll ? !c.commit : !!commit && c.commit?.hash === commit.hash))
        .map((c) => commentNote(c, agent, true)),
    [comments, isLocalSelected, isAll, commit, agent],
  );

  const files = isAll ? wholeChanges : isLocalSelected ? localChanges?.files ?? null : commitFiles;

  // A comment asked for from outside: its slot first, its commit's or the branch as a whole, then the comment, once
  // that slot's own files are in.
  const [toReveal, setToReveal] = useState<{
    slot: string;
    reveal: { path: string; line: number; side: "old" | "new"; seq: number; note: string };
  } | null>(null);
  useEffect(() => {
    const comment = showComment && comments?.find((one) => one.id === showComment.id);
    if (!showComment || !comment) return;
    const own = comment.commit && slots.some((one) => slotKey(one) === comment.commit?.hash) ? comment.commit.hash : null;
    const slot = own ?? (slots.some((one) => one.kind === "all") ? "all" : "local");
    setPicked(slot);
    setToReveal({ slot, reveal: { path: comment.path, line: comment.line, side: comment.side, seq: showComment.seq, note: comment.id } });
    // Keyed on `seq` alone: asked again for the same comment is still a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showComment?.seq]);
  const reveal =
    toReveal && slot && slotKey(slot) === toReveal.slot && files && (slot.kind !== "commit" || commitFilesOf === slot.commit.hash)
      ? toReveal.reveal
      : undefined;
  const addComment = useCallback(
    (note: NewNote) => {
      if (!onComments) return;
      const file = files?.find((f) => f.path === note.path);
      const on = isLocalSelected || !commit ? undefined : { hash: commit.hash, short: commit.short, subject: commit.subject };
      // The words on the line, read from its diff, are how the agent finds it once numbers move.
      void loadDiff(note.path, file ? isUntracked(file) : false)
        .then((text) => lineInFile(text, note.line, note.side))
        .catch(() => "")
        .then((code) => onComments((current) => [...current, { id: newCommentId(), ...note, code, ...(on ? { commit: on } : {}) }]));
    },
    [onComments, files, isLocalSelected, commit, loadDiff],
  );
  const answer = useCallback(
    (one: NoteAnswer) => onComments?.((current) => answered(current, one)),
    [onComments],
  );

  const title = useMemo((): ReactNode => {
    if (isAll) {
      return (
        <>
          <span className="badge here">All</span> {branch}
          <span className="muted changes-since">
            {" "}
            since {whole?.base || base}
            {head ? "" : ", uncommitted included"}
          </span>
        </>
      );
    }
    if (isLocalSelected) {
      return (
        <>
          <span className="badge here">Local</span> {localChanges?.branch ?? "Local changes"}
        </>
      );
    }
    if (!commit) return "Branch diff";
    return <code>{commit.short}</code>;
  }, [isAll, branch, whole, base, head, isLocalSelected, localChanges, commit]);

  // The slots are read when the key lands, not when the handler was made: a handler only takes over in an
  // effect, after the render that changed them, and a key pressed in between (the list of commits just arrived,
  // Next already enabled on screen) would otherwise step against the old list and go nowhere.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const step = useCallback((delta: 1 | -1) => {
    const list = slotsRef.current;
    const from = Math.max(0, list.findIndex((one) => slotKey(one) === pickedRef.current));
    const next = list[Math.min(list.length - 1, Math.max(0, from + delta))];
    if (next) setPicked(slotKey(next));
  }, []);

  const [asked, setAsked] = useState<string | null>(null);
  const askForReview = () => {
    if (!send || !whole) return;
    setAsked(null);
    void send(reviewRequestPrompt(whole.base))
      .then(() => {
        onReviewAsked?.("here");
        setAsked(`Asked ${agent} for a review: its comments will show here.`);
        onSent?.();
      })
      .catch((cause: unknown) => setAsked(String(cause)));
  };
  // Started in this checkout, so the new session's comments are filed under the same branch.
  const reviewInNewSession = async (pickAgent = false) => {
    if (!startSession || !whole || !root) return;
    setAsked(null);
    if (!(await startSession(root, reviewRequestPrompt(whole.base), { pickAgent }))) return;
    onReviewAsked?.("new");
    setAsked("Started a new session on the review: its comments will show here.");
  };

  // `Cmd+Left`/`Cmd+Right` (`Alt` off macOS) step through the whole list — the branch as a whole, local
  // changes when there are some, then the commits — the same way the Prev/Next buttons do.
  // Gated on `active` in the match itself, not just the handler:
  // this view stays mounted on other tabs, and a match that ignored `active`
  // would still swallow the keystroke there (Cmd+Left/Right moves a cursor to
  // the start/end of a line in a native text field).
  useHotkey(
    useCallback((event: KeyboardEvent) => active && isPrevCommit(event), [active]),
    useCallback(() => step(-1), [step]),
  );
  useHotkey(
    useCallback((event: KeyboardEvent) => active && isNextCommit(event), [active]),
    useCallback(() => step(1), [step]),
  );

  if (notRepo) {
    return (
      <div className="branch-diff" aria-label="Changes">
        <p className="muted pad">This session's folder is not a git repository, so it has no changes to show.</p>
      </div>
    );
  }

  const controls = (
    <div className={toolbar === undefined ? "branch-diff-pickers" : "branch-diff-pickers inline"}>
      {given ? null : (
        <label>
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            {!branches.includes(branch) && branch ? <option value={branch}>{branch}</option> : null}
            {branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        vs.
        <select aria-label="Base" value={base} onChange={(e) => setBase(e.target.value)}>
          {!branches.includes(base) ? <option value={base}>{base}</option> : null}
          {branches.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={toolbar === undefined ? "link" : "link icon-refresh"}
        aria-label="Refresh"
        title="Read the branch and its commits again"
        onClick={() => {
          setToken((n) => n + 1);
          setLocalToken((n) => n + 1);
        }}
      >
        {/* In the tab's bar, where room is short, the arrow alone. */}
        {toolbar === undefined ? "Refresh" : "↻"}
      </button>
      {count > 0 ? (
        <div className="seg" role="group" aria-label="Commit">
          <button
            type="button"
            aria-label="Previous commit"
            title={`Previous commit (${shortcutLabel.prevCommit()})`}
            disabled={at <= 0}
            onClick={() => step(-1)}
          >
            {shortcutLabel.prevCommit()}
          </button>
          {isAll ? (
            <span className="badge here" title="Everything the branch has changed since it left its base">
              All changes
            </span>
          ) : isLocalSelected ? (
            <span className="badge here">Local changes</span>
          ) : (
            <span className="muted">
              commit {commitIndex + 1} of {commits?.length ?? 0}
            </span>
          )}
          <button
            type="button"
            aria-label="Next commit"
            title={`Next commit (${shortcutLabel.nextCommit()})`}
            disabled={at >= count - 1}
            onClick={() => step(1)}
          >
            {shortcutLabel.nextCommit()}
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="branch-diff" aria-label="Changes">
      {toolbar === undefined ? controls : toolbar && active ? createPortal(controls, toolbar) : null}

      {commitsError ? <p className="error">{commitsError}</p> : null}

      {commits && commits.length === 0 ? (
        <p className="muted pad">
          {branch} has no commits {base} does not already have.
        </p>
      ) : null}

      {count > 0 ? (
        <DiffPane
          files={files}
          error={isAll ? wholeError : isLocalSelected ? localError : commitFilesError}
          active={active}
          loadDiff={loadDiff}
          loadFile={loadFile}
          resetKey={isAll ? `all:${root ?? ""}` : isLocalSelected ? `local:${localChanges?.root ?? ""}` : (commit?.hash ?? "")}
          refreshToken={isLocalSelected ? localToken : undefined}
          reveal={reveal}
          title={title}
          headerExtra={
            isAll && !head && (send || startSession) ? (
              <ReviewMenu
                agent={agent}
                onHere={send ? askForReview : undefined}
                onNew={startSession && root ? () => void reviewInNewSession() : undefined}
                onNewWith={startSession && root ? () => void reviewInNewSession(true) : undefined}
                disabled={!whole || !whole.diff}
              />
            ) : undefined
          }
          banner={
            isAll ? (
              whole?.note || asked ? (
                <>
                  {whole?.note ? <p className="notice">{whole.note}</p> : null}
                  {asked ? <p className="notice">{asked}</p> : null}
                </>
              ) : undefined
            ) : isLocalSelected ? (
              localChanges && localChanges.files.length > 0 ? (
                <CommitBox
                  root={localChanges.root}
                  pane={pane}
                  send={send}
                  agent={agent}
                  unsent={(comments ?? []).filter((c) => !c.commit).length}
                  onSent={onSent}
                  onCommitted={(short) => {
                    // The new commit joins the list, and what was uncommitted is gone from the first slot.
                    setToken((n) => n + 1);
                    setLocalToken((n) => n + 1);
                    onCommitted?.(short);
                  }}
                />
              ) : undefined
            ) : commit ? (
              <CommitMessage key={commit.hash} commit={commit} />
            ) : undefined
          }
          emptyMessage={
            isAll
              ? "Nothing has changed on this branch yet."
              : isLocalSelected
              ? "No local changes. The worktree matches HEAD."
              : "This commit touched no files."
          }
          defaultLayout={isLocalSelected ? "split" : undefined}
          notes={onComments ? notes : undefined}
          onNoteAnswer={onComments ? answer : undefined}
          onAddNote={onComments ? addComment : undefined}
          data-testid="changes"
          aria-label="Diff"
        />
      ) : null}
    </div>
  );
}

/** A commit message past this many lines of body is cut there until it is asked for in full. */
const BODY_LINES = 4;

/**
 * A commit's whole message above its diff: the subject in full however long,
 * the body under it (an agent's can run long, so past a few lines it waits to
 * be opened), and who made it when.
 */
function CommitMessage({ commit }: { commit: Commit }) {
  const [open, setOpen] = useState(false);
  const lines = commit.body ? commit.body.split("\n") : [];
  const long = lines.length > BODY_LINES;
  return (
    <div className="commit-message">
      <p className="commit-subject">{commit.subject}</p>
      {commit.body ? (
        <p className="commit-body">{long && !open ? `${lines.slice(0, BODY_LINES).join("\n")}…` : commit.body}</p>
      ) : null}
      <p className="commit-meta muted">
        {commit.author}, {when(commit.date)}
        {long ? (
          <button type="button" className="link" onClick={() => setOpen((was) => !was)}>
            {open ? "Show less" : `Show all ${lines.length} lines`}
          </button>
        ) : null}
      </p>
    </div>
  );
}
