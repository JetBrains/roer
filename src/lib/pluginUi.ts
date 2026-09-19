/**
 * Typed bridge to the plugin-UI watcher: `roer plugin-ui` piped an A2UI-shaped
 * message, tagged with the pane it came from.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { A2uiMessage } from "../generative-ui/schema";

export interface PluginUiRecord {
  pane: string;
  message: A2uiMessage;
}

export const onPluginUi = (handler: (record: PluginUiRecord) => void): Promise<UnlistenFn> =>
  listen<PluginUiRecord>("roer://plugin-ui", (event) => handler(event.payload));
