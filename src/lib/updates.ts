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
}

/** `null` when the app skips checking on its own, as a build from the checkout does. */
export const checkForUpdate = (automatic: boolean): Promise<UpdateStatus | null> =>
  invoke("update_check", { automatic });

export const skipUpdate = (version: string): Promise<void> => invoke("update_skip", { version });

/** "Check for Updates…" was chosen. */
export const onCheckUpdatesMenu = (handler: () => void): Promise<UnlistenFn> =>
  listen("roer://check-updates", () => handler());
