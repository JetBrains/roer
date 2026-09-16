import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { changedRange, pairRows, parseDiff, type DiffLine, type Hunk } from "./lib/diff";
import { paint } from "./lib/highlight";
import {
  changeKind,
  gitChanges,
  gitDiff,
  isStaged,
  isUntracked,
  statusLetter,
  type Changes,
  type FileChange,
} from "./lib/git";
import { listSessions } from "./lib/pty";
import { ancestors, buildTree, fileOrder, rows } from "./lib/tree";

export interface ChangesViewProps {
  /** Directory the session was opened in; the repository is whatever holds it. */
  cwd?: string;
  /** The session's pane, so a `cd` inside it moves this view with it. */
  pane?: string;
  /** Whether the view is on top, which is when it takes the keyboard. */
  active: boolean;
}

/** Where the selection is: a file, and which of its hunks. */
interface Selection {
  path: string;
  /** `"last"` asks for the final hunk of a file whose diff is still loading,
   * which is what stepping backwards into a file means. */
  at: number | "last";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How a hunk is drawn: the terminal's diff, or an IDE's. */
type Layout = "unified" | "split";

/** What `git diff` prints: one column, a marker per line, both numbers. */
function Unified({ hunk }: { hunk: Hunk }) {
  return (
    <>
      {hunk.lines.map((line, j) => (
        <div key={j} className={`line ${line.kind}`}>
          <span className="no">{line.oldNo ?? ""}</span>
          <span className="no">{line.newNo ?? ""}</span>
          <span className="mark">
            {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
          </span>
          <span className="text">
            <Code text={line.text} />
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * A line of code, coloured the way an editor colours it, with the run that
 * differs from `other` picked out on top of that.
 */
function Code({ text, other }: { text: string; other?: string }) {
  const spans = paint(text, other === undefined ? undefined : changedRange(text, other));
  return (
    <>
      {spans.map((span, i) => (
        <span key={i} className={span.marked ? `t-${span.kind} ink` : `t-${span.kind}`}>
          {span.text}
        </span>
      ))}
    </>
  );
}

/** One half of a row. No line at all is the gap opposite an edit. */
function Side({
  line,
  other,
  which,
}: {
  line?: DiffLine;
  /** The line this one replaced, or was replaced by, if any. */
  other?: DiffLine;
  which: "old" | "new";
}) {
  if (!line) return <span className="side gap" />;
  return (
    <span className={`side ${line.kind}`}>
      <span className="no">{(which === "old" ? line.oldNo : line.newNo) ?? ""}</span>
      <span className="text">
        <Code text={line.text} other={other?.text} />
      </span>
    </span>
  );
}

/** What an IDE shows: the old file on the left, the new one on the right. */
function Split({ hunk }: { hunk: Hunk }) {
  return (
    <>
      {pairRows(hunk).map((row, j) =>
        row.kind === "meta" ? (
          <div key={j} className="line meta">
            <span className="text">{row.left?.text}</span>
          </div>
        ) : (
          <div key={j} className="pair">
            <Side
              line={row.left}
              other={row.kind === "change" ? row.right : undefined}
              which="old"
            />
            <Side
              line={row.right}
              other={row.kind === "change" ? row.left : undefined}
              which="new"
            />
          </div>
        ),
      )}
    </>
  );
}

/**
 * Local changes: the folder tree on the left, the selected file's diff on the
 * right, and the arrow keys stepping through the changes themselves.
 */
export function ChangesView({ cwd, pane, active }: ChangesViewProps) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [layout, setLayout] = useState<Layout>("split");
  const [token, setToken] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  /**
   * The directory to ask about. A session's own directory moves — `cd` in the
   * terminal is the usual way to change repository — so the live pane is the
   * better answer, and the directory it was opened in is the fallback.
   */
  const resolveDir = useCallback(async () => {
    if (pane) {
      try {
        const live = (await listSessions()).find((s) => s.pane === pane)?.cwd;
        if (live) return live;
      } catch {
        /* The shim is unavailable; the opening directory is still right
           unless the session has moved. */
      }
    }
    return cwd ?? "";
  }, [cwd, pane]);

  // Reloaded whenever the view comes to the front: the session behind it has
  // been editing files the whole time it was hidden.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    void resolveDir()
      .then(gitChanges)
      .then((next) => {
        if (cancelled) return;
        setChanges(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setChanges(null);
        setError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [active, resolveDir, token]);

  const tree = useMemo(() => buildTree(changes?.files ?? []), [changes]);
  const order = useMemo(() => fileOrder(tree), [tree]);
  const visible = useMemo(() => rows(tree, collapsed), [tree, collapsed]);

  const selected: FileChange | undefined = useMemo(
    () => order.find((file) => file.path === selection?.path),
    [order, selection],
  );

  // A file that stopped being changed — committed, or reverted — cannot stay
  // selected, and the first change is the one the user wants next.
  useEffect(() => {
    if (!changes) return;
    setSelection((current) => {
      if (current && changes.files.some((file) => file.path === current.path)) return current;
      const first = changes.files[0];
      return first ? { path: first.path, at: 0 } : null;
    });
  }, [changes]);

  const root = changes?.root;
  const path = selected?.path;
  const untracked = selected ? isUntracked(selected) : false;

  useEffect(() => {
    if (!root || !path) {
      setDiff(null);
      return;
    }
    let cancelled = false;

    void gitDiff(root, path, untracked)
      .then((text) => {
        if (cancelled) return;
        setDiff({ path, text });
        setDiffError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setDiffError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [root, path, untracked, token]);

  // Only ever the diff of the selected file: a slow answer for the file that
  // was selected two keystrokes ago must not be drawn under this one's name.
  const parsed = useMemo(
    () => (diff && diff.path === selection?.path ? parseDiff(diff.text) : null),
    [diff, selection],
  );

  const index = useMemo(() => {
    const count = parsed?.hunks.length ?? 0;
    if (count === 0) return 0;
    if (selection?.at === "last") return count - 1;
    return Math.min(selection?.at ?? 0, count - 1);
  }, [parsed, selection]);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    // Stepping into a file inside a closed folder opens the folder; the
    // selection is never somewhere the tree cannot show it.
    setCollapsed((current) => {
      const hidden = ancestors(next.path).filter((dir) => current.has(dir));
      if (hidden.length === 0) return current;
      const open = new Set(current);
      for (const dir of hidden) open.delete(dir);
      return open;
    });
  }, []);

  /** Moves the selection by whole files, landing on `at` in the new one. */
  const stepFile = useCallback(
    (delta: 1 | -1, at: number | "last") => {
      if (order.length === 0) return;
      const from = order.findIndex((file) => file.path === selection?.path);
      const next = order[from < 0 ? 0 : from + delta];
      if (next) select({ path: next.path, at });
    },
    [order, select, selection],
  );

  /** Next or previous change, crossing into the next file at the edges. */
  const stepHunk = useCallback(
    (delta: 1 | -1) => {
      if (!selection) {
        stepFile(1, 0);
        return;
      }
      // Without the parsed diff there is no telling where the edges are; the
      // keystroke is dropped rather than guessed at.
      if (!parsed) return;
      const next = index + delta;
      if (next >= 0 && next < parsed.hunks.length) {
        setSelection({ path: selection.path, at: next });
        return;
      }
      stepFile(delta, delta === 1 ? 0 : "last");
    },
    [index, parsed, selection, stepFile],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    const step: Record<string, () => void> = {
      ArrowDown: () => stepHunk(1),
      ArrowUp: () => stepHunk(-1),
      ArrowRight: () => stepFile(1, 0),
      ArrowLeft: () => stepFile(-1, 0),
    };
    const move = step[event.key];
    if (!move) return;
    // Otherwise the pane scrolls as well, and the selection leaves the view.
    event.preventDefault();
    move();
  };

  // The keys belong to this view while it is on top, and nothing else in it
  // is focusable on arrival.
  useEffect(() => {
    if (active) rootRef.current?.focus();
  }, [active]);

  // Follow the selection with the scroll, in both panes. `nearest` keeps a
  // selection that is already visible exactly where it is.
  useEffect(() => {
    hunkRefs.current[index]?.scrollIntoView?.({ block: "nearest" });
  }, [index, diff]);

  useEffect(() => {
    if (selection) rowRefs.current.get(selection.path)?.scrollIntoView?.({ block: "nearest" });
  }, [selection]);

  const toggle = (dir: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });

  const count = changes?.files.length ?? 0;

  return (
    <div
      className="changes"
      data-testid="changes"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Local changes"
    >
      <header className="changes-head">
        {changes ? (
          <>
            <strong>{changes.branch}</strong>
            <span className="muted">{plural(count, "file", "files")} changed</span>
            <span className="muted keys">↑↓ change · ←→ file</span>
          </>
        ) : (
          <strong>Local changes</strong>
        )}
        <div className="seg" role="group" aria-label="Diff layout">
          <button
            type="button"
            className={layout === "split" ? "on" : undefined}
            aria-pressed={layout === "split"}
            title="Side by side, the way an IDE shows a diff"
            onClick={() => setLayout("split")}
          >
            Side by side
          </button>
          <button
            type="button"
            className={layout === "unified" ? "on" : undefined}
            aria-pressed={layout === "unified"}
            title="One column with + and −, the way a terminal shows a diff"
            onClick={() => setLayout("unified")}
          >
            Unified
          </button>
        </div>
        <button type="button" className="link" onClick={() => setToken((n) => n + 1)}>
          Refresh
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}

      {changes && count === 0 ? (
        <p className="muted pad">No local changes. The worktree matches HEAD.</p>
      ) : null}

      {count > 0 ? (
        <div className="changes-body">
          <ul className="tree" aria-label="Changed files">
            {visible.map((row) => {
              const isSelected = row.kind === "file" && row.path === selection?.path;
              const indent = { paddingLeft: `${6 + row.depth * 12}px` };
              return (
                <li key={`${row.kind}:${row.path}`}>
                  {row.kind === "dir" ? (
                    <button
                      type="button"
                      className="tree-row dir"
                      style={indent}
                      onClick={() => toggle(row.path)}
                      aria-expanded={!collapsed.has(row.path)}
                    >
                      <span className="caret">{collapsed.has(row.path) ? "▸" : "▾"}</span>
                      <span className="name">{row.name}</span>
                      <span className="muted">{row.count}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      ref={(node) => {
                        rowRefs.current.set(row.path, node);
                      }}
                      className={isSelected ? "tree-row file selected" : "tree-row file"}
                      style={indent}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => select({ path: row.path, at: 0 })}
                    >
                      <span className={isStaged(row.file) ? "letter staged" : "letter"}>
                        {statusLetter(row.file)}
                      </span>
                      <span className="name">{row.name}</span>
                      {row.file.binary ? (
                        <span className="muted">bin</span>
                      ) : (
                        <span className="counts">
                          <span className="plus">+{row.file.added}</span>
                          <span className="minus">−{row.file.deleted}</span>
                        </span>
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="diff" aria-label="Diff">
            {selected ? (
              <div className="diff-head">
                <span className="kind">{changeKind(selected)}</span>
                <strong className="path">{selected.path}</strong>
                {selected.renamedFrom ? (
                  <span className="muted">renamed from {selected.renamedFrom}</span>
                ) : null}
                {parsed && parsed.hunks.length > 0 ? (
                  <span className="muted at">
                    change {index + 1} of {parsed.hunks.length}
                  </span>
                ) : null}
              </div>
            ) : null}

            {diffError ? <p className="error">{diffError}</p> : null}

            {parsed?.binary ? <p className="muted pad">Binary file — nothing to show.</p> : null}

            {parsed && !parsed.binary && parsed.hunks.length === 0 ? (
              <p className="muted pad">No textual change — a mode or an empty file.</p>
            ) : null}

            {parsed?.hunks.map((hunk, i) => (
              <div
                // Hunks have no identity of their own; within one diff the
                // position is the identity.
                key={`${selected?.path}:${i}`}
                ref={(node) => {
                  hunkRefs.current[i] = node;
                }}
                className={i === index ? "hunk current" : "hunk"}
              >
                <div className="hunk-head">{hunk.header}</div>
                {layout === "split" ? <Split hunk={hunk} /> : <Unified hunk={hunk} />}
              </div>
            ))}

            {parsed?.truncated ? (
              <p className="muted pad">The rest of this diff is too large to show.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
