import { useCallback, useEffect, useRef, useState } from "react";

import { DiffPane } from "./DiffPane";
import { type FilesChanged } from "./lib/files";
import { gitChanges, gitDiff, type Changes } from "./lib/git";
import { resolveDir } from "./lib/session";

export interface ChangesViewProps {
  /** Directory the session was opened in; the repository is whatever holds it. */
  cwd?: string;
  /** The session's pane, so a `cd` inside it moves this view with it. */
  pane?: string;
  /** Whether the view is on top, which is when it takes the keyboard. */
  active: boolean;
  /** The last thing a worktree watch reported, so the diff does not have to
   * be left and come back to before it moves. */
  changed?: FilesChanged | null;
}

/**
 * Local changes: the worktree against `HEAD`, with the folder tree on the
 * left and the selected file's diff on the right. The tree and diff
 * rendering itself lives in `DiffPane`, shared with `BranchDiffView`; this
 * component's own job is knowing when to reload `git status`.
 */
export function ChangesView({ cwd, pane, active, changed }: ChangesViewProps) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  // Which worktree the changes on screen belong to, so an event for another
  // repository is ignored without a render to find that out.
  const shownRoot = useRef<string | null>(null);
  // `git status` over a big repo is 1.7 s and a batch lands every few hundred
  // milliseconds, so reloads would stack faster than they finish. One more
  // reload is queued behind the running one, never a queue of them.
  const loading = useRef(false);
  const pending = useRef(false);
  // The event this view has already acted on, so coming back to the front
  // does not reload twice for it.
  const handled = useRef<FilesChanged | null>(null);

  // Shared with Go to File, which has to answer the same question.
  const dir = useCallback(() => resolveDir(cwd, pane), [cwd, pane]);

  // Reloaded whenever the view comes to the front: the session behind it has
  // been editing files the whole time it was hidden.
  useEffect(() => {
    if (!active) {
      // Nothing is out, and nothing is queued behind it: the load on the way
      // back to the front is what covers whatever the flag was holding, and
      // leaving it set would spend a second `git status` on arrival.
      loading.current = false;
      pending.current = false;
      return;
    }
    let cancelled = false;
    loading.current = true;

    void dir()
      .then(gitChanges)
      .then((next) => {
        if (cancelled) return;
        shownRoot.current = next.root;
        setChanges(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setChanges(null);
        setError(String(cause));
      })
      .finally(() => {
        // Not when cancelled: a newer load is already running and owns the
        // flag now.
        if (cancelled) return;
        loading.current = false;
        if (pending.current) {
          pending.current = false;
          setToken((one) => one + 1);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, dir, token]);

  // The watch saw the worktree move. Same reload the front of the tab and
  // the reload button ask for, on a change instead of on a look.
  useEffect(() => {
    if (!changed || changed === handled.current) return;
    handled.current = changed;
    // A hidden tab already re-reads on the way in, so it needs nothing here.
    if (!active) return;
    // A load is out, and it may have been taken before this change. Before
    // the first one lands there is no root to compare against either, so
    // this is also what keeps the opening load from being the one answer
    // that is never checked.
    if (loading.current) {
      pending.current = true;
      return;
    }
    // Nothing on screen, and nothing out to put something there.
    if (shownRoot.current === null || changed.root !== shownRoot.current)
      return;
    setToken((one) => one + 1);
  }, [active, changed]);

  const root = changes?.root;
  const loadDiff = useCallback(
    (path: string, untracked: boolean) => {
      if (!root) return Promise.reject(new Error("no repository loaded yet"));
      return gitDiff(root, path, untracked);
    },
    [root],
  );

  return (
    <DiffPane
      files={changes?.files ?? null}
      error={error}
      active={active}
      loadDiff={loadDiff}
      resetKey={root ?? ""}
      refreshToken={token}
      defaultLayout="split"
      title={changes?.branch ?? "Local changes"}
      emptyMessage="No local changes. The worktree matches HEAD."
      headerExtra={
        <button
          type="button"
          className="link"
          onClick={() => setToken((n) => n + 1)}
        >
          Refresh
        </button>
      }
    />
  );
}
