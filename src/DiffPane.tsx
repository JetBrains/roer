import {
  createContext,
  Fragment,
  memo,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Spans } from "./CodeLine";
import { isCardNote, NoteCard, NoteComposer, type NoteAction, type NoteAnswer } from "./DiffNote";
import {
  changedRange,
  pairRows,
  type DiffNote,
  parseDiff,
  type DiffLine,
  type Hunk,
} from "./lib/diff";
import {
  highlight,
  loadLang,
  paint,
  ready,
  toSpans,
  type Colouring,
} from "./lib/highlight";
import { langFor } from "./lib/lang";
import {
  changeKind,
  isStaged,
  isUntracked,
  statusLetter,
  type FileChange,
} from "./lib/git";
import { ancestors, buildTree, fileOrder, rows } from "./lib/tree";

export interface DiffPaneProps {
  /** `null` while the file list itself is still loading. */
  files: FileChange[] | null;
  error: string | null;
  /** Whether this pane is on top, which is when it takes the keyboard. */
  active: boolean;
  loadDiff: (path: string, untracked: boolean) => Promise<string>;
  /** Changing this — a different commit, a different repository — clears
   * the selection, since a file at the same path may no longer be the same
   * change. */
  resetKey: string | number;
  /** Changing this re-reads the selected file's diff without touching the
   * selection — a plain reload, where the file list may look identical by
   * reference but the file on disk has moved on. */
  refreshToken?: string | number;
  /** What the header calls this diff: a branch name, or a commit's subject. */
  title: ReactNode;
  /** Shown in place of the tree when `files` is an empty array. */
  emptyMessage: ReactNode;
  /** Extra controls in the header, alongside the layout toggle. */
  headerExtra?: ReactNode;
  "data-testid"?: string;
  "aria-label"?: string;
  /** The layout shown before the viewer picks one. @default "unified" */
  defaultLayout?: "unified" | "split";
  /** Notes drawn into the diff under the lines they are about. */
  notes?: DiffNote[];
  /** How a note with an `id` can be answered: a button each, under it. */
  noteActions?: readonly NoteAction[];
  /** A note was answered with one of `noteActions`. */
  onNoteAnswer?: (answer: NoteAnswer) => void;
  /** Selects `path` at the change holding `line`, each time `seq` changes —
   * how something outside the pane points into it. */
  reveal?: { path: string; line: number; side?: "old" | "new"; seq: number };
  /** Lets the viewer write a comment on any line: each gets a + that opens
   * a field under it, and what is written comes here. Drawing it is up to
   * the owner, as one of `notes`. */
  onAddNote?: (note: NewNote) => void;
}

/** A comment written on a line of the diff. */
export interface NewNote {
  path: string;
  line: number;
  side: "old" | "new";
  text: string;
}

/** A line as a comment would name it: a removed line by its old number,
 * any other by its new one. */
type Spot = { line: number; side: "old" | "new" };

function spotOf(line: DiffLine): Spot | undefined {
  if (line.kind === "del") return line.oldNo === undefined ? undefined : { line: line.oldNo, side: "old" };
  return line.newNo === undefined ? undefined : { line: line.newNo, side: "new" };
}

/** Where the selection is: a file, and which of its hunks. */
interface Selection {
  path: string;
  /** `"last"` asks for the final hunk of a file whose diff is still loading,
   * which is what stepping backwards into a file means; a line asks for the
   * hunk that holds it, which is only known once the diff is in. */
  at: number | "last" | { line: number; side: "old" | "new" };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How a hunk is drawn: the terminal's diff, or an IDE's. */
type Layout = "unified" | "split";

/**
 * The grammar's tokens for the file on screen, or null while none has loaded.
 *
 * Carried in context rather than through `Unified`, `Split` and `Side`: those
 * three know about layout and nothing about colour, and threading a map
 * through them for `Code` alone would say the opposite.
 */
const Coloured = createContext<Colouring | null>(null);

/** The selected file's notes by `side:line`, and how they are answered,
 * carried like `Coloured` so the layouts need not know about them. */
const Notes = createContext<{
  byLine: ReadonlyMap<string, DiffNote[]>;
  actions?: readonly NoteAction[];
  onAnswer?: (answer: NoteAnswer) => void;
  /** Set when lines take comments: the line being written on, and how. */
  compose?: {
    at: Spot | null;
    open: (at: Spot) => void;
    submit: (at: Spot, text: string) => void;
    cancel: () => void;
  };
}>({ byLine: new Map() });

/** The + beside a line that starts a comment on it. */
function AddNote({ line }: { line: DiffLine }) {
  const { compose } = useContext(Notes);
  const at = spotOf(line);
  if (!compose || !at) return null;
  return (
    <button
      type="button"
      className="line-add"
      aria-label={`Comment on line ${at.line}`}
      title="Comment on this line"
      onClick={(event) => {
        event.stopPropagation();
        compose.open(at);
      }}
    >
      +
    </button>
  );
}

/** A note as a plain line, or as a comment card when it is one. */
function Note({
  note,
  actions,
  onAnswer,
  file,
}: {
  note: DiffNote;
  actions?: readonly NoteAction[];
  onAnswer?: (answer: NoteAnswer) => void;
  file?: boolean;
}) {
  if (isCardNote(note, actions)) return <NoteCard note={note} actions={actions} onAnswer={onAnswer} file={file} />;
  return (
    <div className={`line-note ${file ? "file" : ""} ${note.tone ?? ""}`} role="note">
      {note.text}
    </div>
  );
}

/** The notes under a line, found by the numbers it has on each side. */
function LineNotes({ line }: { line?: DiffLine }) {
  const { byLine: notes, actions, onAnswer, compose } = useContext(Notes);
  if (!line) return null;
  const at = spotOf(line);
  const writing = compose?.at && at && compose.at.line === at.line && compose.at.side === at.side ? compose.at : null;
  // A context line has both numbers, and a note about it may be counted in
  // either file: a review thread left on the old side names its old number.
  const old = line.kind !== "add" && line.oldNo !== undefined ? notes.get(`old:${line.oldNo}`) : undefined;
  const now =
    line.newNo === undefined ? undefined : notes.get(`new:${line.newNo}`);
  const found = [...(old ?? []), ...(now ?? [])];
  return (
    <>
      {found.map((note, i) => (
        <Note key={note.id ?? i} note={note} actions={actions} onAnswer={onAnswer} />
      ))}
      {writing && compose ? (
        <NoteComposer line={writing.line} onSubmit={(text) => compose.submit(writing, text)} onCancel={compose.cancel} />
      ) : null}
    </>
  );
}

/** What `git diff` prints: one column, a marker per line, both numbers. */
function Unified({ hunk }: { hunk: Hunk }) {
  return (
    <>
      {hunk.lines.map((line, j) => (
        <Fragment key={j}>
          <div className={`line ${line.kind}`}>
            <span className="no" data-no={line.oldNo ?? ""} />
            <span className="no" data-no={line.newNo ?? ""} />
            <span
              className="mark"
              data-mark={
                line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""
              }
            />
            <span className="text">
              <AddNote line={line} />
              <Code line={line} side={line.kind === "del" ? "old" : "new"} />
            </span>
          </div>
          <LineNotes line={line} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * A line of code, coloured the way an editor colours it, with the run that
 * differs from `other` picked out on top of that.
 */
const Code = memo(function Code({
  line,
  other,
  side,
}: {
  line: DiffLine;
  other?: DiffLine;
  side: "old" | "new";
}) {
  const coloured = useContext(Coloured);
  const change =
    other === undefined ? undefined : changedRange(line.text, other.text);
  const tokens = coloured?.[side].get(line);
  const spans = tokens ? toSpans(tokens, change) : paint(line.text, change);

  return <Spans spans={spans} />;
});

/** One half of a row. No line at all is the gap opposite an edit. */
function Side({
  line,
  other,
  which,
}: {
  line?: DiffLine;
  other?: DiffLine;
  which: "old" | "new";
}) {
  if (!line) return <span className="side gap" />;
  return (
    <span className={`side ${line.kind}`}>
      <span
        className="no"
        data-no={(which === "old" ? line.oldNo : line.newNo) ?? ""}
      />
      <span className="text">
        {/* A context line is on both sides; it takes its comment on the new one. */}
        {which === "new" || line.kind === "del" ? <AddNote line={line} /> : null}
        <Code line={line} other={other} side={which} />
      </span>
    </span>
  );
}

/** What an IDE shows: the old file on the left, the new one on the right. */
function Split({ hunk }: { hunk: Hunk }) {
  const paired = useMemo(() => pairRows(hunk), [hunk]);
  return (
    <>
      {paired.map((row, j) =>
        row.kind === "meta" ? (
          <div key={j} className="line meta">
            <span className="text">{row.left?.text}</span>
          </div>
        ) : (
          <Fragment key={j}>
            <div className="pair">
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
            {/* A context line is both sides at once; its notes go under it once. */}
            <LineNotes line={row.left} />
            {row.right !== row.left ? <LineNotes line={row.right} /> : null}
          </Fragment>
        ),
      )}
    </>
  );
}

const LAYOUT_KEY = "roer:diff-layout";

function storedLayout(): Layout | null {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    return stored === "split" || stored === "unified" ? stored : null;
  } catch {
    return null;
  }
}

const TREE_KEY = "roer:diff-tree-hidden";

function storedTreeHidden(): boolean {
  try {
    return localStorage.getItem(TREE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * A file tree on the left, the selected file's diff on the right, and the
 * arrow keys stepping through the changes themselves.
 *
 * Shared by every slot `DiffBrowserView` can show — the worktree against
 * `HEAD`, or one commit against its parent — each of which is "here is a set
 * of changed files, and here is how to diff one of them", which is
 * everything this component needs to know.
 */
export function DiffPane({
  files,
  error,
  active,
  loadDiff,
  resetKey,
  refreshToken,
  title,
  emptyMessage,
  headerExtra,
  "data-testid": testId,
  "aria-label": ariaLabel,
  defaultLayout = "unified",
  notes,
  noteActions,
  onNoteAnswer,
  reveal,
  onAddNote,
}: DiffPaneProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [composing, setComposing] = useState<(Spot & { path: string }) | null>(null);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // A layout picked by hand is kept, everywhere and across launches; until
  // then each view opens in the layout that suits it.
  const [layout, setLayoutRaw] = useState<Layout>(() => storedLayout() ?? defaultLayout);
  const setLayout = (next: Layout) => {
    setLayoutRaw(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* not kept, still shown */
    }
  };

  // Hidden by hand to give the diff the width, everywhere and across launches,
  // like the layout. The arrow keys step through the files all the same.
  const [treeHidden, setTreeHiddenRaw] = useState(storedTreeHidden);
  const setTreeHidden = (next: boolean) => {
    setTreeHiddenRaw(next);
    try {
      if (next) localStorage.setItem(TREE_KEY, "1");
      else localStorage.removeItem(TREE_KEY);
    } catch {
      /* not kept, still shown */
    }
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const order = useMemo(() => fileOrder(tree), [tree]);
  const visible = useMemo(() => rows(tree, collapsed), [tree, collapsed]);

  const selected: FileChange | undefined = useMemo(
    () => order.find((file) => file.path === selection?.path),
    [order, selection],
  );

  // A reload keeps the selection if the file is still changed — a poll
  // catching up with an edit should not knock you off what you were reading.
  // A different `resetKey` — a different commit, a different branch — means
  // even a same-named file is a different change, so that always jumps back
  // to the first one.
  const resetRef = useRef(resetKey);
  useEffect(() => {
    const hard = resetRef.current !== resetKey;
    resetRef.current = resetKey;
    setSelection((current) => {
      if (!hard && current && order.some((file) => file.path === current.path))
        return current;
      const first = order[0];
      return first ? { path: first.path, at: 0 } : null;
    });
    if (hard) setCollapsed(new Set());
    // `order` is left out: it is a fresh array every render, and it changes
    // in lockstep with `files` anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, resetKey]);

  // Declared after the reset above, so on mount a reveal wins over the
  // default of the first file.
  useEffect(() => {
    if (!reveal) return;
    select({ path: reveal.path, at: { line: reveal.line, side: reveal.side ?? "new" } });
    // Keyed on `seq` alone: pointing at the same line again is still a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  const path = selected?.path;
  const untracked = selected ? isUntracked(selected) : false;

  useEffect(() => {
    if (!path) {
      setDiff(null);
      return;
    }
    let cancelled = false;

    void loadDiff(path, untracked)
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
  }, [path, untracked, loadDiff, resetKey, refreshToken]);

  const parsed = useMemo(
    () => (diff && diff.path === path ? parseDiff(diff.text) : null),
    [diff, path],
  );

  const lang = useMemo(() => (path ? langFor(path) : undefined), [path]);

  const [grammars, setGrammars] = useState(0);
  useEffect(() => {
    if (!lang || ready(lang)) return;
    let live = true;
    void loadLang(lang).then(() => {
      if (live) setGrammars((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [lang]);

  const coloured = useMemo(
    () =>
      parsed && lang && ready(lang) ? highlight(parsed.hunks, lang) : null,
    [parsed, lang, grammars],
  );

  const [fileNotes, lineNotes] = useMemo(() => {
    // The lines this diff draws, keyed the way `LineNotes` looks them up.
    // Until it has loaded nothing is known, and every note waits for it.
    let drawn: Set<string> | null = null;
    if (parsed) {
      drawn = new Set();
      for (const hunk of parsed.hunks) {
        for (const line of hunk.lines) {
          if (line.kind !== "add" && line.oldNo !== undefined) drawn.add(`old:${line.oldNo}`);
          if (line.newNo !== undefined) drawn.add(`new:${line.newNo}`);
        }
      }
    }
    const byLine = new Map<string, DiffNote[]>();
    const heading: DiffNote[] = [];
    for (const note of notes ?? []) {
      if (note.path !== path) continue;
      if (note.line === undefined) {
        heading.push(note);
        continue;
      }
      const key = `${note.side ?? "new"}:${note.line}`;
      // A note on a line this diff does not show heads the file, naming its
      // line, rather than vanishing.
      if (drawn && !drawn.has(key)) {
        const { line, ...rest } = note;
        heading.push({ ...rest, tag: note.tag ?? (note.side === "old" ? `removed line ${line}` : `line ${line}`) });
        continue;
      }
      byLine.set(key, [...(byLine.get(key) ?? []), note]);
    }
    return [heading, byLine] as const;
  }, [notes, path, parsed]);

  // How many notes each file has, for the tree to show where they are.
  const notesPerFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notes ?? []) counts.set(note.path, (counts.get(note.path) ?? 0) + 1);
    return counts;
  }, [notes]);

  const noteContext = useMemo(
    () => ({
      byLine: lineNotes,
      actions: noteActions,
      onAnswer: onNoteAnswer,
      compose:
        onAddNote && path
          ? {
              at: composing?.path === path ? composing : null,
              open: (at: Spot) => setComposing({ ...at, path }),
              submit: (at: Spot, text: string) => {
                setComposing(null);
                onAddNote({ path, ...at, text });
              },
              cancel: () => setComposing(null),
            }
          : undefined,
    }),
    [lineNotes, noteActions, onNoteAnswer, onAddNote, path, composing],
  );

  const index = useMemo(() => {
    const count = parsed?.hunks.length ?? 0;
    if (count === 0) return 0;
    const at = selection?.at ?? 0;
    if (at === "last") return count - 1;
    if (typeof at === "object") {
      const no = (line: DiffLine) => (at.side === "old" ? line.oldNo : line.newNo);
      const found = parsed!.hunks.findIndex((hunk) => hunk.lines.some((line) => no(line) === at.line));
      return Math.max(found, 0);
    }
    return Math.min(at, count - 1);
  }, [parsed, selection]);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    setCollapsed((current) => {
      const hidden = ancestors(next.path).filter((dir) => current.has(dir));
      if (hidden.length === 0) return current;
      const open = new Set(current);
      for (const dir of hidden) open.delete(dir);
      return open;
    });
  }, []);

  const stepFile = useCallback(
    (delta: 1 | -1, at: number | "last") => {
      if (order.length === 0) return;
      const from = order.findIndex((file) => file.path === selection?.path);
      const next = order[from < 0 ? 0 : from + delta];
      if (next) select({ path: next.path, at });
    },
    [order, select, selection],
  );

  const stepHunk = useCallback(
    (delta: 1 | -1) => {
      if (!selection) {
        stepFile(1, 0);
        return;
      }
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
    event.preventDefault();
    move();
  };

  useEffect(() => {
    if (active) rootRef.current?.focus();
  }, [active]);

  useEffect(() => {
    hunkRefs.current[index]?.scrollIntoView?.({ block: "nearest" });
  }, [index, diff, reveal?.seq]);

  useEffect(() => {
    if (selection)
      rowRefs.current
        .get(selection.path)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [selection]);

  const toggle = (dir: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });

  const count = files?.length ?? 0;

  return (
    <div
      className="changes"
      data-testid={testId ?? "changes"}
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel ?? "Diff"}
    >
      <header className="changes-head">
        <button
          type="button"
          className="tree-toggle"
          aria-label={treeHidden ? "Show files" : "Hide files"}
          title={treeHidden ? "Show the changed files" : "Hide the changed files"}
          aria-pressed={!treeHidden}
          onClick={() => setTreeHidden(!treeHidden)}
        >
          {treeHidden ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        <strong>{title}</strong>
        {files ? (
          <>
            <span className="muted">
              {plural(count, "file", "files")} changed
            </span>
            <span className="muted keys">↑↓ change · ←→ file</span>
          </>
        ) : null}
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
        {headerExtra}
      </header>

      {error ? <p className="error">{error}</p> : null}

      {files && count === 0 ? (
        <p className="muted pad">{emptyMessage}</p>
      ) : null}

      {!files && !error ? <p className="muted pad">Loading changes…</p> : null}

      {count > 0 ? (
        <div className="changes-body">
          {treeHidden ? null : (
            <ul className="tree" aria-label="Changed files">
              {visible.map((row) => {
                const isSelected =
                  row.kind === "file" && row.path === selection?.path;
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
                        <span className="caret">
                          {collapsed.has(row.path) ? "▸" : "▾"}
                        </span>
                        <span className="name">{row.name}</span>
                        <span className="muted">{row.count}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        ref={(node) => {
                          rowRefs.current.set(row.path, node);
                        }}
                        className={
                          isSelected ? "tree-row file selected" : "tree-row file"
                        }
                        style={indent}
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => select({ path: row.path, at: 0 })}
                      >
                        <span
                          className={
                            isStaged(row.file) ? "letter staged" : "letter"
                          }
                        >
                          {statusLetter(row.file)}
                        </span>
                        <span className="name">{row.name}</span>
                        {row.file.binary && <span className="muted">bin</span>}
                        {notesPerFile.has(row.path) ? (
                          <span className="note-count" title="Notes on this file">
                            {notesPerFile.get(row.path)}
                          </span>
                        ) : null}
                        {row.file.counted && (
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
          )}

          <div className="diff" aria-label="Diff">
            {selected ? (
              <div className="diff-head">
                <span className="kind">{changeKind(selected)}</span>
                <strong className="path">{selected.path}</strong>
                {selected.renamedFrom ? (
                  <span className="muted">
                    renamed from {selected.renamedFrom}
                  </span>
                ) : null}
                {parsed && parsed.hunks.length > 0 ? (
                  <span className="muted at">
                    change {index + 1} of {parsed.hunks.length}
                  </span>
                ) : null}
              </div>
            ) : null}

            {diffError ? <p className="error">{diffError}</p> : null}

            {selected && !diffError && diff?.path !== selected.path ? (
              <p className="muted pad">Loading diff…</p>
            ) : null}

            {parsed?.binary ? (
              <p className="muted pad">Binary file — nothing to show.</p>
            ) : null}

            {parsed && !parsed.binary && parsed.hunks.length === 0 ? (
              <p className="muted pad">
                No textual change — a mode or an empty file.
              </p>
            ) : null}

            {fileNotes.map((note, i) => (
              <Note key={note.id ?? i} note={note} actions={noteActions} onAnswer={onNoteAnswer} file />
            ))}

            <Notes.Provider value={noteContext}>
              <Coloured.Provider value={coloured}>
                {parsed?.hunks.map((hunk, i) => (
                  <div
                    key={`${selected?.path}:${i}`}
                    ref={(node) => {
                      hunkRefs.current[i] = node;
                    }}
                    className={i === index ? "hunk current" : "hunk"}
                  >
                    <div className="hunk-head">{hunk.header}</div>
                    {layout === "split" ? (
                      <Split hunk={hunk} />
                    ) : (
                      <Unified hunk={hunk} />
                    )}
                  </div>
                ))}
              </Coloured.Provider>
            </Notes.Provider>

            {parsed?.truncated ? (
              <p className="muted pad">
                The rest of this diff is too large to show.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
