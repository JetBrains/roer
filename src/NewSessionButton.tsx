import { ChevronDownIcon, TerminalIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AGENT_KINDS,
  agentCommand,
  defaultAgent,
  newSessionArgs,
  type AgentSettings,
} from "./lib/agents";
import { pickFolder } from "./lib/folderPicker";
import { shortcutLabel } from "./lib/keys";
import type { Project } from "./lib/projects";
import type { SessionBrowserState } from "./lib/useSessionBrowser";

export type NewSessionButtonProps = Pick<
  SessionBrowserState,
  | "projects"
  | "openNew"
  | "pickingProjectFor"
  | "cancelProjectPick"
  | "pickProjectForNewSession"
  | "attachNewProjectForNewSession"
> & {
  agents: AgentSettings;
  /** Opens the dialog the saved agents are edited in. */
  manageAgents: () => void;
};

/**
 * Lives on the stage's own tab bar rather than the sidebar: a new session
 * always lands under whatever Project or Workspace is selected there, so the
 * control that starts one belongs with the sessions it produces, not with the
 * picker that chose the context.
 */
export function NewSessionButton({
  projects,
  openNew,
  pickingProjectFor,
  cancelProjectPick,
  pickProjectForNewSession,
  attachNewProjectForNewSession,
  agents,
  manageAgents,
}: NewSessionButtonProps) {
  const chosen = defaultAgent(agents);

  const pickedProjects = pickingProjectFor
    ? pickingProjectFor.projects
        .map((id) => projects.find((project) => project.id === id))
        .filter((project): project is Project => project != null)
    : [];

  const attachNewForPicker = async () => {
    const picked = await pickFolder();
    if (typeof picked === "string") {
      attachNewProjectForNewSession(picked);
    } else {
      // The dialog was dismissed — nothing was picked, so nothing else in
      // this flow will close the menu for us.
      cancelProjectPick();
    }
  };

  return (
    <div className="new-session-group">
    <DropdownMenu
      open={pickingProjectFor != null}
      onOpenChange={(next) => {
        if (!next) cancelProjectPick();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="primary new-session"
          title={`New session with ${chosen.name}: ${agentCommand(chosen)} (${shortcutLabel.newSession()})`}
          onClick={() => openNew(newSessionArgs(chosen))}
        >
          New session <span className="new-session-agent">{chosen.name}</span>
          <span className="hotkey">{shortcutLabel.newSession()}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {pickedProjects.map((project) => (
          <DropdownMenuItem key={project.id} onSelect={() => pickProjectForNewSession(project.path)}>
            {project.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onSelect={(event) => {
            // The dialog is async and the Workspace it's for only lives in
            // `pickingProjectFor` — letting Radix's default close through
            // here would clear it before the dialog resolves.
            event.preventDefault();
            void attachNewForPicker();
          }}
        >
          Attach a new project…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="primary new-session-more"
          aria-label="Choose an agent"
          title="Start another agent, or manage agents"
        >
          <ChevronDownIcon className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="agent-menu">
        <DropdownMenuLabel className="agent-menu-label">New session with</DropdownMenuLabel>
        {agents.agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => openNew(newSessionArgs(agent))}>
            <span className={`agent-badge agent-${agent.kind}`}>
              {AGENT_KINDS[agent.kind].badge}
            </span>
            <span className="agent-menu-text">
              <span className="agent-menu-name">
                {agent.name}
                {agent.id === agents.defaultId ? (
                  <span className="agent-default">default</span>
                ) : null}
              </span>
              <code className="agent-menu-command">{agentCommand(agent) || "—"}</code>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openNew(newSessionArgs(null))}>
          <span className="agent-badge agent-shell">
            <TerminalIcon className="size-3" />
          </span>
          <span className="agent-menu-text">
            <span className="agent-menu-name">Shell only</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={manageAgents}>Manage agents…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
  );
}
