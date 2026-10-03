/**
 * Unified diff → hunks, for rendering and for stepping through changes.
 *
 * A hunk is the unit of navigation: pressing down should land on the next
 * thing that actually changed, not the next line of a diff.
 */

export type LineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  /** Content without the leading marker, so the renderer owns the gutter. */
  text: string;
  /** Line number on the left, present for context and removed lines. */
  oldNo?: number;
  /** Line number on the right, present for context and added lines. */
  newNo?: number;
}

export interface Hunk {
  /** The `@@ … @@` line, section heading included when git supplies one. */
  header: string;
  lines: DiffLine[];
  added: number;
  deleted: number;
}

export interface Diff {
  hunks: Hunk[];
  /** Git refuses to diff binary content; there is nothing to show. */
  binary: boolean;
  /** The backend cut an enormous diff short. */
  truncated: boolean;
}

/** A remark about one line of a file's diff, or about the file as a whole. */
export interface DiffNote {
  path: string;
  /** The line's number on `side`; without one the note heads the file. */
  line?: number;
  /** Which file `line` counts in: the new one unless it is a removed line.
   * @default "new" */
  side?: "old" | "new";
  text: string;
  /** How much it matters, for a note that is a finding. Plain when unset. */
  tone?: "info" | "warn" | "error";
  /** Names the note to whoever answers it; a note can only be answered with one. */
  id?: string;
  /** Who wrote it. A note with an author is a comment, and its text is markdown. */
  author?: string;
  /** The rest of the conversation under it, oldest first. */
  replies?: { author: string; text: string }[];
  /** A word on its corner, such as "outdated". */
  tag?: string;
  /** An https link to where the note lives, such as the thread on GitHub. */
  url?: string;
  /** What was decided about it, as one of the offered answers' `value`;
   * drawn in place of the answers. */
  state?: string;
  /** The words that came with the decision, for an answer that takes some. */
  answer?: string;
  /** This note's own answers, in place of the ones the diff offers every note. */
  actions?: NoteAction[];
}

/** One way a note can be answered. */
export interface NoteAction {
  /** What the button says. */
  label: string;
  /** What is reported, and the note's `state` once the owner takes it. */
  value: string;
  /** Asks for words before it is reported; the field's placeholder. */
  input?: string;
  primary?: boolean;
  /** What a note answered this way says in place of the buttons. @default label */
  done?: string;
}


/** One file of a multi-file patch, and the part of the patch that is its. */
export interface PatchFile {
  path: string;
  /** Git's letter for what happened to it: `A`, `D`, `R`, `C` or `M`. */
  status: string;
  renamedFrom?: string;
  added: number;
  deleted: number;
  binary: boolean;
  /** This file's own `diff --git` section, ready for `parseDiff`. */
  text: string;
}

/**
 * A whole `git diff` — any range, any number of files — cut at each
 * `diff --git` header, for a viewer that shows one file at a time.
 */
export function splitPatch(patch: string): PatchFile[] {
  const sections = patch.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));
  return sections.map((text) => {
    const firstHunk = text.search(/^@@/m);
    const header = firstHunk < 0 ? text : text.slice(0, firstHunk);
    const field = (name: string) => new RegExp(`^${name} (.*)$`, "m").exec(header)?.[1];
    // `+++ b/path` names the file even when its path has spaces; a deleted
    // file only has `--- a/path`, and a binary or mode-only change neither.
    const plus = field("\\+\\+\\+");
    const minus = field("---");
    const path =
      field("rename to") ??
      (plus && plus !== "/dev/null" ? plus.replace(/^b\//, "") : undefined) ??
      (minus && minus !== "/dev/null" ? minus.replace(/^a\//, "") : undefined) ??
      / b\/(.*)$/m.exec(header.split("\n")[0])?.[1] ??
      "";
    const renamedFrom = field("rename from") ?? field("copy from");
    const status = /^new file mode/m.test(header)
      ? "A"
      : /^deleted file mode/m.test(header)
        ? "D"
        : field("rename from")
          ? "R"
          : field("copy from")
            ? "C"
            : "M";
    const parsed = parseDiff(text);
    return {
      path,
      status,
      ...(renamedFrom ? { renamedFrom } : {}),
      added: parsed.hunks.reduce((sum, hunk) => sum + hunk.added, 0),
      deleted: parsed.hunks.reduce((sum, hunk) => sum + hunk.deleted, 0),
      binary: parsed.binary,
      text,
    };
  });
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseDiff(text: string): Diff {
  const hunks: Hunk[] = [];
  let binary = false;
  let truncated = false;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split("\n")) {
    const start = HUNK.exec(line);
    if (start) {
      oldNo = Number(start[1]);
      newNo = Number(start[2]);
      hunk = { header: line, lines: [], added: 0, deleted: 0 };
      hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      // File headers, and the two things git says instead of a diff.
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      if (line.startsWith("roer: diff truncated")) truncated = true;
      continue;
    }

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      hunk.added += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      hunk.deleted += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to neither side.
      hunk.lines.push({ kind: "meta", text: line.slice(2) });
    } else if (line.startsWith("roer: ")) {
      truncated = true;
    } else if (line.startsWith(" ") || line === "") {
      // A truncated diff can end mid-hunk, and the split leaves one empty
      // string at the end of any text; neither is a line of the file.
      hunk.lines.push({
        kind: "context",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }

  // The trailing empty string every `split` produces became a context line.
  const last = hunks.at(-1);
  if (last && text.endsWith("\n")) last.lines.pop();

  return { hunks, binary, truncated };
}

/** One line of a side-by-side view; a missing side is a gap, not a blank. */
export interface SideRow {
  /** `change` is a removal paired with the addition that replaced it. */
  kind: "context" | "change" | "add" | "del" | "meta";
  left?: DiffLine;
  right?: DiffLine;
}

/**
 * A hunk laid out in two columns.
 *
 * Removals and additions arrive as two runs, one after the other; an IDE shows
 * them beside each other. Pairing them up in order is what a real diff
 * algorithm would do anyway once it had matched the lines, and for the runs a
 * unified diff produces it is nearly always the right pairing.
 */
export function pairRows(hunk: Hunk): SideRow[] {
  const rows: SideRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  let metas: DiffLine[] = [];

  const flush = () => {
    const paired = Math.min(dels.length, adds.length);
    for (let i = 0; i < paired; i += 1)
      rows.push({ kind: "change", left: dels[i], right: adds[i] });
    for (const line of dels.slice(paired)) rows.push({ kind: "del", left: line });
    for (const line of adds.slice(paired)) rows.push({ kind: "add", right: line });
    for (const line of metas) rows.push({ kind: "meta", left: line });
    dels = [];
    adds = [];
    metas = [];
  };

  for (const line of hunk.lines) {
    if (line.kind === "del") {
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else if (line.kind === "meta") {
      // "\ No newline at end of file" sits between a removal and the
      // addition that replaced it, and is held back so the two still pair.
      metas.push(line);
    } else {
      flush();
      rows.push({ kind: "context", left: line, right: line });
    }
  }
  flush();
  return rows;
}

/**
 * The half-open range of `text` that differs from `other`, found by trimming
 * what the two share at each end. Not a word diff — an edit inside a line is
 * usually one run, and this is what makes it findable without reading the
 * whole line.
 *
 * Nothing shared at either end answers `undefined`: the whole line is the
 * change, which its own colour already says, and emphasising every character
 * of it says less than emphasising none.
 */
export function changedRange(
  text: string,
  other: string,
): { from: number; to: number } | undefined {
  const limit = Math.min(text.length, other.length);
  let prefix = 0;
  while (prefix < limit && text[prefix] === other[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < limit - prefix &&
    text[text.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === 0 && suffix === 0) return undefined;
  return { from: prefix, to: text.length - suffix };
}
