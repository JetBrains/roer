/**
 * Typed bridge to `agents.rs`, which asks `roer agents`: the agents a new
 * session can start. A saved agent is a Markdown file under
 * `~/.roer/agents` (just me) or `<project>/.roer/agents` (shared); every
 * installed CLI is an agent too, with nothing set.
 */
import { invoke, listen, type UnlistenFn } from "./backend";

export type AgentScope = "user" | "project";

export interface Agent {
  /** The file name without `.md`, which `roer new --agent` takes. Empty for
   * one not saved yet. */
  id: string;
  name: string;
  description: string;
  /** claude, codex, pi, junie or custom. */
  cli: string;
  /** Only for `cli: custom`. */
  command: string;
  model: string;
  effort: string;
  /** ask, auto, full, or empty for the CLI's own default. */
  permissions: string;
  args: string[];
  env: Record<string, string>;
  instructions: string;
  source: "builtin" | AgentScope;
  path: string;
}

export interface AgentCli {
  id: string;
  label: string;
  bin: string;
  installed: boolean;
  /** Offered in the model field; any other name can be typed. */
  models: string[];
  /** The effort levels it takes, weakest first; empty when it has none. */
  efforts: string[];
  /** The permission levels it takes; empty when it has no setting. */
  permissions: string[];
  instructions: boolean;
  resume: boolean;
}

export interface AgentList {
  agents: Agent[];
  clis: AgentCli[];
  /** The agent a plain New session starts. */
  default: string;
  defaults: { user: string | null; project: string | null };
  /** Whether there is a project to share agents in. */
  project: boolean;
}

export const listAgents = (cwd?: string): Promise<AgentList> => invoke("agents_list", { cwd });

export const saveAgent = (
  cwd: string | undefined,
  agent: Agent,
  scope: AgentScope,
  from?: string,
): Promise<Agent> => invoke("agent_save", { cwd, agent, scope, from });

export const removeAgent = (cwd: string | undefined, id: string, scope: AgentScope): Promise<void> =>
  invoke("agent_remove", { cwd, id, scope });

export const setDefaultAgent = (
  cwd: string | undefined,
  id: string | null,
  scope: AgentScope,
): Promise<void> => invoke("agent_set_default", { cwd, id, scope });

/** The line the agent would type into its session's shell. */
export const agentCommand = (agent: Agent): Promise<string> => invoke("agent_command", { agent });

export const agentModels = (cli: string): Promise<string[]> => invoke("agent_models", { cli });

/** Roer › Agents… was chosen. */
export const onAgentsMenu = (handler: () => void): Promise<UnlistenFn> =>
  listen("roer://agents", () => handler());

export const cliOf = (list: AgentList | null, agent: Agent): AgentCli | undefined =>
  list?.clis.find((cli) => cli.id === agent.cli);

/** Whether the agent's program is on this machine, so it can start. */
export const canStart = (list: AgentList | null, agent: Agent): boolean =>
  agent.cli === "custom" || cliOf(list, agent)?.installed === true;

/** "codex · gpt-5.5 · high": what an agent is, beside its name. */
export function agentDetail(agent: Agent): string {
  const parts = [agent.cli === "custom" ? agent.command : agent.cli, agent.model, agent.effort];
  return parts.filter((part) => part).join(" · ");
}

export const blankAgent = (cli: string): Agent => ({
  id: "",
  name: "",
  description: "",
  cli,
  command: "",
  model: "",
  effort: "",
  permissions: "",
  args: [],
  env: {},
  instructions: "",
  source: "user",
  path: "",
});
