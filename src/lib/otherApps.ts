/**
 * The apps that open Roer's extensions in their chats, as MCP Apps: the Claude app and Codex
 * (`src-tauri/src/other_apps.rs`). Connecting one registers `roer mcp` with it.
 */
import { invoke } from "./backend";

export interface OtherApp {
  /** `roer mcp --client`'s name for it. */
  id: string;
  name: string;
  /** Not on this machine, Roer's own entry, a `roer` entry the person wrote (left alone), or not connected. */
  state: "missing" | "connected" | "theirs" | "off";
  command?: string | null;
  config?: string | null;
}

export const otherApps = (): Promise<OtherApp[]> => invoke("other_apps");

/** Connects the app, or disconnects it, and says how they all stand after. */
export const connectOtherApp = (id: string, connect: boolean): Promise<OtherApp[]> =>
  invoke("other_app_connect", { id, connect });

/** What a manifest lists in `hosts` to open in these apps. */
export const MCP_APP_HOST = "mcp-app";
