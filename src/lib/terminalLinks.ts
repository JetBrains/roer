import { isMac } from "./keys";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What a link in the terminal points at. Web links go to the person's
 * browser; a `file:` link, which Claude Code writes around the paths it
 * prints (OSC 8), names a file to open in Roer. Anything else (`javascript:`,
 * `mailto:`, an app's own scheme) is not opened at all: the system opener
 * would launch whatever it names.
 */
export type LinkTarget = { kind: "web"; url: string } | { kind: "file"; path: string; line?: number };

/**
 * A click that opens a link: a plain left click, or Cmd+click on macOS
 * (Ctrl+click elsewhere), which many terminals ask for.
 * Shift+click and Alt/Option+click stay xterm's own, extending a selection
 * and forcing one, and Ctrl+click on macOS is a right-click there.
 */
export const isOpenGesture = (
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean => {
  if (event.button !== 0 || event.shiftKey || event.altKey) return false;
  const own = isMac() ? event.metaKey : event.ctrlKey;
  const other = isMac() ? event.ctrlKey : event.metaKey;
  return !other && (own || !(event.metaKey || event.ctrlKey));
};

export function linkTarget(uri: string): LinkTarget | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return { kind: "web", url: url.href };
  // Plain http only on this machine, a dev server's; as the backend has it.
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname) ? { kind: "web", url: url.href } : null;
  if (url.protocol !== "file:") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // `file:///C:/x` on Windows.
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  // An editor-style `#L12`, or `#12`, names the line.
  const line = /^#L?(\d+)/.exec(url.hash)?.[1];
  return line ? { kind: "file", path, line: Number(line) } : { kind: "file", path };
}

/** `path` relative to `root` when it lies inside it, with `/` separators;
 * null for a file elsewhere, which Roer's file view does not show. */
export function insideRoot(root: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const full = norm(path);
  if (!full.startsWith(`${base}/`)) return null;
  const rel = full.slice(base.length + 1);
  return rel.split("/").some((part) => part === ".." || part === "") ? null : rel;
}
