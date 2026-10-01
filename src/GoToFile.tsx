import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { filesSearch, parts, type Hit, type Hits } from "./lib/files";
import { resolveDir } from "./lib/session";

/** How long after a keystroke the query is sent, so a burst is one search. */
const SETTLE_MS = 30;

/** How long after an answer that a build is running before asking again. */
const POLL_MS = 150;

/** The longest that wait grows to, and how fast it gets there. */
const POLL_MAX_MS = 2000;
const POLL_GROWTH = 1.6;

/** Rows shown at most; the backend caps what it returns as well. */
const LIMIT = 50;

/** Sessions shown before anything is typed, and at most once something is. */
const SESSIONS_IDLE = 6;
const SESSIONS_MAX = 20;

/**
 * A session the popup can offer: how it reads, what it is found by, and how
 * to open it. Built by the caller, which knows what opening one means.
 */
export interface SessionHit {
  key: string;
  name: string;
  /** Who runs it and where, dimmed after the name. */
  detail: string;
  /** "working", "waiting", "open here", or how old a past conversation is. */
  badge?: string;
  /** Everything a query is matched against. */
  fields: Array<string | null | undefined>;
  open: () => void;
}

/**
 * Whether a session is one the query asks for: every word typed appears
 * somewhere in its fields, in any case and any order — "roer fix" finds the
 * fixing task in the roer checkout.
 */
export function matchesQuery(fields: Array<string | null | undefined>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** One row of the list: a session or a file, keyed so the two never clash. */
type Row = { kind: "session"; key: string; session: SessionHit } | { kind: "file"; key: string; hit: Hit };

export interface GoToFileProps {
  /** Directory the session was opened in; the repository is whatever holds it. */
  cwd?: string;
  /** The session's pane, so a `cd` inside it moves the search with it. */
  pane?: string;
  /** Recently opened paths, which is what an empty query shows. */
  recent?: readonly string[];
  /** Sessions to offer above the files, matched here as the query changes. */
  sessions?: readonly SessionHit[];
  /** No session on the stage, so no repository: sessions only. */
  noFiles?: boolean;
  onOpen: (root: string, path: string, line?: number) => void;
  onClose: () => void;
}

/** A row for a recent path: no match to emphasise, just the path. */
const asHit = (path: string): Hit => ({ path, nameAt: 0, score: 0, at: [] });

function FileRow({ hit }: { hit: Hit }) {
  const { dir, name } = useMemo(() => parts(hit), [hit]);
  const runs = (list: typeof dir) =>
    list.map((run, i) => (run.hit ? <b key={i}>{run.text}</b> : <span key={i}>{run.text}</span>));

  return (
    <>
      <span className="hit-name">{runs(name)}</span>
      {dir.length > 0 ? <span className="hit-dir">{runs(dir)}</span> : null}
    </>
  );
}

/**
 * IntelliJ's Go to File, over the flat list of everything in the session's
 * repository, with the sessions that match listed first: one place to look
 * for anything.
 *
 * Mounted only while it is open, so closing it drops the query and the
 * selection, and the element that had the keyboard gets it back.
 */
export function GoToFile({
  cwd,
  pane,
  recent = [],
  sessions = [],
  noFiles = false,
  onOpen,
  onClose,
}: GoToFileProps) {
  const [query, setQuery] = useState("");
  const [dir, setDir] = useState<string | null>(null);
  const [hits, setHits] = useState<Hits | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The selection is a path rather than a row number. The same query is asked
  // again every POLL_MS while a build runs, and the answer can come back
  // longer, shorter or in a different order; a row number would then point at
  // a different file, which reads as the list jumping under the keyboard.
  const [chosen, setChosen] = useState<string | null>(null);
  // Bumped to ask the same query again, which is how a running build is
  // waited for without blocking anything.
  const [token, setToken] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Answers can land out of order, and an older one must not overwrite a
  // newer; the same guard the changes view makes with its `cancelled` flag.
  const askRef = useRef(0);

  // Where the keyboard was, so Escape can hand it back. Read once, on the
  // way in, before the input takes the focus.
  const cameFromRef = useRef<Element | null>(null);
  useEffect(() => {
    cameFromRef.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const back = cameFromRef.current;
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  // Which repository, asked on the way in rather than held: a `cd` in the
  // terminal since the last time this was open has moved it.
  useEffect(() => {
    if (noFiles) return;
    let cancelled = false;
    void resolveDir(cwd, pane).then((next) => {
      if (!cancelled) setDir(next);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, pane, noFiles]);

  useEffect(() => {
    if (dir === null) return;
    const ask = askRef.current + 1;
    askRef.current = ask;

    const timer = setTimeout(() => {
      void filesSearch(dir, query, LIMIT)
        .then((next) => {
          if (askRef.current !== ask) return;
          setHits(next);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (askRef.current !== ask) return;
          setHits(null);
          setError(String(cause));
        });
    }, SETTLE_MS);

    return () => clearTimeout(timer);
  }, [dir, query, token]);

  // A build was running when that answer was made, so there is a better one
  // coming. Asking again keeps the list filling in as it lands.
  //
  // The wait grows, because how long there is to wait is not knowable from
  // here: a small repository is listed in twenty milliseconds and a big repo
  // takes twenty seconds, and asking every 150 ms through the second is a
  // hundred and thirty pointless round trips. Backing off covers both — the
  // quick build is still caught almost at once, and the slow one costs a
  // dozen asks instead.
  const waitRef = useRef(POLL_MS);
  useEffect(() => {
    if (!hits?.indexing) {
      waitRef.current = POLL_MS;
      return;
    }
    const wait = waitRef.current;
    waitRef.current = Math.min(POLL_MAX_MS, Math.round(wait * POLL_GROWTH));
    const timer = setTimeout(() => setToken((n) => n + 1), wait);
    return () => clearTimeout(timer);
    // On `token` and not on `hits`: what re-arms the next ask is having made
    // one, and an answer identical to the one before it would not re-run an
    // effect watching the object. Over IPC that never happens, which is
    // exactly why it would be a poor thing to depend on.
  }, [hits?.indexing, token]);

  // A new query is a new question, and deserves a prompt answer again.
  useEffect(() => {
    waitRef.current = POLL_MS;
  }, [query]);

  // Typing starts again from the best hit, as IntelliJ does. Nothing else
  // moves the selection on its own.
  useEffect(() => setChosen(null), [query]);

  const sessionRows: Row[] = useMemo(
    () =>
      (query.trim()
        ? sessions.filter((session) => matchesQuery(session.fields, query)).slice(0, SESSIONS_MAX)
        : sessions.slice(0, SESSIONS_IDLE)
      ).map((session) => ({ kind: "session", key: `session:${session.key}`, session })),
    [query, sessions],
  );
  const fileRows: Row[] = useMemo(
    () =>
      noFiles
        ? []
        : (query.trim() ? (hits?.hits ?? []) : recent.slice(0, LIMIT).map(asHit)).map((hit) => ({
            kind: "file",
            key: `file:${hit.path}`,
            hit,
          })),
    [hits, noFiles, query, recent],
  );
  const rows = useMemo(() => [...sessionRows, ...fileRows], [sessionRows, fileRows]);

  const at = useMemo(() => {
    const found = rows.findIndex((row) => row.key === chosen);
    return found === -1 ? 0 : found;
  }, [chosen, rows]);

  const root = hits?.root;
  const open = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "session") {
        onClose();
        row.session.open();
        return;
      }
      if (!root) return;
      onOpen(root, row.hit.path, hits?.line ?? undefined);
      onClose();
    },
    [hits, onClose, onOpen, root],
  );

  const step = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      setChosen(rows[(at + delta + rows.length) % rows.length].key);
    },
    [at, rows],
  );

  // Where the pointer last was. Scrolling the list with the arrow keys moves
  // rows under a resting mouse, and the browser then reports a move it never
  // made — which would hand the selection straight back to whatever sits
  // under the cursor, on every press.
  const wasAtRef = useRef<{ x: number; y: number } | null>(null);
  const hover = useCallback((event: MouseEvent, key: string) => {
    const last = wasAtRef.current;
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    wasAtRef.current = { x: event.clientX, y: event.clientY };
    setChosen(key);
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => step(1),
      ArrowUp: () => step(-1),
      Enter: () => open(rows[at]),
      Escape: onClose,
    };
    const act = keys[event.key];
    if (!act) return;
    // Otherwise Escape reaches the terminal, and the arrows move the caret.
    event.preventDefault();
    act();
  };

  // Follow the selection with the scroll. `nearest` leaves a row that is
  // already visible exactly where it is.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({
      block: "nearest",
    });
  }, [at, rows]);

  /** The line above the list: what was searched, and how it went. */
  const status = () => {
    if (noFiles) {
      const count = sessionRows.length;
      if (!query.trim()) return count ? "Sessions" : "No sessions yet";
      return count === 0 ? "No matches" : `${count} ${count === 1 ? "session" : "sessions"}`;
    }
    if (error) return error;
    if (!query.trim()) {
      const known = hits?.total ?? 0;
      if (hits?.indexing) return known ? `Indexing… ${known} files so far` : "Indexing…";
      return rows.length ? "Recent files" : `${known} files`;
    }
    if (!hits) return "Searching…";
    const { matched, hits: shown, indexing } = hits;
    const counted =
      matched === 0
        ? "No matches"
        : matched > shown.length
          ? `${shown.length} of ${matched} matches`
          : `${matched} ${matched === 1 ? "match" : "matches"}`;
    const files = indexing ? `${counted} — indexing…` : counted;
    const found = sessionRows.length;
    if (found === 0) return files;
    const named = `${found} ${found === 1 ? "session" : "sessions"}`;
    return matched === 0 && !indexing ? named : `${named} · ${files}`;
  };

  return (
    <div className="popup-scrim" onMouseDown={onClose}>
      <div
        className="popup"
        role="dialog"
        aria-modal="true"
        aria-label={noFiles ? "Search sessions" : "Search sessions and files"}
        data-testid="go-to-file"
        // The scrim closes on a click through it; a click on the popup is not
        // a click through it.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="popup-input"
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="go-to-file-list"
          aria-activedescendant={rows[at] ? `go-to-file-${at}` : undefined}
          aria-label="Search"
          placeholder={noFiles ? "Search sessions" : "Search sessions and files"}
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />

        <p className={error ? "popup-status error" : "popup-status"}>{status()}</p>

        <div
          id="go-to-file-list"
          className="popup-list"
          role="listbox"
          aria-label="Sessions and files"
          ref={listRef}
        >
          {rows.map((row, i) => (
            <Fragment key={row.key}>
              {/* A heading only where the two kinds meet, so a list of one
                  kind reads exactly as it did before. */}
              {sessionRows.length > 0 && fileRows.length > 0 && (i === 0 || i === sessionRows.length) ? (
                <div className="hit-group" role="presentation">
                  {row.kind === "session" ? "Sessions" : "Files"}
                </div>
              ) : null}
              <div
                id={`go-to-file-${i}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? "hit on" : "hit"}
                title={row.kind === "file" ? row.hit.path : row.session.detail}
                // Not onClick: the input keeps the keyboard, and mousedown on a
                // row must not take it away before the open lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  open(row);
                }}
                onMouseMove={(event) => hover(event, row.key)}
              >
                {row.kind === "file" ? (
                  <FileRow hit={row.hit} />
                ) : (
                  <>
                    <span className="hit-name">{row.session.name}</span>
                    <span className="hit-dir">{row.session.detail}</span>
                    {row.session.badge ? <span className="hit-badge">{row.session.badge}</span> : null}
                  </>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
