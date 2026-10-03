/**
 * The extensions that ship inside the app. Each is a folder here, built by
 * Vite with the rest of the app rather than by Bun, and importing only
 * `roer`, `react` and its own files, so that its folder is also what a fork
 * of it starts from.
 */
import type { Extension } from "./api";
import changes from "./changes/app";
import codeReview from "./code-review/app";
import { registry, type Registry } from "./registry";

export const BUNDLED: ReadonlyArray<{ id: string; extension: Extension }> = [
  { id: "changes", extension: changes },
  { id: "code-review", extension: codeReview },
];

export function loadBundled(into: Registry = registry): void {
  for (const { id, extension } of BUNDLED) {
    if (!into.has(id)) into.load(id, extension, { bundled: true });
  }
}
