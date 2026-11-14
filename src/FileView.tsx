import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Session } from "./extensions/api";
import { ThreadCards, ThreadComposer, useClaimSessions, useThreadSender } from "./Threads";
import { useFileThreads, type LiveSession, type Thread } from "./lib/threads";
import { Spans } from "./CodeLine";
import { Markdown } from "./Markdown";
import { Picture } from "./Picture";
import { byteSize, decodeText, imageUrl, isImage, resolvePath } from "./lib/blob";
import { parseDiff, splitPatch } from "./lib/diff";
import { fileRead, type FilesChanged, type FileText } from "./lib/files";
import {
  gitBlob,
  gitBranchCommits,
  gitBranchDiff,
  gitChanges,
  gitCommitDiff,
  gitCommitFiles,
  gitCurrentBranch,
  gitDefaultBase,
  gitDiff,
  isUntracked,
  type Commit,
} from "./lib/git";
import { lineMarks, noMarks, rowsOf, type LineMarks } from "./lib/lineMarks";
import {
  highlightText,
  loadLang,
  paint,
  ready,
  toSpans,
} from "./lib/highlight";
import { useFontSize } from "./lib/fontSize";
import { langFor } from "./lib/lang";

/**
 * Above this many lines the grammar is not used, however fast the scrolling
 * is. Tokenising is not a drawing cost — windowing the DOM does not reduce it
 * — and one `codeToTokens` over a generated file blocks the main thread for
 * as long as it takes. `paint` is per line and cheap, so a huge file is
 * coloured roughly rather than slowly.
 */
const MAX_HIGHLIGHT_LINES = 5000;

/** What the backend caps a read at, for the note that says it did. */
const MAX_FILE_KB = 1024;

/** Rows drawn above and below the window, so a scroll has something to land on. */
const OVERSCAN = 20;

/** Rows to assume are visible before the viewport has been measured. */
const FIRST_SCREEN = 60;

/** Line height to assume until a real row has been measured. */
const GUESS_LINE = 22;

export interface FileViewProps {
  /** The worktree the path is relative to. */
  root: string;
  /** Repo-relative and slash-separated, as git spells it. */
  path: string;
  /** A line to scroll to, from a `path:42` query. */
  line?: number;
  /** A branch no worktree has checked out: the file is read from git as it has it, and has no local changes. */
  branch?: string;
  /** Whether the view is on top, which is when it is worth measuring. */
  active: boolean;
  /** The last thing a worktree watch reported, so an agent's edit shows
   * without the tab having to be left and come back to. */
  changed?: FilesChanged | null;
  /** The stage's session: a new thread goes to it when it works in this file's worktree, or no other session does. */
  session?: Session | null;
  /** The live sessions an agent runs in: each thread is with one of them, and everything said in it goes there. */
  sessions?: readonly LiveSession[];
}

const NO_SESSIONS: readonly LiveSession[] = [];

/** Height to assume for a thread under a line until it has been drawn and measured. */
const GUESS_NOTE = 120;

interface Line {
  no: number;
  text: string;
}

/** Which changes the gutter marks, as the Changes view slices a branch: all of it since it left its base, what
 * is not committed, or one commit, the file then shown as that commit left it. */
type Marking = { kind: "all" } | { kind: "local" } | { kind: "commit"; hash: string };

const markingKey = (marking: Marking): string => (marking.kind === "commit" ? marking.hash : marking.kind);

/** A file's text as git has it at a revision, in the shape the worktree read comes in; null when it is not there. */
async function blobText(root: string, path: string, rev: string): Promise<FileText | null> {
  const base64 = await gitBlob(root, path, rev);
  if (base64 === null) return null;
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  const whole = decodeText(base64);
  if (whole.includes("\u0000")) return { text: "", lines: 0, truncated: false, binary: true, bytes };
  const truncated = whole.length > MAX_FILE_KB * 1024;
  const text = truncated ? whole.slice(0, MAX_FILE_KB * 1024) : whole;
  return { text, lines: text.split("\n").length, truncated, binary: false, bytes };
}

/** The gutter's marks for `path` under `marking`; none when there is nothing to compare it with. */
async function marksFor(root: string, path: string, branch: string | undefined, marking: Marking): Promise<LineMarks> {
  if (marking.kind === "commit") return lineMarks(parseDiff(await gitCommitDiff(root, marking.hash, path)));
  if (marking.kind === "local") {
    const changes = await gitChanges(root);
    const file = changes.files.find((one) => one.path === path);
    if (!file) return noMarks;
    return lineMarks(parseDiff(await gitDiff(root, path, isUntracked(file))));
  }
  const whole = await gitBranchDiff(root, undefined, branch);
  const file = splitPatch(whole.diff).find((one) => one.path === path);
  return file ? lineMarks(parseDiff(file.text)) : noMarks;
}

/**
 * A file, read only, as an editor shows it: numbered lines, coloured by the
 * same grammars the diff uses, and only the visible ones in the DOM.
 *
 * Mounted for as long as its tab is open — hidden rather than unmounted when
 * another tab is on top — so the scroll position and the colouring survive a
 * trip to the terminal.
 */
export function FileView({ root, path, line, branch, active, changed, session, sessions = NO_SESSIONS }: FileViewProps) {
  const [file, setFile] = useState<FileText | null>(null);
  /** A picture's bytes, base64, read instead of its text: null when it is gone. */
  const [picture, setPicture] = useState<string | null | undefined>(undefined);
  const asPicture = isImage(path);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a grammar arrives, which is what makes the first paint —
  // drawn through `paint` — redraw itself properly.
  const [grammar, setGrammar] = useState(0);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [lineHeight, setLineHeight] = useState(GUESS_LINE);
  // Only for re-measuring: the size itself is in the CSS.
  const codeSize = useFontSize("code");

  // Bumped when the watch names this file, which is what re-runs the read.
  const [reload, setReload] = useState(0);

  const [marking, setMarking] = useState<Marking>({ kind: "all" });
  const [marks, setMarks] = useState<LineMarks>(noMarks);
  /** The branch's commits that touched this file, oldest first, for the picker; null until they are read. */
  const [commits, setCommits] = useState<Commit[] | null>(null);
  /** What "All changes" is compared with, for its tooltip. */
  const [base, setBase] = useState("");
  // A commit is shown as it left the file; otherwise the branch, or the worktree's file as it is on disk.
  const rev = marking.kind === "commit" ? marking.hash : branch;

  // Markdown only: which of the two renderings is on screen. Kept here
  // rather than on the tab, since the tab stays mounted for as long as this
  // component does.
  const [mode, setMode] = useState<"preview" | "raw">("preview");

  const boxRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  // The event this tab has already acted on, so coming back to the front
  // does not read twice for it.
  const handled = useRef<FilesChanged | null>(null);
  // Which file the scroll position belongs to, so a line number arriving for
  // the file already on screen does not fight the user's own scrolling.
  const scrolledTo = useRef<string | null>(null);

  // Cleared when the tab is pointed at another file, and only then: a re-read
  // of the same file keeps what is on screen until the new text lands, so it
  // does not blink through "Reading…" and lose its place.
  useEffect(() => {
    setFile(null);
    setPicture(undefined);
    setError(null);
    setTop(0);
    setMarking({ kind: "all" });
    setMarks(noMarks);
    setCommits(null);
    if (boxRef.current) boxRef.current.scrollTop = 0;
  }, [branch, path, root]);

  // Re-read whenever the tab comes to the front: the session behind it has
  // been editing files the whole time it was hidden. The same reason the
  // changes view reloads on arrival.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    if (asPicture) {
      void (rev ? gitBlob(root, path, rev) : gitBlob(root, path))
        .then((next) => {
          if (cancelled) return;
          setPicture(next);
          setError(next === null ? `${path} is not there any more.` : null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setPicture(null);
          setError(String(cause));
        });
      return () => {
        cancelled = true;
      };
    }

    void (rev ? blobText(root, path, rev) : fileRead(root, path))
      .then((next) => {
        if (cancelled) return;
        setFile(next ?? { text: "", lines: 0, truncated: false, binary: false, bytes: 0 });
        setError(next === null ? `${path} is not there ${rev === branch ? `on ${branch}` : "after this commit"}.` : null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFile(null);
        setError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [active, asPicture, branch, path, reload, rev, root]);

  // The branch's commits that touched this file, for the picker: read when the tab comes to the front, since the
  // session behind it may have committed while it was away. Not on every save the watch reports: that is one git
  // call per commit, and a save makes no commit.
  useEffect(() => {
    if (!active || asPicture) return;
    let cancelled = false;
    void (async () => {
      const to = await gitDefaultBase(root);
      const head = branch ?? (await gitCurrentBranch(root));
      const all = to && head && head !== to ? await gitBranchCommits(root, head, to) : [];
      const touched = await Promise.all(
        all.map(async (commit) => {
          const files = await gitCommitFiles(root, commit.hash);
          return files.some((one) => one.path === path || one.renamedFrom === path);
        }),
      );
      if (cancelled) return;
      setBase(to);
      setCommits(all.filter((_, i) => touched[i]));
    })().catch(() => {
      if (!cancelled) setCommits([]);
    });
    return () => {
      cancelled = true;
    };
  }, [active, asPicture, branch, path, root]);

  // The gutter's marks, read with the text they are about.
  useEffect(() => {
    if (!active || asPicture) return;
    let cancelled = false;
    void marksFor(root, path, branch, marking)
      .then((next) => !cancelled && setMarks(next))
      .catch(() => !cancelled && setMarks(noMarks));
    return () => {
      cancelled = true;
    };
  }, [active, asPicture, branch, marking, path, reload, root]);

  // The watch saw this file change. `broad` is a batch that gave up naming
  // paths, and then everything on screen is suspect — including this.
  useEffect(() => {
    if (!changed || changed === handled.current) return;
    handled.current = changed;
    // A hidden tab already re-reads on the way in.
    if (!active || changed.root !== root) return;
    if (!changed.broad && !changed.paths.includes(path)) return;
    setReload((one) => one + 1);
  }, [active, changed, path, root]);

  const lang = useMemo(() => langFor(path), [path]);
  const isMarkdown = lang === "markdown";

  // Split once, so the memo below and the row components hold across scrolls.
  const lines = useMemo<Line[]>(() => {
    if (!file) return [];
    const text = file.text.endsWith("\n") ? file.text.slice(0, -1) : file.text;
    if (text === "") return [];
    return text.split("\n").map((one, i) => ({ no: i + 1, text: one }));
  }, [file]);

  const grammared = lang !== undefined && lines.length <= MAX_HIGHLIGHT_LINES;

  useEffect(() => {
    if (!lang || !grammared || ready(lang)) return;
    let cancelled = false;
    void loadLang(lang).then(() => {
      if (!cancelled) setGrammar((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [grammared, lang]);

  /**
   * The whole file's tokens, or nothing when the grammar cannot answer yet.
   * One pass per file, not per window: scrolling must not re-tokenise.
   */
  const tokens = useMemo(() => {
    // `grammar` is a dependency rather than a value: it changes when a
    // grammar lands, which is when `ready` starts answering yes.
    if (!file || !lang || !grammared || !ready(lang)) return undefined;
    return highlightText(file.text, lang);
  }, [file, grammar, grammared, lang]);

  // The file with what the diff removed put back in, as the Changes view's unified diff shows a change.
  const { rows, changes } = useMemo(() => rowsOf(lines.map((one) => one.text), marks), [lines, marks]);
  /** Each line's row, by line number less one: the removed rows push the lines below them down. */
  const rowOfLine = useMemo(() => {
    const at: number[] = [];
    rows.forEach((row, i) => {
      if (row.kind === "line") at.push(i);
    });
    return at;
  }, [rows]);
  /** The change the arrow keys are on, by its place in `changes`; -1 before they have been pressed. */
  const [at, setAt] = useState(-1);
  useEffect(() => setAt(-1), [changes]);
  /** The change the keys are on: its own rows, up to the first unchanged one, not on to the next change. */
  const current = useMemo(() => {
    if (at < 0 || at >= changes.length) return null;
    const from = changes[at];
    let to = from;
    while (to < rows.length && (rows[to].kind === "removed" || (rows[to].kind === "line" && (rows[to] as { added: boolean }).added))) to += 1;
    return { from, to };
  }, [at, changes, rows]);

  // Threads on the file's lines, each drawn under its last line like a comment in the diff.
  const threads = useFileThreads(root, path, branch);
  const sender = useThreadSender({ stage: session, sessions });
  useClaimSessions(threads, sessions);
  /** The lines a new comment is being written on; null while none is. Shift-click another line's button to make it
   * a range. */
  const [composing, setComposing] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => setComposing(null), [branch, path, root]);
  const lineAnchor = (thread: Thread) =>
    thread.anchors.find((a): a is Extract<Thread["anchors"][number], { kind: "line" }> => a.kind === "line" && a.path === path);
  const rangeName = (from: number, to: number) => (to > from ? `lines ${from}–${to}` : `line ${from}`);
  const threadName = (thread: Thread) => {
    const a = lineAnchor(thread);
    return a ? rangeName(a.line, a.end ?? a.line) : path;
  };
  const pickLine = (no: number, extend: boolean) =>
    setComposing((current) =>
      extend && current ? { from: Math.min(current.from, no), to: Math.max(current.to, no, current.from) } : { from: no, to: no },
    );

  /** What sits under each row: the threads that end on its line, and the comment being written there. */
  const under = useMemo(() => {
    const at = new Map<number, { threads: Thread[]; composing: boolean }>();
    const rowFor = (no: number) => rowOfLine[Math.min(Math.max(no, 1), rowOfLine.length) - 1];
    for (const thread of threads) {
      const a = lineAnchor(thread);
      const row = a ? rowFor(a.end ?? a.line) : undefined;
      if (row === undefined) continue;
      const slot = at.get(row) ?? { threads: [], composing: false };
      slot.threads.push(thread);
      at.set(row, slot);
    }
    if (composing !== null) {
      const row = rowFor(composing.to);
      if (row !== undefined) at.set(row, { threads: at.get(row)?.threads ?? [], composing: true });
    }
    return at;
    // `lineAnchor` reads only `path`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composing, path, rowOfLine, threads]);

  /** The lines a thread (open) or the comment being written is about, marked in the gutter. */
  const marked = useMemo(() => {
    const on = new Set<number>();
    const mark = (from: number, to: number) => {
      for (let no = from; no <= to; no += 1) on.add(no);
    };
    for (const thread of threads) {
      const a = lineAnchor(thread);
      if (a && thread.state === "open") mark(a.line, a.end ?? a.line);
    }
    if (composing) mark(composing.from, composing.to);
    return on;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composing, path, threads]);

  // Rows are all one height, but what sits under them is not: each block's height, measured once it is drawn.
  const [measured, setMeasured] = useState<ReadonlyMap<number, number>>(new Map());
  const anchors = useMemo(() => [...under.keys()].sort((a, b) => a - b), [under]);
  const extra = (row: number) => measured.get(row) ?? GUESS_NOTE;
  /** Where a row starts, the blocks above it included. */
  const rowTop = (row: number) => {
    let y = row * lineHeight;
    for (const a of anchors) {
      if (a >= row) break;
      y += extra(a);
    }
    return y;
  };
  const total = rows.length * lineHeight + anchors.reduce((sum, a) => sum + extra(a), 0);
  /** The row at height `y`: a block counts as its row's. */
  const rowAt = (y: number) => {
    let shift = 0;
    for (const a of anchors) {
      if (y < (a + 1) * lineHeight + shift) break;
      shift += extra(a);
    }
    return Math.max(0, Math.min(rows.length, Math.floor((y - shift) / lineHeight)));
  };

  const linesRef = useRef<HTMLDivElement>(null);
  const measureNotes = useCallback(() => {
    const blocks = linesRef.current?.querySelectorAll<HTMLElement>(".file-notes[data-row]") ?? [];
    setMeasured((last) => {
      let next: Map<number, number> | null = null;
      for (const block of blocks) {
        const row = Number(block.dataset.row);
        const h = block.offsetHeight;
        if (h > 0 && last.get(row) !== h) (next ??= new Map(last)).set(row, h);
      }
      return next ?? last;
    });
  }, []);
  useLayoutEffect(measureNotes);
  // A card grows as a reply box opens or an answer arrives: measured again then.
  useEffect(() => {
    const lines = linesRef.current;
    if (!lines || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measureNotes);
    watch.observe(lines);
    return () => watch.disconnect();
  }, [measureNotes, file, mode, error]);

  const comment = (range: { from: number; to: number }, text: string) => {
    const code = lines.slice(range.from - 1, range.to).map((one) => one.text).join("\n");
    sender.start({
      root,
      anchors: [{ kind: "line", path, line: range.from, ...(range.to > range.from ? { end: range.to } : {}), code, ...(branch ? { branch } : {}) }],
      text,
    });
    setComposing(null);
  };

  /** The viewport, read from the box rather than watched: a hidden tab has
   * no size, so this is taken when the tab comes to the front. */
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    setHeight(box.clientHeight);
    const probe = probeRef.current?.getBoundingClientRect().height;
    if (probe) setLineHeight(probe);
  }, []);

  useEffect(() => {
    if (!active) return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active, lines, measure, codeSize]);

  // A line target only means anything against the raw, numbered view — the
  // Markdown preview has nothing for it to scroll to. Switching here (rather
  // than folding it into the scroll effect below) leaves the user free to
  // pick Preview again afterwards, since this only re-fires for a new target.
  useEffect(() => {
    if (isMarkdown && line) setMode("raw");
  }, [isMarkdown, line, path, root]);

  // The line a `path:42` query asked for, put in the middle of the view.
  useEffect(() => {
    const box = boxRef.current;
    const want = `${root}/${path}:${line ?? ""}`;
    if (
      !box ||
      !active ||
      !line ||
      lines.length === 0 ||
      scrolledTo.current === want
    )
      return;
    scrolledTo.current = want;
    // Clamped here rather than by reading `scrollTop` back: every row is the
    // same height, so the furthest the box can scroll is known, and the
    // window must be drawn for the position it really ends up at.
    const furthest = Math.max(0, total - box.clientHeight);
    const middle = rowTop(rowOfLine[line - 1] ?? line - 1) - box.clientHeight / 2;
    const target = Math.min(furthest, Math.max(0, middle));
    box.scrollTop = target;
    setTop(target);
    // `rowTop` and `total` follow `rowOfLine` and the blocks; a block measured later must not scroll again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, line, lineHeight, lines.length, path, root, rowOfLine, rows.length]);


  /** Up and Down step through the changes, as they do in the Changes view; with none, they scroll the file. */
  const onKeyDown = (event: KeyboardEvent) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const box = boxRef.current;
    if (delta === 0 || changes.length === 0 || !box || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    event.preventDefault();
    // From where the view is before the keys have been used, so the first press finds the change nearest below.
    const seen = rowAt(box.scrollTop);
    const next =
      at >= 0
        ? Math.min(changes.length - 1, Math.max(0, at + delta))
        : delta === 1
          ? Math.max(0, changes.findIndex((row) => row >= seen))
          : Math.max(0, changes.map((row) => row < rowAt(box.scrollTop + box.clientHeight)).lastIndexOf(true));
    setAt(next);
    const from = rowTop(changes[next]);
    const to = rowTop(changes[next + 1] ?? rows.length);
    // Nearest, as the diff scrolls to a change: left alone when it is already in view.
    if (from < box.scrollTop || to > box.scrollTop + box.clientHeight) {
      const target = Math.max(0, Math.min(from - box.clientHeight / 3, total - box.clientHeight));
      box.scrollTop = target;
      setTop(target);
    }
  };

  const view = height > 0 ? height : lineHeight * FIRST_SCREEN;
  const first = Math.max(0, rowAt(top) - OVERSCAN);
  const last = Math.min(rows.length, rowAt(top + view) + 1 + OVERSCAN);
  const window_ = rows.slice(first, last);

  // The pictures a Markdown file shows, from the worktree it is in.
  const markdownImage = useCallback(
    async (src: string) => {
      const at = resolvePath(path, src);
      if (!at || !isImage(at)) return null;
      const base64 = await (rev ? gitBlob(root, at, rev) : gitBlob(root, at));
      return base64 === null ? null : imageUrl(at, base64);
    },
    [path, rev, root],
  );

  const note = () => {
    if (error) return error;
    if (asPicture) return picture === undefined ? "Reading…" : null;
    if (!file) return "Reading…";
    if (file.binary) return "Binary file — nothing to show.";
    if (lines.length === 0) return "Empty file.";
    return null;
  };
  const message = note();

  // Like the Changes view's diff: the keys are on the file as soon as its tab is on top.
  useEffect(() => {
    if (active) boxRef.current?.focus({ preventScroll: true });
  }, [active, message, mode]);

  return (
    <div className="file-view" data-testid="file-view">
      <div className="file-head">
        <span className="file-path">{path}</span>
        {branch ? (
          <span className="file-branch" title={`Read from git as ${branch} has it; no worktree has it checked out`}>
            {branch} · read only
          </span>
        ) : null}
        {!asPicture ? (
          <select
            className="file-marking"
            aria-label="Changes to mark"
            value={markingKey(marking)}
            onChange={(event) => {
              const key = event.target.value;
              setMarking(key === "all" || key === "local" ? { kind: key } : { kind: "commit", hash: key });
            }}
          >
            <option value="all" title={base ? `Everything since the branch left ${base}` : undefined}>
              All changes
            </option>
            {branch ? null : <option value="local">Local changes</option>}
            {commits?.map((commit) => (
              <option key={commit.hash} value={commit.hash}>
                {commit.short} {commit.subject}
              </option>
            ))}
          </select>
        ) : null}
        {isMarkdown && !message ? (
          <div className="seg" role="group" aria-label="Markdown view">
            <button
              type="button"
              className={mode === "preview" ? "on" : undefined}
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              className={mode === "raw" ? "on" : undefined}
              aria-pressed={mode === "raw"}
              onClick={() => setMode("raw")}
            >
              Raw
            </button>
          </div>
        ) : null}
        {changes.length > 0 && !message && !(isMarkdown && mode === "preview") ? (
          <span className="muted keys">↑↓ change</span>
        ) : null}
        {asPicture && picture ? <span className="muted">{byteSize(picture)}</span> : null}
        {file && !file.binary && lines.length > 0 ? (
          <span className="muted">
            {lines.length} {lines.length === 1 ? "line" : "lines"}
            {lines.length > MAX_HIGHLIGHT_LINES
              ? " — too long to colour fully"
              : ""}
          </span>
        ) : null}
      </div>

      {message ? (
        <p className={error ? "file-note error" : "file-note"}>{message}</p>
      ) : asPicture && picture ? (
        <div className="file-picture">
          <Picture src={imageUrl(path, picture)} alt={path} />
        </div>
      ) : isMarkdown && mode === "preview" ? (
        <Markdown image={markdownImage}>{file?.text ?? ""}</Markdown>
      ) : (
        <div
          className="file-body"
          ref={boxRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={(event) => setTop(event.currentTarget.scrollTop)}
        >
          {/* One spacer above and one below, so the scrollbar measures the
              whole file while only the window is in the DOM. */}
          <div style={{ height: rowTop(first) }} />
          <div className="file-lines" ref={linesRef}>
            {window_.map((one, i) => {
              const row = first + i;
              const kind = one.kind === "removed" ? " del" : one.added ? " add" : "";
              const on = current && row >= current.from && row < current.to ? " current" : "";
              const below = under.get(row);
              const inThread = one.kind === "line" && marked.has(one.no) ? " in-thread" : "";
              return (
                <Fragment key={one.kind === "line" ? one.no : `-${row}`}>
                  {/* The first row of the window, whichever that is: a file opened at line 500 never draws line 1
                      to measure. */}
                  <div className={`file-line${kind}${on}${inThread}`} ref={i === 0 ? probeRef : undefined}>
                    {/* The number lives in an attribute and is drawn by a `::before`, so it is not in the text flow
                        at all: a selection dragged down the file cannot pick it up and a copy cannot carry it.
                        `user-select: none` alone stops the highlight but WebKit still serialises what it skipped. */}
                    <span className="file-no" data-no={one.kind === "line" ? one.no : ""}>
                      {one.kind === "line" ? (
                        <button
                          type="button"
                          className="line-add"
                          aria-label={`Comment on line ${one.no}`}
                          title="Comment on this line, for the session's agent; Shift-click another to take in the lines between"
                          onClick={(event) => pickLine(one.no, event.shiftKey)}
                        >
                          +
                        </button>
                      ) : null}
                    </span>
                    {one.kind === "removed" ? (
                      // A removed line is not in the file, so it is not in a copy of it either: drawn, not written.
                      <code className="file-code" data-text={one.text} />
                    ) : (
                      <code className="file-code">
                        <Spans spans={tokens ? toSpans(tokens[one.no - 1] ?? []) : paint(one.text)} />
                      </code>
                    )}
                  </div>
                  {below ? (
                    <div className="file-notes" data-row={row}>
                      <ThreadCards threads={below.threads} sender={sender} name={threadName} />
                      {below.composing && composing !== null ? (
                        <ThreadComposer
                          root={root}
                          sender={sender}
                          name={rangeName(composing.from, composing.to)}
                          onSubmit={(text) => comment(composing, text)}
                          onCancel={() => setComposing(null)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
          <div
            style={{ height: Math.max(0, total - rowTop(last)) }}
          />
        </div>
      )}

      {file?.truncated ? (
        <p className="file-note muted">
          Showing the first {MAX_FILE_KB} KB of a{" "}
          {Math.round(file.bytes / 1024)} KB file.
        </p>
      ) : null}
    </div>
  );
}
