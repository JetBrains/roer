/**
 * Experimental features the person can switch off in Settings. Each is on unless switched off.
 *
 * Comments (threads on files and views, Needs you) are the bundled `threads` extension: switching them off switches
 * it off, so agents are no longer offered its tools either, and the app's own parts of the feature hide with it.
 * The list of what is switched off is the backend's (`~/.roer/extensions/.disabled.json`), so every window and
 * `roer mcp` agree; the threads themselves are kept, and come back when it is switched on again.
 */
import { useSyncExternalStore } from "react";

import { EXTENSIONS_EVENT, listDisabled, setExtensionEnabled } from "../extensions/loader";
import { listen } from "./backend";

export const COMMENTS_EXTENSION = "threads";

let commentsOn = true;
const listeners = new Set<() => void>();
let started = false;

const refresh = () =>
  listDisabled()
    .then((off) => {
      const next = !off.includes(COMMENTS_EXTENSION);
      if (next === commentsOn) return;
      commentsOn = next;
      for (const listener of listeners) listener();
    })
    .catch(() => undefined);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!started) {
    started = true;
    void refresh();
    void listen(EXTENSIONS_EVENT, () => void refresh()).catch(() => undefined);
  }
  return () => listeners.delete(listener);
};

/** Whether comments and Needs you are on. */
export function useCommentsOn(): boolean {
  return useSyncExternalStore(subscribe, () => commentsOn);
}

/** Switches comments and Needs you on or off, in every window. */
export async function setCommentsOn(on: boolean): Promise<void> {
  await setExtensionEnabled(COMMENTS_EXTENSION, on);
  await refresh();
}
