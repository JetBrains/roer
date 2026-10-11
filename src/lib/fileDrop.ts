/**
 * What a terminal types for files dropped on it, as a native one does: each
 * path quoted for the shell and separated by spaces, with one after the
 * last so typing can go on. Claude Code reads an image's path in what is
 * pasted and attaches the image.
 */
export function pathsAsTyped(paths: readonly string[], windows = isWindows()): string {
  return `${paths.map((path) => (windows ? quoteForWindows(path) : quoteForPosix(path))).join(" ")} `;
}

/** A backslash before anything a POSIX shell would read as more than a
 * letter of the name, as macOS Terminal and GNOME Terminal do. */
function quoteForPosix(path: string): string {
  return path.replace(/[^A-Za-z0-9_\-.,:/@%+=~\u0080-￿]/g, (c) => `\\${c}`);
}

/** Windows shells take a path with a space in double quotes, and a name
 * cannot hold a double quote itself. */
function quoteForWindows(path: string): string {
  return /[\s&()^;,'`!%]/.test(path) ? `"${path}"` : path;
}

const isWindows = (): boolean => /Win/.test(navigator.platform);

/** Whether a point lies inside an element's box on screen. */
export function isOver(element: Element, x: number, y: number): boolean {
  const box = element.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}
