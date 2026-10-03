/**
 * The extensions that ship inside the app. Each is a folder here, built by
 * Vite with the rest of the app rather than by Bun, and importing only
 * `roer`, `react` and its own files, so that its folder is also what a fork
 * of it starts from.
 */
import type { Extension } from "./api";
import changes from "./changes/app";
import changesManifest from "./changes/extension.json";
import { registry, type Registry } from "./registry";

export const BUNDLED: ReadonlyArray<{ id: string; name: string; description: string; extension: Extension }> = [
  { ...changesManifest, extension: changes },
];

export function loadBundled(into: Registry = registry): void {
  for (const { id, extension } of BUNDLED) {
    if (!into.has(id)) into.load(id, extension, { bundled: true });
  }
}

/** Unloads the bundled extensions the person switched off, and loads the rest again. */
export function syncBundled(disabled: ReadonlySet<string>, into: Registry = registry): void {
  for (const { id, extension } of BUNDLED) {
    if (disabled.has(id)) into.unload(id);
    else if (!into.has(id)) into.load(id, extension, { bundled: true });
  }
}
