/**
 * A line in the app's log file (Help > Show Logs in Finder), which is what a
 * user sends when a session will not open or a terminal draws wrong. The
 * webview has no file of its own, so the backend writes it.
 *
 * Never throws and never waits: a log that cannot be written must not become
 * the failure being reported.
 */
import { invoke } from "./backend";

export function logLine(message: string): void {
  // Tests stub the backend piecemeal; a log line is not what they are about.
  if (import.meta.env.MODE === "test") return;
  void invoke("app_log", { message }).catch(() => undefined);
}

/** Uncaught errors, which would otherwise only reach a devtools console the
 * release build has no way to open. */
export function logUncaught(): void {
  window.addEventListener("error", (event) => {
    logLine(`uncaught: ${event.message} at ${event.filename}:${event.lineno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    logLine(`unhandled rejection: ${String(event.reason)}`);
  });
}
