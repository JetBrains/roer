/**
 * A `localStorage` that Roer's window and its browser pages share: what a tab
 * keeps that must read the same wherever it is open, such as a branch's
 * review comments in Changes. The window and a browser page are different
 * origins, each with a `localStorage` of its own, so this keeps the values
 * in `$ROER_HOME/shared-state.json` instead (`shared_state.rs`), and every
 * change made in one view is told to the others.
 *
 * Reads stay synchronous, as `localStorage`'s are: `loadSharedStorage` reads
 * every value once before the page draws, and changes keep that copy in step.
 * Until it has loaded, or where the backend has no such store (a test, an
 * extension in another app's chat), it is the page's own `localStorage`.
 */
import { invoke, listen } from "./backend";

const values = new Map<string, string>();
const listeners = new Set<(key: string) => void>();
/** Loaded from the backend: values are kept there, not in `localStorage`. */
let shared = false;
/** Prefixes `adoptLocal` was asked for before the store loaded: an extension activates while it still loads. */
const adoptAfterLoad = new Set<string>();
let loading: Promise<void> | null = null;
/** `loadSharedStorage` has finished, whether or not the backend keeps a store. */
let settled = false;

/** Told every key read: what a saved copy keeps of the store (`src/copy`), and nothing more. */
let onRead: ((key: string) => void) | null = null;
export const trackSharedReads = (listener: ((key: string) => void) | null) => void (onRead = listener);

const tell = (key: string) => {
  for (const listener of listeners) listener(key);
};

/** Reads every shared value, then keeps them in step with every other view's changes. */
export function loadSharedStorage(): Promise<void> {
  loading ??= load().finally(() => {
    settled = true;
    for (const prefix of adoptAfterLoad) adoptLocal(prefix);
    adoptAfterLoad.clear();
  });
  return loading;
}

async function load(): Promise<void> {
  let all: unknown;
  try {
    all = await invoke<unknown>("shared_state_all");
  } catch {
    return;
  }
  if (typeof all !== "object" || all === null) return;
  for (const [key, value] of Object.entries(all)) if (typeof value === "string") values.set(key, value);
  shared = true;
  await listen<{ key: string; value: string | null }>("roer://shared-state", ({ payload }) => {
    if (payload.value === null) values.delete(payload.key);
    else values.set(payload.key, payload.value);
    tell(payload.key);
  }).catch(() => undefined);
}

function write(key: string, value: string | null): void {
  if (!shared) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* kept for as long as the page is open */
    }
    tell(key);
    return;
  }
  if (value === null) values.delete(key);
  else values.set(key, value);
  tell(key);
  void invoke("shared_state_set", { key, value }).catch(() => undefined);
}

export const sharedStorage = {
  getItem(key: string): string | null {
    onRead?.(key);
    if (!shared) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    return values.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    write(key, value);
  },
  removeItem(key: string): void {
    write(key, null);
  },
};

/** Called with the key whenever a shared value changes, in this view or another. */
export function onSharedStorage(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Moves what this page kept in its own `localStorage` under `prefix` into the
 * shared store, where it is not there already: a tab's state from before it
 * was shared, so nothing it had is lost.
 */
export function adoptLocal(prefix: string): void {
  if (!shared) {
    // Not loaded yet: done once it has. Loaded with no store behind it: nothing to move.
    if (!settled) adoptAfterLoad.add(prefix);
    return;
  }
  let keys: string[];
  try {
    keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
      (key): key is string => key !== null && key.startsWith(prefix),
    );
  } catch {
    return;
  }
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value !== null && !values.has(key)) write(key, value);
    localStorage.removeItem(key);
  }
}
