/**
 * Typed bridge to `claude_setup.rs`: Claude Code's skills and MCP server,
 * plus the shared authoring skill for Codex, Pi and Junie. The first launch
 * that finds Claude Code asks; the Agent Integrations menu opens it again.
 */
import { invoke, listen, type UnlistenFn } from "./backend";

export interface SetupStatus {
  /** Claude Code is on this machine: without it there is nothing to set up. */
  claudeCode: boolean;
  /** Roer's skills (`/roer-handoff`) are in `~/.claude/skills`. */
  skills: boolean;
  /** Extension authoring is in the shared `~/.agents/skills` directory. */
  sharedSkills: boolean;
  /** `roer mcp` is registered with Claude Code. */
  mcp: boolean;
  /** Ask now: Claude Code is here and nothing about Roer in it is decided. */
  shouldPrompt: boolean;
}

export const claudeSetupStatus = (): Promise<SetupStatus> => invoke("claude_setup_status");

export const applyClaudeSetup = (skills: boolean, sharedSkills: boolean, mcp: boolean): Promise<SetupStatus> =>
  invoke("claude_setup_apply", { skills, sharedSkills, mcp });

export const dismissClaudeSetup = (): Promise<void> => invoke("claude_setup_dismiss");

/** The menu item was chosen. */
export const onClaudeSetupMenu = (handler: () => void): Promise<UnlistenFn> =>
  listen("roer://claude-setup", () => handler());
