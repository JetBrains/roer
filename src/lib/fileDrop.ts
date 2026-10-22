import { isWindows } from "./keys";

/**
 * What a terminal types for files dropped on it, as a native one does: each
 * path quoted for the shell and separated by spaces, with one after the
 * last so typing can go on. Claude Code reads an image's path in what is
 * pasted and attaches the image.
 */
export function pathsAsTyped(paths: readonly string[], windows = isWindows()): string {
  return `${paths.map((path) => (windows ? quoteForWindows(path) : quoteForPosix(path))).join(" ")} `;
}

/** Control characters, which a backslash can't quote: before a newline it
 * joins two lines. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A backslash before anything a POSIX shell would read as more than a
 * letter of the name, as macOS Terminal and GNOME Terminal do; a name with a
 * control character in it goes in `$'…'` instead. */
function quoteForPosix(path: string): string {
  if (CONTROL.test(path)) return ansiQuoted(path);
  return path.replace(/[^A-Za-z0-9_\-.,:/@%+=~\u0080-￿]/g, (c) => `\\${c}`);
}

const NAMED: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };

/** `$'…'`, which bash and zsh read with C escapes. */
function ansiQuoted(path: string): string {
  const body = path
    .replace(/[\\']/g, (c) => `\\${c}`)
    .replace(/[\u0000-\u001f\u007f]/g, (c) => NAMED[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `$'${body}'`;
}

/** Windows shells take a path with a space in double quotes, and a name
 * cannot hold a double quote itself. */
function quoteForWindows(path: string): string {
  return /[\s&()^;,'`!%]/.test(path) ? `"${path}"` : path;
}

/** Whether a point is on an element: inside its box, and not on something
 * drawn over it, such as a dialog. */
export function isOver(element: Element, x: number, y: number): boolean {
  const box = element.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false;
  const top = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
  return top === null || element.contains(top);
}

/**
 * Where on the page a drag is, from the point Tauri reports. Tauri calls it
 * physical, but only Windows gives device pixels: macOS gives points and
 * Linux the widget's own, both already CSS pixels, so dividing those by the
 * pixel ratio put a drop on a 2x screen at half its place.
 */
export function dropPoint(
  position: { x: number; y: number },
  ratio = window.devicePixelRatio || 1,
  windows = isWindows(),
): { x: number; y: number } {
  const scale = windows ? ratio : 1;
  return { x: position.x / scale, y: position.y / scale };
}
