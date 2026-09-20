import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Spans } from "./CodeLine";
import { fileRead, type FilesChanged, type FileText } from "./lib/files";
import {
  highlightText,
  loadLang,
  paint,
  ready,
  toSpans,
} from "./lib/highlight";
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
const GUESS_LINE = 18;

export interface FileViewProps {
  /** The worktree the path is relative to. */
  root: string;
  /** Repo-relative and slash-separated, as git spells it. */
  path: string;
  /** A line to scroll to, from a `path:42` query. */
  line?: number;
  /** Whether the view is on top, which is when it is worth measuring. */
  active: boolean;
  /** The last thing a worktree watch reported, so an agent's edit shows
   * without the tab having to be left and come back to. */
  changed?: FilesChanged | null;
}

interface Line {
  no: number;
  text: string;
}

/**
 * A file, read only, as an editor shows it: numbered lines, coloured by the
 * same grammars the diff uses, and only the visible ones in the DOM.
 *
 * Mounted for as long as its tab is open — hidden rather than unmounted when
 * another tab is on top — so the scroll position and the colouring survive a
 * trip to the terminal.
 */
export function FileView({ root, path, line, active, changed }: FileViewProps) {
  const [file, setFile] = useState<FileText | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a grammar arrives, which is what makes the first paint —
  // drawn through `paint` — redraw itself properly.
  const [grammar, setGrammar] = useState(0);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [lineHeight, setLineHeight] = useState(GUESS_LINE);

  // Bumped when the watch names this file, which is what re-runs the read.
  const [reload, setReload] = useState(0);

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
    setError(null);
    setTop(0);
    if (boxRef.current) boxRef.current.scrollTop = 0;
  }, [path, root]);

  // Re-read whenever the tab comes to the front: the session behind it has
  // been editing files the whole time it was hidden. The same reason the
  // changes view reloads on arrival.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    void fileRead(root, path)
      .then((next) => {
        if (cancelled) return;
        setFile(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setFile(null);
        setError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [active, path, reload, root]);

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
  }, [active, lines, measure]);

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
    const furthest = Math.max(0, lines.length * lineHeight - box.clientHeight);
    const middle = (line - 1) * lineHeight - box.clientHeight / 2;
    const target = Math.min(furthest, Math.max(0, middle));
    box.scrollTop = target;
    setTop(target);
  }, [active, line, lineHeight, lines.length, path, root]);

  const view = height > 0 ? height : lineHeight * FIRST_SCREEN;
  const first = Math.max(0, Math.floor(top / lineHeight) - OVERSCAN);
  const last = Math.min(
    lines.length,
    Math.ceil((top + view) / lineHeight) + OVERSCAN,
  );
  const window_ = lines.slice(first, last);

  const note = () => {
    if (error) return error;
    if (!file) return "Reading…";
    if (file.binary) return "Binary file — nothing to show.";
    if (lines.length === 0) return "Empty file.";
    return null;
  };
  const message = note();

  return (
    <div className="file-view" data-testid="file-view">
      <div className="file-head">
        <span className="file-path">{path}</span>
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
      ) : isMarkdown && mode === "preview" ? (
        <div className="file-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {file?.text ?? ""}
          </ReactMarkdown>
        </div>
      ) : (
        <div
          className="file-body"
          ref={boxRef}
          tabIndex={0}
          onScroll={(event) => setTop(event.currentTarget.scrollTop)}
        >
          {/* One spacer above and one below, so the scrollbar measures the
              whole file while only the window is in the DOM. */}
          <div style={{ height: first * lineHeight }} />
          <div className="file-lines">
            {window_.map((one) => (
              // The first row of the window, whichever line that is: a file
              // opened at line 500 never draws line 1 to measure.
              <div
                className="file-line"
                key={one.no}
                ref={one.no === window_[0].no ? probeRef : undefined}
              >
                {/* The number lives in an attribute and is drawn by a
                    `::before`, so it is not in the text flow at all: a
                    selection dragged down the file cannot pick it up and a
                    copy cannot carry it. `user-select: none` alone stops the
                    highlight but WebKit still serialises what it skipped. */}
                <span className="file-no" data-no={one.no} />
                <code className="file-code">
                  <Spans
                    spans={
                      tokens
                        ? toSpans(tokens[one.no - 1] ?? [])
                        : paint(one.text)
                    }
                  />
                </code>
              </div>
            ))}
          </div>
          <div
            style={{ height: Math.max(0, (lines.length - last) * lineHeight) }}
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
