/**
 * Typed bridge to `server.rs`'s `start_browser_server`: starts `roer-server`
 * in-process (idempotent — a second call is a no-op) and opens its one-time
 * bootstrap URL in the system browser itself, since that URL is a plain
 * `http://127.0.0.1` link `open_url`'s web-link check would reject. The
 * menu's "Open This Session in a Browser…" triggers it.
 */
import { invoke, listen, type UnlistenFn } from "./backend";

export const startBrowserServer = (): Promise<void> => invoke("start_browser_server");

/** The menu item was chosen. */
export const onBrowserServerMenu = (handler: () => void): Promise<UnlistenFn> =>
  listen("roer://browser-server", () => handler());
