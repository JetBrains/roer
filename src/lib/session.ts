/**
 * Which directory a session is in, which is the question everything about a
 * repository starts from.
 */
import { listSessions } from "./pty";

/**
 * The directory to ask about. A session's own directory moves — `cd` in the
 * terminal is the usual way to change repository — so the live pane is the
 * better answer, and the directory it was opened in is the fallback.
 */
export async function resolveDir(cwd?: string, pane?: string): Promise<string> {
  if (pane) {
    try {
      const live = (await listSessions()).find((s) => s.pane === pane)?.cwd;
      if (live) return live;
    } catch {
      /* The shim is unavailable; the opening directory is still right unless
         the session has moved. */
    }
  }
  return cwd ?? "";
}
