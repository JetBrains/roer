/**
 * A Markdown file's change as a reader sees it: the blocks it has (a
 * paragraph, a heading, a list, a table, a fenced block), each kept, added or
 * taken out, so both versions can be drawn rendered with the difference
 * marked rather than as lines of source.
 */

export interface Block {
  kind: "same" | "add" | "del";
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * `text` cut into its blocks: at blank lines, except inside a fenced block,
 * where a blank line is part of the code.
 */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const opens = FENCE.exec(line);
    if (fence) {
      current.push(line);
      // Closed by a run of the same character at least as long, and nothing else.
      if (opens && opens[1][0] === fence[0] && opens[1].length >= fence.length && line.trim() === opens[1]) fence = null;
      continue;
    }
    if (opens) {
      fence = opens[1];
      current.push(line);
      continue;
    }
    if (line.trim() === "") flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/** Past this many blocks a side, the two are not matched up: everything old goes, everything new comes. */
const MAX_BLOCKS = 3000;

/**
 * The blocks of `before` and `after` in reading order, each marked kept,
 * added or taken out. Matched on the longest run they share, so a block that
 * was edited shows as the old one taken out and the new one in its place.
 */
export function diffBlocks(before: string, after: string): Block[] {
  const old = splitBlocks(before);
  const now = splitBlocks(after);
  if (old.length > MAX_BLOCKS || now.length > MAX_BLOCKS) {
    return [...old.map((text) => ({ kind: "del" as const, text })), ...now.map((text) => ({ kind: "add" as const, text }))];
  }
  const same = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  // Longest common subsequence, from the end, so the walk below goes forwards.
  const n = old.length;
  const m = now.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = same(old[i], now[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: Block[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(old[i], now[j])) {
      out.push({ kind: "same", text: now[j] });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
      // On a tie the removal goes first: an edited block reads best as the old one, then the new one.
      out.push({ kind: "del", text: old[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: now[j] });
      j += 1;
    }
  }
  return out;
}

/**
 * The link definitions (`[name]: url`) in `text`: a block drawn on its own
 * needs them to resolve its reference links, wherever in the file they are.
 */
export function definitions(text: string): string {
  return text
    .split("\n")
    .filter((line) => /^ {0,3}\[[^\]]+\]:\s*\S/.test(line))
    .join("\n");
}
