/**
 * Opening Settings from anywhere in the window, at one of its sections: a placeholder for a picture from the web
 * points to where pictures are switched on. The app registers how it opens the dialog; where there is none (a browser
 * page, another app's chat), nothing offers to.
 */
import { useEffect, useSyncExternalStore } from "react";

export type SettingsSection = "keyboard" | "threads" | "privacy" | "extensions";

let opener: ((section?: SettingsSection) => void) | null = null;
const listeners = new Set<() => void>();

export function openSettings(section?: SettingsSection): void {
  opener?.(section);
}

/** Whether this window can open Settings. */
export const useCanOpenSettings = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => opener !== null,
  );

/** Makes `open` what `openSettings` calls, while the caller is mounted. */
export function useSettingsOpener(open: (section?: SettingsSection) => void): void {
  useEffect(() => {
    opener = open;
    for (const listener of listeners) listener();
    return () => {
      if (opener === open) opener = null;
      for (const listener of listeners) listener();
    };
  }, [open]);
}
