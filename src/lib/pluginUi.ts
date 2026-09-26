/**
 * Typed bridge to the plugin-UI watcher: `roer plugin-ui` piped an A2UI v1.0
 * message, tagged with the pane it came from.
 *
 * The reverse direction, `reportPluginUiAction`, is the same shape run
 * backwards: v1.0's renderer-to-agent `action` message, tagged with the
 * pane so `roer plugin-ui-actions` knows which terminal to deliver it to.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { type LegacyBundle } from "../generative-ui/legacy";
import { A2UI_VERSION, isA2uiMessage, type A2uiMessage, type DataModel } from "../generative-ui/schema";

type CreateSurfaceMessage = Extract<A2uiMessage, { createSurface: unknown }>;

export interface PluginUiRecord {
  pane: string;
  message: A2uiMessage;
}

/** The generic on `listen` is a compile-time label, not a runtime check —
 * the payload is raw JSON off a terminal pipe. Drop a record whose shape
 * doesn't match rather than hand the reducer something it can't handle. */
function isPluginUiRecord(value: unknown): value is PluginUiRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.pane === "string" && isA2uiMessage(v.message);
}

export const onPluginUi = (handler: (record: PluginUiRecord) => void): Promise<UnlistenFn> =>
  listen<PluginUiRecord>("roer://plugin-ui", (event) => {
    if (isPluginUiRecord(event.payload)) handler(event.payload);
  });

/**
 * A component's action on its way to the terminal: v1.0's own renderer-to-
 * agent `action` message, tagged with the pane. `dataModel` travels beside
 * the message rather than inside it, the way A2A carries a surface's data
 * model in transport metadata when `createSurface` asked for `sendDataModel`.
 */
export interface PluginUiAction {
  pane: string;
  message: {
    version: typeof A2UI_VERSION;
    action: {
      name: string;
      surfaceId: string;
      sourceComponentId: string;
      timestamp: string;
      context: Record<string, unknown>;
      userMessage?: string;
    };
  };
  dataModel?: DataModel;
}

export const reportPluginUiAction = (action: PluginUiAction): Promise<void> =>
  invoke("report_plugin_ui_action", { action });

/**
 * A saved plugin UI: the prompt that produced it, plus the one v1.0
 * `createSurface` message that builds it — components and data model inline.
 * A bundle saved before v1.0 comes back as `legacy` instead, its old files
 * as they were, for `upgradeBundle` to turn into a `surface` once.
 */
export interface PluginUiBundle {
  prompt: string;
  surface?: CreateSurfaceMessage;
  legacy?: LegacyBundle;
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
  bundle: PluginUiBundle & { surface: CreateSurfaceMessage },
): Promise<void> => invoke("write_plugin_ui_bundle", { cwd, name, bundle });
