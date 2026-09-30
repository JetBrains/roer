/**
 * The agents a new session can start, and the named ones kept for reuse.
 *
 * A saved agent is only ever turned into a command line: `roer new --agent
 * <command>` types it into the new session's shell, so the frontend needs to
 * know each CLI's flags for a model and for how hard it reasons, and nothing
 * else about it.
 */

export type AgentKind = "claude" | "codex" | "junie" | "gemini" | "pi" | "custom";

export interface AgentKindInfo {
  label: string;
  /** One or two characters for its badge, told apart from the others. */
  badge: string;
  /** What is run when a saved agent names no command of its own. */
  command: string;
  /** Placeholder for the model field: an example, not a default. */
  modelHint: string;
  /** Reasoning levels the CLI takes on its command line, lightest first;
   * empty when it has no such flag. */
  efforts: readonly string[];
  /** The flags for a model and a reasoning level, each only when set. */
  flags: (model: string, effort: string) => string[];
}

const pair = (flag: string, value: string) => (value ? [flag, value] : []);

export const AGENT_KINDS: Record<AgentKind, AgentKindInfo> = {
  claude: {
    badge: "C",
    label: "Claude Code",
    command: "claude",
    modelHint: "opus, sonnet, haiku",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    flags: (model, effort) => [...pair("--model", model), ...pair("--effort", effort)],
  },
  codex: {
    badge: "Cx",
    label: "Codex",
    command: "codex",
    modelHint: "gpt-5-codex",
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    flags: (model, effort) => [
      ...pair("-m", model),
      ...pair("-c", effort && `model_reasoning_effort=${effort}`),
    ],
  },
  junie: {
    badge: "J",
    label: "Junie",
    command: "junie",
    modelHint: "sonnet, gpt",
    efforts: ["low", "medium", "high"],
    flags: (model, effort) => [...pair("--model", model), ...pair("--effort", effort)],
  },
  gemini: {
    badge: "G",
    label: "Gemini CLI",
    command: "gemini",
    modelHint: "gemini-2.5-pro",
    efforts: [],
    flags: (model) => pair("-m", model),
  },
  pi: {
    badge: "π",
    label: "pi",
    command: "pi",
    modelHint: "provider/model, e.g. openai/gpt-4o",
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    flags: (model, effort) => [...pair("--model", model), ...pair("--thinking", effort)],
  },
  custom: {
    badge: "›",
    label: "Other command",
    command: "",
    modelHint: "",
    efforts: [],
    flags: () => [],
  },
};

export interface SavedAgent {
  id: string;
  name: string;
  kind: AgentKind;
  /** Overrides the kind's own command — a wrapper, or a CLI not on PATH.
   * The whole command line for `custom`. */
  command: string;
  model: string;
  /** One of the kind's `efforts`, or empty for the CLI's own default. */
  effort: string;
  /** Anything else, appended as typed. */
  extraArgs: string;
}

export interface AgentSettings {
  agents: SavedAgent[];
  /** The one New session (and its shortcut) starts. */
  defaultId: string;
}

/** Quotes a word for a POSIX shell only when it needs it, so the command the
 * user sees in the terminal reads the way they would have typed it. */
export function shellWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The command line typed into the new session's shell. */
export function agentCommand(agent: SavedAgent): string {
  const kind = AGENT_KINDS[agent.kind];
  const base = agent.command.trim() || kind.command;
  const effort = kind.efforts.includes(agent.effort) ? agent.effort : "";
  const flags = kind.flags(agent.model.trim(), effort).map(shellWord);
  return [base, ...flags, agent.extraArgs.trim()].filter(Boolean).join(" ");
}

/** The shim arguments that start `agent` in a new session; `null` asks for
 * a plain shell. */
export function newSessionArgs(agent: SavedAgent | null): string[] {
  if (!agent) return ["new", "--shell"];
  const command = agentCommand(agent);
  return command ? ["new", "--agent", command] : ["new"];
}

export function blankAgent(kind: AgentKind = "claude"): SavedAgent {
  return {
    id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: AGENT_KINDS[kind].label,
    kind,
    command: "",
    model: "",
    effort: "",
    extraArgs: "",
  };
}

/** One of each, as each CLI starts on its own: what there is before the
 * user has saved anything. */
export function defaultAgentSettings(): AgentSettings {
  const agents = (["claude", "codex", "junie", "gemini", "pi"] as const).map((kind) => ({
    ...blankAgent(kind),
    id: kind,
  }));
  return { agents, defaultId: "claude" };
}

const STORAGE_KEY = "roer:agents";

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AgentSettings;
      const agents = parsed.agents.filter((agent) => agent.kind in AGENT_KINDS);
      if (agents.length > 0) {
        const defaultId = agents.some((agent) => agent.id === parsed.defaultId)
          ? parsed.defaultId
          : agents[0].id;
        return { agents, defaultId };
      }
    }
  } catch {
    // A corrupt entry is treated as none: the defaults below replace it on
    // the next save.
  }
  return defaultAgentSettings();
}

export function saveAgentSettings(settings: AgentSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function defaultAgent(settings: AgentSettings): SavedAgent {
  return settings.agents.find((agent) => agent.id === settings.defaultId) ?? settings.agents[0];
}
