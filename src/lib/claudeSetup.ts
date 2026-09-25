/**
 * Typed bridge to `claude_setup.rs`: whether Roer's skills and MCP server
 * are set up in Claude Code, and changing that. The first launch that finds
 * Claude Code asks; the menu's "Claude Code Integration…" asks again.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SetupStatus {
  /** Claude Code is on this machine: without it there is nothing to set up. */
  claudeCode: boolean;
  /** Roer's skills (`/roer-handoff`) are in `~/.claude/skills`. */
  skills: boolean;
  /** `roer mcp` is registered with Claude Code. */
  mcp: boolean;
  /** Ask now: Claude Code is here and nothing about Roer in it is decided. */
  shouldPrompt: boolean;
}

export const claudeSetupStatus = (): Promise<SetupStatus> => invoke("claude_setup_status");

export const applyClaudeSetup = (skills: boolean, mcp: boolean): Promise<SetupStatus> =>
  invoke("claude_setup_apply", { skills, mcp });

export const dismissClaudeSetup = (): Promise<void> => invoke("claude_setup_dismiss");

/** The menu item was chosen. */
export const onClaudeSetupMenu = (handler: () => void): Promise<UnlistenFn> =>
  listen("roer://claude-setup", () => handler());
