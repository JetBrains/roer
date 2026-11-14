/**
 * A file's diff laid over the file itself, the way the Changes view's unified diff shows it: the lines it added
 * marked in place, and the lines it removed put back in, between the lines they were taken from.
 */
import type { Diff } from "./diff";

export interface LineMarks {
  /** Added lines, by their number in the file as it is now (the diff's new side); a changed line is one of them. */
  added: ReadonlySet<number>;
  /** What was removed, by the line it sat above: `count + 1` for lines taken off the end. */
  removed: ReadonlyMap<number, readonly string[]>;
}

export const noMarks: LineMarks = { added: new Set(), removed: new Map() };

export function lineMarks(diff: Diff): LineMarks {
  const added = new Set<number>();
  const removed = new Map<number, string[]>();
  for (const hunk of diff.hunks) {
    // The new side's next line number. `+5,0` is a hunk that only removes, after line 5; `+5,3` starts at line 5.
    const side = /\+(\d+)(?:,(\d+))?/.exec(hunk.header);
    let next = side ? Number(side[1]) + (side[2] === "0" ? 1 : 0) : 1;
    for (const line of hunk.lines) {
      if (line.kind === "del") {
        const there = removed.get(next) ?? [];
        there.push(line.text);
        removed.set(next, there);
      } else if (line.newNo !== undefined) {
        if (line.kind === "add") added.add(line.newNo);
        next = line.newNo + 1;
      }
    }
  }
  return { added, removed };
}

/** One row of the file view: a line of the file, or one the diff removed, drawn where it was. */
export type Row = { kind: "line"; no: number; text: string; added: boolean } | { kind: "removed"; text: string };

/** The file's lines with the removed ones put back in, and where each run of changes starts, for the arrow keys. */
export function rowsOf(lines: readonly string[], marks: LineMarks): { rows: Row[]; changes: number[] } {
  const rows: Row[] = [];
  const changes: number[] = [];
  let inChange = false;
  const push = (row: Row) => {
    const changed = row.kind === "removed" || row.added;
    if (changed && !inChange) changes.push(rows.length);
    inChange = changed;
    rows.push(row);
  };
  lines.forEach((text, i) => {
    const no = i + 1;
    for (const gone of marks.removed.get(no) ?? []) push({ kind: "removed", text: gone });
    push({ kind: "line", no, text, added: marks.added.has(no) });
  });
  for (const gone of marks.removed.get(lines.length + 1) ?? []) push({ kind: "removed", text: gone });
  return { rows, changes };
}
