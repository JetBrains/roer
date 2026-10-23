/**
 * Typed bridge to `updates.rs`: whether a newer Roer is published. Only the
 * desktop app asks; a browser tab is served by whatever `roer-server` runs.
 */
import { invoke, listen, type UnlistenFn } from "./backend";

export interface UpdateStatus {
  current: string;
  latest: string;
  /** `latest` is newer than `current`. */
  newer: boolean;
  /** Skipped when it was offered before. */
  skipped: boolean;
  /** The release's page: its notes and downloads. */
  url: string;
  /** The app can install it in its own place and start again. */
  canInstall: boolean;
}

/** How far `installUpdate` has got. */
export interface UpdateProgress {
  stage: "download" | "verify" | "install" | "restart";
  /** Bytes downloaded so far. */
  received: number;
  /** The download's size, when known. */
  total: number | null;
}

/** `null` when the app skips checking on its own, as a build from the checkout does. */
export const checkForUpdate = (automatic: boolean): Promise<UpdateStatus | null> =>
  invoke("update_check", { automatic });

/**
 * Downloads `version`, checks its signature, installs it in place of this app
 * and starts it: the app quits on success, so this settles only on failure.
 */
export const installUpdate = (version: string): Promise<void> => invoke("update_install", { version });

export const onUpdateProgress = (handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>("roer://update-progress", (event) => handler(event.payload));

export const skipUpdate = (version: string): Promise<void> => invoke("update_skip", { version });

/** "Check for Updates…" was chosen. */
export const onCheckUpdatesMenu = (handler: () => void): Promise<UnlistenFn> =>
  listen("roer://check-updates", () => handler());
