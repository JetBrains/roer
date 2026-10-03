/**
 * Loads the extensions that live on disk into the registry, and reloads one
 * whenever the backend says its build changed.
 *
 * A built extension crosses the bridge as text and is imported from a blob
 * URL, which works the same in the desktop app and in a browser tab on
 * `roer-server`: no URL scheme or route of its own to serve it from.
 */
import { useEffect } from "react";

import { invoke, listen } from "../lib/backend";
import type { Extension } from "./api";
import { syncBundled } from "./bundled";
import { registry, type Registry } from "./registry";

export const EXTENSIONS_EVENT = "roer://extensions";

/** One extension on disk and how its last build went (`extensions.rs`). */
export interface ExtensionInfo {
  id: string;
  name: string;
  description?: string | null;
  scope: "user" | "session";
  dir: string;
  hash: string;
  ok: boolean;
  hasApp: boolean;
  hasServer?: boolean;
  errors: string[];
  builtAt: number;
  /** Switched off: neither built nor loaded. */
  disabled?: boolean;
}

interface Bundle {
  js: string;
  css: string | null;
  hash: string;
}

export const listExtensions = (): Promise<ExtensionInfo[]> => invoke("extensions_list");

/** The ids switched off, bundled ones included. */
export const listDisabled = (): Promise<string[]> => invoke("extensions_disabled");

/** Switches one on or off; every window loads or unloads it once the backend has written it down. */
export const setExtensionEnabled = (id: string, enabled: boolean): Promise<void> =>
  invoke("extension_set_enabled", { id, enabled });

/** Writes to the extension's log, which `roer ext logs` and its agent read. */
export const logExtension = (id: string, message: string): Promise<void> =>
  invoke<void>("extension_log", { id, message }).catch(() => undefined);

/** The hash each extension was last loaded from, so an unchanged one is left alone. */
const loadedHash = new Map<string, string>();

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
}

/** Puts the extension's stylesheet in the document, replacing its last one. */
function setStyle(id: string, css: string | null): void {
  const selector = `style[data-roer-extension="${id}"]`;
  document.querySelector(selector)?.remove();
  if (!css) return;
  const style = document.createElement("style");
  style.dataset.roerExtension = id;
  style.textContent = css;
  document.head.append(style);
}

async function importText(js: string): Promise<{ default?: Extension }> {
  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ url)) as { default?: Extension };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Loads one extension as `info` describes it, or unloads it when there is nothing to run. */
export async function loadOne(info: ExtensionInfo, into: Registry = registry, announce = false): Promise<void> {
  if (info.disabled) {
    into.unload(info.id);
    setStyle(info.id, null);
    loadedHash.delete(info.id);
    return;
  }
  if (!info.ok || !info.hasApp) {
    // A failed build keeps the last good version running, as an activation
    // that throws does: the agent fixes it, and the person's tab stays up.
    if (!info.ok && into.has(info.id)) return;
    into.unload(info.id);
    setStyle(info.id, null);
    loadedHash.delete(info.id);
    return;
  }
  if (loadedHash.get(info.id) === info.hash && into.has(info.id)) {
    // Built again from the same sources, which `roer ext dev` asks for and then waits to hear about: what is
    // running already is that build.
    if (announce) void logExtension(info.id, "loaded");
    return;
  }

  try {
    const bundle = await invoke<Bundle>("extension_bundle", { id: info.id });
    const module = await importText(bundle.js);
    const extension = module.default;
    if (!extension || typeof extension.activate !== "function") {
      throw new Error("app.tsx must `export default defineExtension(...)`");
    }
    into.load(info.id, extension);
    setStyle(info.id, bundle.css);
    loadedHash.set(info.id, bundle.hash);
    void logExtension(info.id, "loaded");
  } catch (error) {
    void logExtension(info.id, `activation failed: ${describe(error)}`);
  }
}

/** Every extension on disk, loaded, and kept in step with the folders. */
export function useExternalExtensions(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const sync = async (only?: readonly string[]) => {
      const [all, disabled] = await Promise.all([
        listExtensions().catch(() => [] as ExtensionInfo[]),
        listDisabled().catch(() => [] as string[]),
      ]);
      if (cancelled) return;
      const present = new Set(all.map((info) => info.id));
      for (const info of all) {
        if (!only || only.includes(info.id)) await loadOne(info, registry, only !== undefined);
      }
      // Gone from disk: removed, or its session folder went away.
      for (const id of [...loadedHash.keys()]) {
        if (!present.has(id)) {
          registry.unload(id);
          setStyle(id, null);
          loadedHash.delete(id);
        }
      }
      // Last, so a built-in comes back in the same pass that unloaded a fork of it under its id.
      syncBundled(new Set(disabled));
    };

    // One sync at a time, in order: two loads of one extension racing could
    // leave the older bundle active, and nothing later would put it right.
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (only?: readonly string[]) => {
      queue = queue.then(() => sync(only)).catch(() => undefined);
    };

    enqueue();
    void listen<{ changed: string[] }>(EXTENSIONS_EVENT, (event) => enqueue(event.payload.changed)).then(
      (stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      },
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
