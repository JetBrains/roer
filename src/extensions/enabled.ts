/**
 * Which extensions are switched on, apart from the loader: what Settings' switches read and write, so a module that
 * only asks (the `roer` SDK's `useCommentsOn`) does not pull in the loader and every bundled extension with it.
 */
import { invoke } from "../lib/backend";

/** Told whenever an extension is installed, removed, rebuilt, or switched on or off. */
export const EXTENSIONS_EVENT = "roer://extensions";

/** The ids switched off, bundled ones included. */
export const listDisabled = (): Promise<string[]> => invoke("extensions_disabled");

/** Switches one on or off; every window loads or unloads it once the backend has written it down. */
export const setExtensionEnabled = (id: string, enabled: boolean): Promise<void> =>
  invoke("extension_set_enabled", { id, enabled });
