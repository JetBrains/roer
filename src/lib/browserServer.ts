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

/** Opens one tab of the stage in the system browser as a page of its own:
 * `page` is that page's path, from `tabPagePath`. */
export const openTabInBrowser = (page: string): Promise<void> => invoke("open_tab_in_browser", { page });

/** A session as a browser page names it: its pane, and the session's own id,
 * which a pane number a later tmux server reuses does not share. */
export interface StagedSession {
  pane: string;
  id?: string;
  cwd?: string;
}

/** The page for `tabId`, pinned to `session` when there is one. */
export function tabPagePath(tabId: string, session?: StagedSession | null): string {
  const query = new URLSearchParams({ tab: tabId });
  if (session) {
    query.set("pane", session.pane);
    if (session.id) query.set("id", session.id);
    if (session.cwd) query.set("cwd", session.cwd);
  }
  return `/?${query.toString()}`;
}

/** What a tab in a browser asks the Roer window to do on its stage. A
 * `request` asks to hear back once it is done (`onStageActionDone`). */
export type StageAction =
  | { kind: "activateTab"; tabId: string }
  | { kind: "showSession"; pane: string }
  | { kind: "startSession"; cwd: string; prompt: string; pickAgent?: boolean; request?: string };

/** Hands `action` to the Roer window, which comes forward to do it. */
export const sendStageAction = (action: StageAction): Promise<void> => invoke("stage_action", { action });

/** A tab in a browser asked for `action`. */
export const onStageAction = (handler: (action: StageAction) => void): Promise<UnlistenFn> =>
  listen<StageAction>("roer://stage-action", (event) => handler(event.payload));

/** Whether the window did what a page's `request` asked. */
export interface StageActionDone {
  request: string;
  ok: boolean;
}

/** The window's: it did, or did not do, what a page asked to hear back about. */
export const stageActionDone = (done: StageActionDone): Promise<void> => invoke("stage_action_done", { done });

/** A page's: the window answered one of its requests. */
export const onStageActionDone = (handler: (done: StageActionDone) => void): Promise<UnlistenFn> =>
  listen<StageActionDone>("roer://stage-action-done", (event) => handler(event.payload));

/** The window's: its stage shows `stage` now. */
export const announceStage = (stage: StagedSession | null): Promise<void> => invoke("stage_announce", { stage });

/** A page's: what the stage shows, as the window last said. */
export const currentStage = (): Promise<StagedSession | null> => invoke("stage_current");

/** A page's: the stage moved to another session. */
export const onStage = (handler: (stage: StagedSession | null) => void): Promise<UnlistenFn> =>
  listen<StagedSession | null>("roer://stage", (event) => handler(event.payload));
