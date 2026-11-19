/**
 * Whether pictures, videos and sounds from the web load without asking, in what others write (threads, comments,
 * pull requests, files under review, agents' views): never, by default, since an agent that read something hostile
 * can be made to write a picture whose address carries a secret out; for every host, when the person says so in
 * Settings; or for the hosts they let through from a placeholder. Kept in this window's storage; other windows of
 * Roer hear of a change.
 */
import { useSyncExternalStore } from "react";

export interface RemoteMediaPrefs {
  /** Load from every host without asking. */
  always: boolean;
  /** The hosts loaded from without asking, one at a time. */
  hosts: readonly string[];
}

const KEY = "roer:remote-media";
const NONE: RemoteMediaPrefs = { always: false, hosts: [] };
const listeners = new Set<() => void>();
let read: { raw: string | null; value: RemoteMediaPrefs } = { raw: null, value: NONE };

export function remoteMediaPrefs(): RemoteMediaPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return read.value;
  }
  if (raw === read.raw) return read.value;
  let value = NONE;
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<RemoteMediaPrefs> | null;
    if (parsed && typeof parsed === "object") {
      value = {
        always: parsed.always === true,
        hosts: Array.isArray(parsed.hosts) ? parsed.hosts.filter((one): one is string => typeof one === "string") : [],
      };
    }
  } catch {
    /* unreadable: ask */
  }
  read = { raw, value };
  return value;
}

function write(next: RemoteMediaPrefs): void {
  const raw = JSON.stringify(next);
  read = { raw, value: next };
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    /* kept for as long as the window is open */
  }
  for (const listener of listeners) listener();
}

export const setAlwaysShow = (always: boolean): void => write({ ...remoteMediaPrefs(), always });

export function allowHost(host: string, on = true): void {
  const { hosts, always } = remoteMediaPrefs();
  const rest = hosts.filter((one) => one !== host);
  write({ always, hosts: on ? [...rest, host].sort() : rest });
}

/** Asks again for every host let through. */
export const forgetHosts = (): void => write({ ...remoteMediaPrefs(), hosts: [] });

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another window of Roer changed it.
  const onStorage = (event: StorageEvent) => event.key === KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export const useRemoteMediaPrefs = (): RemoteMediaPrefs => useSyncExternalStore(subscribe, remoteMediaPrefs);
