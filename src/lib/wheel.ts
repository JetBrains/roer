/**
 * Scrolling a tmux session with the wheel or a trackpad.
 *
 * With tmux's `mouse on`, xterm.js hands the wheel to tmux as mouse reports,
 * but sends one report per wheel event however far it moved, and counts a
 * trackpad's deltas at a third: a swipe and the momentum after it came out
 * as a few reports, which tmux turned into 5 lines each. So Roer sends the
 * reports itself, one per line the pixels add up to, and tmux scrolls one
 * line for each report from Roer's own terminal (see `announce` in the CLI's
 * tmux.rs), which it knows by the name Roer answers XTVERSION with. roer
 * says when that binding is there; without it xterm's own reports stay.
 */

/** What Roer's terminal calls itself when tmux asks (XTVERSION). */
export const TERMINAL_NAME = "Roer";

/** The answer to XTVERSION (`CSI > q`): `DCS > | name ST`. */
export const xtversionReply = (version = ""): string =>
  `\x1bP>|${TERMINAL_NAME}${version ? ` ${version}` : ""}\x1b\\`;

/** The most lines one wheel event scrolls, so a hard fling cannot flood the
 * session with reports. */
const MAX_LINES = 200;

/** Pixels carried over between wheel events: what has not made a line yet. */
export interface WheelCarry {
  pixels: number;
}

/**
 * How many lines a wheel event scrolls, positive downwards, with what is left
 * of a line carried to the next event. `cellHeight` and `rows` are the
 * terminal's, in CSS pixels and lines. Turning back drops what was carried.
 */
export function wheelLines(carry: WheelCarry, event: Pick<WheelEvent, "deltaY" | "deltaMode">, cellHeight: number, rows: number): number {
  if (event.deltaY === 0 || !(cellHeight > 0)) return 0;
  const pixels =
    event.deltaMode === 1 ? event.deltaY * cellHeight : event.deltaMode === 2 ? event.deltaY * rows * cellHeight : event.deltaY;
  if (Math.sign(pixels) !== Math.sign(carry.pixels)) carry.pixels = 0;
  carry.pixels += pixels;
  const lines = Math.trunc(carry.pixels / cellHeight) || 0; // never -0
  carry.pixels -= lines * cellHeight;
  if (Math.abs(lines) <= MAX_LINES) return lines;
  // What a fling moved past the cap is dropped, not scrolled later.
  carry.pixels = 0;
  return Math.sign(lines) * MAX_LINES;
}

/**
 * The mouse reports for `lines` of scrolling at a cell (1-based), as the
 * terminal's mouse encoding writes them: SGR (`CSI < 64 ; x ; y M`) once the
 * program asked for it with mode 1006, else the original `CSI M` bytes.
 */
export function wheelReports(lines: number, col: number, row: number, sgr: boolean): string {
  if (lines === 0) return "";
  const button = lines < 0 ? 64 : 65;
  const one = sgr
    ? `\x1b[<${button};${col};${row}M`
    : `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`;
  return one.repeat(Math.abs(lines));
}

/** How a program asked for mouse reports to be written: SGR (mode 1006),
 * the original bytes, or another encoding (1005, 1015, 1016) left to xterm. */
export type MouseEncoding = "default" | "sgr" | "other";

/** The encoding once a program sets (`on`) or resets modes `params`. */
export function nextEncoding(current: MouseEncoding, params: (number | number[])[], on: boolean): MouseEncoding {
  let encoding = current;
  for (const param of params.flat()) {
    const named: MouseEncoding | null = param === 1006 ? "sgr" : param === 1005 || param === 1015 || param === 1016 ? "other" : null;
    if (!named) continue;
    if (on) encoding = named;
    else if (encoding === named) encoding = "default";
  }
  return encoding;
}

/** The cell (1-based) at `offset` pixels along an edge of `size` pixels split
 * into `count` cells, kept on the grid at its edges. */
export const cellAt = (offset: number, size: number, count: number): number =>
  Math.min(count, Math.max(1, Math.floor((offset / size) * count) + 1));
