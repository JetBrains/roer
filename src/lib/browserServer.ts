/**
 * Typed bridge to `server.rs`'s `start_browser_server`: starts `roer-server`
 * in-process (idempotent — a second call is a no-op) and opens its one-time
 * bootstrap URL in the system browser itself, since that URL is a plain
 * `http://127.0.0.1` link `open_url`'s web-link check would reject. The
 * menu's "Open This Session in a Browser…" triggers it.
 */
import { invoke, listen, type UnlistenFn } from "./backend";

export const startBrowserServer = (): Promise<void> => invoke("start_browser_server");

/**
 * Starts it the same way, but puts a link on the clipboard instead: one
 * with a code that lets one browser in, once, within a minute, rather than
 * the server's token. Offered on the title bar's browser button.
 */
export const copyBrowserLink = (): Promise<void> => invoke("copy_browser_link");

/** The menu item was chosen. */
export const onBrowserServerMenu = (handler: () => void): Promise<UnlistenFn> =>
  listen("roer://browser-server", () => handler());
