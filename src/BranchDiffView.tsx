import { useCallback, useEffect, useMemo, useState } from "react";

import { DiffPane } from "./DiffPane";
import {
  gitBranchCommits,
  gitBranches,
  gitCommitDiff,
  gitCommitFiles,
  gitCurrentBranch,
  gitRoot,
  type Commit,
} from "./lib/git";
import { isNextCommit, isPrevCommit, useHotkey } from "./lib/keys";
import { resolveDir } from "./lib/session";

export interface BranchDiffViewProps {
  /** Directory the session was opened in; the repository is whatever holds it. */
  cwd?: string;
  /** The session's pane, so a `cd` inside it moves this view with it. */
  pane?: string;
  /** Whether the view is on top, which is when it takes the keyboard. */
  active: boolean;
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
 * A branch's own commits, one at a time, each diffed against its parent —
 * the way a reviewer reads a branch rather than the way `git diff` collapses
 * it into a single change. `base` names the range: everything `branch` has
 * that `base` does not.
 */
export function BranchDiffView({ cwd, pane, active }: BranchDiffViewProps) {
  const [root, setRoot] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("main");
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<Awaited<ReturnType<typeof gitCommitFiles>> | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const dir = useCallback(() => resolveDir(cwd, pane), [cwd, pane]);

  // Discovers the repository once, along with its branches and the one the
  // session is on — the sensible default for "which branch" the first time
  // this comes on screen.
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
        if (cancelled || !rootDir) return;
        setRoot(rootDir);
        setBranches(names);
        setBranch((existing) => existing || current || names[0] || "");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCommitsError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [active, dir, root]);

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
  }, [root, branch, base, token]);

  const commit = commits?.[index];

  // The files one commit touched, against its own parent.
  useEffect(() => {
    if (!root || !commit) {
      setFiles(null);
      return;
    }
    let cancelled = false;

    void gitCommitFiles(root, commit.hash)
      .then((next) => {
        if (cancelled) return;
        setFiles(next);
        setFilesError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFiles(null);
        setFilesError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [root, commit]);

  const loadDiff = useCallback(
    (path: string, _untracked: boolean) => {
      if (!root || !commit) return Promise.reject(new Error("no commit selected"));
      return gitCommitDiff(root, commit.hash, path);
    },
    [root, commit],
  );

  const title = useMemo(() => {
    if (!commit) return "Branch diff";
    return `${commit.subject} — ${commit.short} by ${commit.author}, ${when(commit.date)}`;
  }, [commit]);

  const count = commits?.length ?? 0;

  // `Cmd+Left`/`Cmd+Right` step through commits the same way the Prev/Next
  // buttons do. Gated on `active` in the match itself, not just the handler:
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

  return (
    <div className="branch-diff" aria-label="Branch diff">
      <div className="branch-diff-pickers">
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
        <label>
          vs.
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {!branches.includes(base) ? <option value={base}>{base}</option> : null}
            {branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="link" onClick={() => setToken((n) => n + 1)}>
          Refresh
        </button>
        {commits ? (
          <div className="seg" role="group" aria-label="Commit">
            <button
              type="button"
              aria-label="Previous commit"
              title="Previous commit (⌘←)"
              disabled={index <= 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              ⌘←
            </button>
            <span className="muted">
              commit {count === 0 ? 0 : index + 1} of {count}
            </span>
            <button
              type="button"
              aria-label="Next commit"
              title="Next commit (⌘→)"
              disabled={index >= count - 1}
              onClick={() => setIndex((i) => Math.min(count - 1, i + 1))}
            >
              ⌘→
            </button>
          </div>
        ) : null}
      </div>

      {commitsError ? <p className="error">{commitsError}</p> : null}

      {commits && count === 0 ? (
        <p className="muted pad">
          {branch} has no commits {base} does not already have.
        </p>
      ) : null}

      {count > 0 ? (
        <DiffPane
          files={files}
          error={filesError}
          active={active}
          loadDiff={loadDiff}
          resetKey={commit?.hash ?? ""}
          title={title}
          emptyMessage="This commit touched no files."
          data-testid="branch-diff"
          aria-label="Commit diff"
        />
      ) : null}
    </div>
  );
}
