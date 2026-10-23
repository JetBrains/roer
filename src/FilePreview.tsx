import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Spans } from "./CodeLine";
import { baseName, fileRead, type FileText } from "./lib/files";
import { highlightText, loadLang, paint, ready, toSpans } from "./lib/highlight";
import { langFor } from "./lib/lang";

/** How long the selection rests on a row before the file is read, so the
 * arrows can run down the list without reading each one on the way. */
const READ_DEBOUNCE_MS = 100;
/** How much of a file the preview draws: it is for telling files apart, and
 * the file's own tab is a key away. */
const SHOWN_LINES = 400;
/** Lines kept above the one asked for, so it is read in its context. */
const ABOVE = 40;
/** Past this the file is shown plain, as its tab shows it. */
const MAX_HIGHLIGHT_LINES = 5000;

export interface FilePreviewProps {
  root: string;
  path: string;
  /** The line asked for with `name:line`, to start at and mark. */
  line?: number;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * The highlighted file of the search popup, read-only, beside the list: what
 * is in it, before it is opened in a tab of its own. Starts a little above
 * the line asked for, when one was.
 */
export function FilePreview({ root, path, line, onOpen, onClose }: FilePreviewProps) {
  const [read, setRead] = useState<{ key: string; file: FileText | null; error: string | null } | null>(null);
  const [grammar, setGrammar] = useState(0);
  const target = useRef<HTMLDivElement>(null);
  const key = `${root}\0${path}`;

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      fileRead(root, path)
        .then((file) => current && setRead({ key, file, error: null }))
        .catch((cause: unknown) => current && setRead({ key, file: null, error: String(cause) }));
    }, READ_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [key, path, root]);

  const shown = read?.key === key ? read : null;
  const file = shown?.file ?? null;
  const lang = useMemo(() => langFor(path), [path]);
  const lines = useMemo(() => {
    if (!file || file.binary) return [];
    const text = file.text.endsWith("\n") ? file.text.slice(0, -1) : file.text;
    return text === "" ? [] : text.split("\n");
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

  const tokens = useMemo(() => {
    if (!file || !lang || !grammared || !ready(lang)) return undefined;
    return highlightText(file.text, lang);
    // `grammar` changes when a grammar lands, which is when `ready` says yes.
  }, [file, grammar, grammared, lang]);

  const first = line && line > ABOVE ? line - ABOVE : 1;
  const window_ = lines.slice(first - 1, first - 1 + SHOWN_LINES);

  // The line asked for, in the middle of the pane.
  useEffect(() => {
    const at = target.current;
    const box = at?.parentElement?.parentElement;
    if (!at || !box) return;
    box.scrollTop = at.offsetTop - (box.clientHeight - at.offsetHeight) / 2;
  }, [file, line]);

  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const message = !shown
    ? "Reading…"
    : shown.error
      ? `Could not read it: ${shown.error}`
      : !file
        ? "Could not read it."
        : file.binary
          ? "A binary file: nothing to show here."
          : lines.length === 0
            ? "An empty file."
            : null;

  return (
    <aside className="conversation-preview file-preview" aria-label="Preview">
      <header>
        <div className="conversation-preview-title">
          <h3>{baseName(path)}</h3>
          <span className="muted">
            {[dir, lines.length ? `${lines.length} ${lines.length === 1 ? "line" : "lines"}` : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        <button type="button" className="primary" onClick={onOpen}>
          Open
        </button>
        <button type="button" className="tree-action" aria-label="Close the preview" title="Close the preview" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </header>
      {message ? (
        <p className="muted">{message}</p>
      ) : (
        <div className="file-body">
          <div className="file-lines">
            {window_.map((text, i) => {
              const no = first + i;
              return (
                <div key={no} ref={no === line ? target : undefined} className={no === line ? "file-line asked" : "file-line"}>
                  <span className="file-no" data-no={no} />
                  <code className="file-code">
                    <Spans spans={tokens ? toSpans(tokens[no - 1] ?? []) : paint(text)} />
                  </code>
                </div>
              );
            })}
          </div>
          {lines.length > first - 1 + SHOWN_LINES || file?.truncated ? (
            <p className="muted file-preview-more">The rest is in its tab: Open.</p>
          ) : null}
        </div>
      )}
    </aside>
  );
}
