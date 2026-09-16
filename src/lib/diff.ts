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
