import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DiffPane,
  gitBranchCommits,
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
  useHotkey,
  type Changes,
  type Commit,
  type FilesChanged,
} from "roer";
import type { NewNote, NoteAnswer } from "roer/ui";

import { CommitBox } from "./CommitBox";
import { answered, commentNote, lineInFile, newCommentId, type LocalComment } from "./local";

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

/**
 * One browser for everything a repository's history can show: the worktree's
 * own uncommitted edits as the first slot, followed by the branch's own
 * commits against a base, oldest first — rather than a separate tab for
 * each. The local-changes slot only exists while `branch` is the one
 * actually checked out: uncommitted edits are relative to `HEAD`, so they
 * mean nothing next to some other branch's history you're just browsing.
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
  const [index, setIndex] = useState(0);
  const [commitFiles, setCommitFiles] = useState<Changes["files"] | null>(null);
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
    setIndex(0);
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
        // Index 0 is always the right default: it's the local-changes slot
        // when there is one, and otherwise the oldest commit shown.
        setIndex(0);
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

  const count = (commits?.length ?? 0) + (hasLocal ? 1 : 0);
  const isLocalSelected = hasLocal && index === 0;
  const commitIndex = hasLocal ? index - 1 : index;
  const commit = !isLocalSelected ? commits?.[commitIndex] : undefined;

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

  const loadDiff = useCallback(
    (path: string, untracked: boolean) => {
      if (isLocalSelected) {
        const at = localChanges?.root;
        if (!at) return Promise.reject(new Error("no repository loaded yet"));
        return gitDiff(at, path, untracked);
      }
      if (!root || !commit) return Promise.reject(new Error("no commit selected"));
      return gitCommitDiff(root, commit.hash, path);
    },
    [isLocalSelected, root, localChanges, commit],
  );

  // The comments of the slot on screen. Lines are counted where the slot counts them: a commit's as it left the
  // file, the rest in the file as it is now.
  const notes = useMemo(
    () =>
      (comments ?? [])
        .filter((c) => (isLocalSelected ? !c.commit : !!commit && c.commit?.hash === commit.hash))
        .map((c) => commentNote(c, agent, true)),
    [comments, isLocalSelected, commit, agent],
  );

  const files = isLocalSelected ? localChanges?.files ?? null : commitFiles;
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
    if (isLocalSelected) {
      return (
        <>
          <span className="badge here">Local</span> {localChanges?.branch ?? "Local changes"}
        </>
      );
    }
    if (!commit) return "Branch diff";
    return <code>{commit.short}</code>;
  }, [isLocalSelected, localChanges, commit]);

  // `Cmd+Left`/`Cmd+Right` (`Alt` off macOS) step through the whole list — local changes, when
  // it's there, followed by commits — the same way the Prev/Next buttons do.
  // Gated on `active` in the match itself, not just the handler:
  // this view stays mounted on other tabs, and a match that ignored `active`
  // would still swallow the keystroke there (Cmd+Left/Right moves a cursor to
  // the start/end of a line in a native text field).
  useHotkey(
    useCallback((event: KeyboardEvent) => active && isPrevCommit(event), [active]),
    useCallback(() => setIndex((i) => Math.max(0, i - 1)), []),
  );
  useHotkey(
    useCallback((event: KeyboardEvent) => active && isNextCommit(event), [active]),
    useCallback(() => setIndex((i) => Math.min(count - 1, i + 1)), [count]),
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
            disabled={index <= 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            {shortcutLabel.prevCommit()}
          </button>
          {isLocalSelected ? (
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
            disabled={index >= count - 1}
            onClick={() => setIndex((i) => Math.min(count - 1, i + 1))}
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
          error={isLocalSelected ? localError : commitFilesError}
          active={active}
          loadDiff={loadDiff}
          resetKey={isLocalSelected ? `local:${localChanges?.root ?? ""}` : (commit?.hash ?? "")}
          refreshToken={isLocalSelected ? localToken : undefined}
          title={title}
          banner={
            isLocalSelected ? (
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
            isLocalSelected
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
