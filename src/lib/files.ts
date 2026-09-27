/**
 * Typed bridge to the Rust file index behind Go to File.
 *
 * The paths and the matching both live in Rust — a big repo is half a million
 * of them, and a query returns fifty — so this module carries a query across
 * and nothing else.
 */
import { invoke, listen, type UnlistenFn } from "./backend";

export interface Hit {
  /** Repo-relative and slash-separated, as git spells it. */
  path: string;
  /** Byte offset where the file name starts, so a row can dim the directory. */
  nameAt: number;
  score: number;
  /** Byte offsets of the matched characters, for emphasis in the row. */
  at: number[];
}

export interface Hits {
  /** The worktree these paths are relative to. */
  root: string;
  /** Bumped when a rebuild replaces the snapshot, so a stale answer shows. */
  generation: number;
  /** A build is running: these hits come from an older list, or from none. */
  indexing: boolean;
  /** Files in the snapshot that was searched. */
  total: number;
  /** How many matched in all, before the limit. */
  matched: number;
  /** The line from a `path:42` query, for the viewer to scroll to. */
  line: number | null;
  hits: Hit[];
}

/**
 * What a worktree watch saw change. One of these arrives per batch, at most
 * every few hundred milliseconds, and only for repositories the app has
 * actually been asked about.
 */
export interface FilesChanged {
  /** The worktree root, as the views were given it. */
  root: string;
  /** Repo-relative paths, sorted. Empty when `broad` says it gave up naming. */
  paths: string[];
  /** More changed than `paths` names: treat everything on screen as suspect. */
  broad: boolean;
}

export interface FileText {
  text: string;
  lines: number;
  /** The file was longer than the reader's cap; `text` is the start of it. */
  truncated: boolean;
  binary: boolean;
  bytes: number;
}

/** The best `limit` paths for `query`, in the repository holding `cwd`. */
export const filesSearch = (cwd: string, query: string, limit = 50): Promise<Hits> =>
  invoke("files_search", { cwd, query, limit });

export const fileRead = (root: string, path: string): Promise<FileText> =>
  invoke("file_read", { root, path });

/**
 * Called whenever something changes under a watched worktree, so the views
 * do not have to be looked at to find out. The same shape as `onHandoff`.
 */
export const onFilesChanged = (
  handler: (changed: FilesChanged) => void,
): Promise<UnlistenFn> =>
  listen<FilesChanged>("roer://files-changed", (event) => handler(event.payload));

/** The file name, which is what a row and a tab are labelled with. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * A path split into the runs the matcher hit and the runs it did not, so a row
 * can emphasise the former without slicing the string itself.
 *
 * The offsets are bytes, and a path may hold anything, so the split happens on
 * the encoded bytes and each run is decoded back. For a wholly ASCII path —
 * very nearly all of them — the byte offsets are the character offsets, and
 * this costs one encode.
 */
export function runs(path: string, at: readonly number[]): { text: string; hit: boolean }[] {
  if (at.length === 0) return path ? [{ text: path, hit: false }] : [];

  const bytes = new TextEncoder().encode(path);
  const decoder = new TextDecoder();
  const marked = new Set(at);
  const out: { text: string; hit: boolean }[] = [];

  let start = 0;
  let hit = marked.has(0);
  for (let i = 1; i <= bytes.length; i += 1) {
    // A continuation byte belongs to the character that started the run, so it
    // cannot open a new one; only a lead byte can change the state.
    const lead = i === bytes.length || (bytes[i] & 0xc0) !== 0x80;
    const next = i < bytes.length && marked.has(i);
    if (!lead || (next === hit && i < bytes.length)) continue;
    out.push({ text: decoder.decode(bytes.subarray(start, i)), hit });
    start = i;
    hit = next;
  }
  return out;
}

export interface Run {
  text: string;
  hit: boolean;
}

/**
 * A hit split the way a row shows it: the file name, and the directory that
 * holds it, each already broken into matched and unmatched runs.
 *
 * `nameAt` is where the name starts in bytes, which is exactly the encoded
 * length of the directory part — git spells a separator as `/` and nothing
 * else — so the two offset sets partition on it without re-encoding.
 */
export function parts(hit: Hit): { dir: Run[]; name: Run[] } {
  const cut = hit.path.lastIndexOf("/") + 1;
  return {
    dir: runs(hit.path.slice(0, cut), hit.at.filter((o) => o < hit.nameAt)),
    name: runs(
      hit.path.slice(cut),
      hit.at.filter((o) => o >= hit.nameAt).map((o) => o - hit.nameAt),
    ),
  };
}
