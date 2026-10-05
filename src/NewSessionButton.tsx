import { ChevronDown } from "lucide-react";
import { useRef } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentDetail, canStart, type Agent, type AgentList } from "./lib/agents";
import { shortcutLabel } from "./lib/keys";
import { SHELL, type SessionBrowserState } from "./lib/useSessionBrowser";

export type NewSessionButtonProps = Pick<SessionBrowserState, "openNew"> & {
  /** What the picker offers; null until first read. */
  agents?: AgentList | null;
  /** Why `agents` could not be read, when it could not. */
  agentsError?: string | null;
  /** Whether the agent picker is open, held by the caller so a shortcut can
   * open it too. */
  pickerOpen?: boolean;
  onPickerOpenChange?: (open: boolean) => void;
  onNewAgent?: () => void;
  onManageAgents?: () => void;
  /** The New session picker from where: any checkout, or a new worktree. */
  onNewSessionDialog?: () => void;
  /** Where the button starts a session, as its tooltip says. */
  place?: string;
};

/**
 * Lives on the stage's own tab bar rather than the sidebar: a new session
 * always lands under whatever Project or Workspace is selected there, so the
 * control that starts one belongs with the sessions it produces, not with the
 * picker that chose the context.
 *
 * Split in two: the button starts the default agent, as it always has, and
 * the chevron beside it picks another one — a saved agent, a CLI as it comes,
 * or just a shell — or opens the New session dialog for the rest. Where the
 * button cannot know which Project, it opens that dialog itself.
 */
export function NewSessionButton({
  openNew,
  agents,
  agentsError,
  pickerOpen,
  onPickerOpenChange,
  onNewAgent,
  onManageAgents,
  onNewSessionDialog,
  place,
}: NewSessionButtonProps) {
  const defaultAgent = agents?.agents.find((agent) => agent.id === agents.default);
  // Set when an item opens a popup of its own: the menu then leaves the
  // keyboard with it, rather than handing it back to the chevron.
  const handedOffRef = useRef(false);

  return (
    <span className="split-button new-session">
      <button
        type="button"
        className="primary"
        title={`New session${defaultAgent ? ` with ${defaultAgent.name}` : ""}${place ? ` in ${place}` : ""} (${shortcutLabel.newSession()})`}
        onClick={() => openNew()}
      >
        New session <span className="hotkey">{shortcutLabel.newSession()}</span>
      </button>

      <DropdownMenu open={pickerOpen} onOpenChange={onPickerOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="primary chevron"
            aria-label="Start a session with…"
            title={`Start a session with… (${shortcutLabel.pickAgent()})`}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="agent-picker"
          onCloseAutoFocus={(event) => {
            if (!handedOffRef.current) return;
            handedOffRef.current = false;
            event.preventDefault();
          }}
        >
          <AgentPickerItems agents={agents} error={agentsError} openNew={openNew} />
          <DropdownMenuSeparator />
          {onNewSessionDialog ? (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  handedOffRef.current = true;
                  onNewSessionDialog();
                }}
              >
                Somewhere else, or a new worktree… <span className="hotkey">{shortcutLabel.newWorktree()}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => onNewAgent?.()}>New agent…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onManageAgents?.()}>
            Manage agents… <span className="hotkey">{shortcutLabel.agents()}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/**
 * The default first, then the project's agents, the person's own, and every
 * installed CLI as it comes. A saved agent whose CLI is missing is shown but
 * cannot be picked, so it is clear why it did not start.
 */
function AgentPickerItems({
  agents,
  error,
  openNew,
}: {
  agents: AgentList | null | undefined;
  error?: string | null;
  openNew: NewSessionButtonProps["openNew"];
}) {
  // A failure is the answer, not a wait: say so, in its first line — an
  // old `roer` answers an unknown command with its whole usage text.
  if (!agents && error) {
    return (
      <DropdownMenuLabel className="error" title={error}>
        Could not list agents: {error.split("\n")[0]}
      </DropdownMenuLabel>
    );
  }
  if (!agents) {
    return <DropdownMenuLabel className="muted">Looking for agents…</DropdownMenuLabel>;
  }
  const visible = agents.agents.filter((agent) => agent.source !== "builtin" || canStart(agents, agent));
  const first = visible.find((agent) => agent.id === agents.default);
  const rest = visible.filter((agent) => agent !== first);
  const groups: [string, Agent[]][] = [
    ["Project", rest.filter((agent) => agent.source === "project")],
    ["My agents", rest.filter((agent) => agent.source === "user")],
    ["CLIs", rest.filter((agent) => agent.source === "builtin")],
  ];

  const item = (agent: Agent) => {
    const ready = canStart(agents, agent);
    return (
      <DropdownMenuItem
        key={`${agent.source}-${agent.id}`}
        disabled={!ready}
        onSelect={() => openNew(agent.id)}
        className="agent-item"
      >
        <span className="agent-item-name">{agent.name}</span>
        {agent.id === agents.default ? <span className="badge here">default</span> : null}
        <span className="muted agent-item-detail">
          {ready ? (agent.source === "builtin" ? "" : agentDetail(agent)) : `${agent.cli} not installed`}
        </span>
      </DropdownMenuItem>
    );
  };

  return (
    <>
      {first ? item(first) : null}
      {groups.map(([label, list]) =>
        list.length > 0 ? (
          <div key={label} role="group" aria-label={label}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="muted agent-group">{label}</DropdownMenuLabel>
            {list.map(item)}
          </div>
        ) : null,
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => openNew(SHELL)} className="agent-item">
        <span className="agent-item-name">Shell</span>
        <span className="muted agent-item-detail">no agent</span>
      </DropdownMenuItem>
    </>
  );
}
