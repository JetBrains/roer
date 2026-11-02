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

/** Opens one tab of the stage, by its strip id, in the system browser as a
 * page of its own. */
export const openTabInBrowser = (tab: string): Promise<void> => invoke("open_tab_in_browser", { tab });

/** What a tab in a browser asks the Roer window to do on its stage. */
export type StageAction =
  | { kind: "activateTab"; tabId: string }
  | { kind: "showSession"; pane: string }
  | { kind: "startSession"; cwd: string; prompt: string; pickAgent?: boolean };

/** Hands `action` to the Roer window, which comes forward to do it. */
export const sendStageAction = (action: StageAction): Promise<void> => invoke("stage_action", { action });

/** A tab in a browser asked for `action`. */
export const onStageAction = (handler: (action: StageAction) => void): Promise<UnlistenFn> =>
  listen<StageAction>("roer://stage-action", (event) => handler(event.payload));
