/**
 * Typed bridge to the plugin-UI watcher: `roer plugin-ui` piped an A2UI-shaped
 * message, tagged with the pane it came from.
 *
 * The reverse direction, `reportPluginUiAction`, is the same shape run
 * backwards: A2UI's own client-to-server `action` message, tagged with the
 * pane so `roer plugin-ui-actions` knows which terminal to deliver it to.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { A2uiMessage } from "../generative-ui/schema";

export interface PluginUiRecord {
  pane: string;
  message: A2uiMessage;
}

export const onPluginUi = (handler: (record: PluginUiRecord) => void): Promise<UnlistenFn> =>
  listen<PluginUiRecord>("roer://plugin-ui", (event) => handler(event.payload));

export interface PluginUiAction {
  pane: string;
  surfaceId: string;
  name: string;
  sourceComponentId: string;
  timestamp: string;
  context?: unknown;
}

export const reportPluginUiAction = (action: PluginUiAction): Promise<void> =>
  invoke("report_plugin_ui_action", { action });

/**
 * A saved plugin UI: the prompt that produced it, plus the exact messages
 * that build it — the same shapes `roer plugin-ui` already carries, kept
 * separate rather than merged into one object so each one round-trips
 * losslessly through the Rust side's opaque `serde_json::Value` handling.
 */
export interface PluginUiBundle {
  prompt: string;
  surfaceUpdate: Extract<A2uiMessage, { kind: "surfaceUpdate" }>;
  dataModelUpdate?: Extract<A2uiMessage, { kind: "dataModelUpdate" }>;
}

export interface PluginUiBundleSummary {
  name: string;
  prompt: string;
}

export const listPluginUiBundles = (cwd: string): Promise<PluginUiBundleSummary[]> =>
  invoke("list_plugin_ui_bundles", { cwd });

export const readPluginUiBundle = (cwd: string, name: string): Promise<PluginUiBundle> =>
  invoke("read_plugin_ui_bundle", { cwd, name });

export const writePluginUiBundle = (
  cwd: string,
  name: string,
  bundle: PluginUiBundle,
): Promise<void> => invoke("write_plugin_ui_bundle", { cwd, name, bundle });
