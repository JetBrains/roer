import { useState } from "react";

import {
  AGENT_KINDS,
  agentCommand,
  blankAgent,
  shellWord,
  type AgentKind,
  type AgentSettings,
  type SavedAgent,
} from "./lib/agents";

export interface AgentsDialogProps {
  settings: AgentSettings;
  onSave: (settings: AgentSettings) => void;
  onClose: () => void;
}

/**
 * The named agents New session offers: which CLI, with which model and how
 * much reasoning. Edited as a draft and saved as a whole, so Cancel leaves
 * the menu as it was.
 */
export function AgentsDialog({ settings, onSave, onClose }: AgentsDialogProps) {
  const [draft, setDraft] = useState(settings);
  const [selectedId, setSelectedId] = useState(settings.defaultId);
  const selected = draft.agents.find((agent) => agent.id === selectedId) ?? draft.agents[0];
  const kind = selected ? AGENT_KINDS[selected.kind] : null;

  const update = (patch: Partial<SavedAgent>) =>
    setDraft((current) => ({
      ...current,
      agents: current.agents.map((agent) =>
        agent.id === selected.id ? { ...agent, ...patch } : agent,
      ),
    }));

  const changeKind = (next: AgentKind) => {
    const wasDefaultName = selected.name === AGENT_KINDS[selected.kind].label;
    update({
      kind: next,
      // A name the user never changed follows the CLI it names.
      name: wasDefaultName ? AGENT_KINDS[next].label : selected.name,
      effort: AGENT_KINDS[next].efforts.includes(selected.effort) ? selected.effort : "",
    });
  };

  const add = () => {
    const agent = blankAgent();
    setDraft((current) => ({ ...current, agents: [...current.agents, agent] }));
    setSelectedId(agent.id);
  };

  const remove = () => {
    const agents = draft.agents.filter((agent) => agent.id !== selected.id);
    const defaultId = draft.defaultId === selected.id ? (agents[0]?.id ?? "") : draft.defaultId;
    setDraft({ agents, defaultId });
    setSelectedId(defaultId);
  };

  const command = selected ? agentCommand(selected) : "";
  const valid = draft.agents.every((agent) => agent.name.trim() && agentCommand(agent));

  return (
    <div className="popup-scrim">
      <div
        className="popup setup agents"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agents-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2 id="agents-title">Agents</h2>
        <p className="muted">
          New session starts the default agent; the menu beside it starts any other one. Each is
          typed into the new session's shell, so it runs with your full shell environment.
        </p>

        <div className="agents-body">
          <div className="agents-list" role="listbox" aria-label="Saved agents">
            {draft.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="option"
                aria-selected={agent.id === selected?.id}
                className={`agents-row${agent.id === selected?.id ? " selected" : ""}`}
                onClick={() => setSelectedId(agent.id)}
              >
                <span className={`agent-badge agent-${agent.kind}`}>
                  {AGENT_KINDS[agent.kind].badge}
                </span>
                <span className="agents-row-text">
                  <span className="agents-row-name">{agent.name || "Untitled"}</span>
                  <span className="agents-row-meta">
                    {[agent.model || AGENT_KINDS[agent.kind].label, agent.effort]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {agent.id === draft.defaultId ? <span className="agent-default">default</span> : null}
              </button>
            ))}
            <button type="button" className="agents-add" onClick={add}>
              + Add agent
            </button>
          </div>

          {selected && kind ? (
            <div className="agents-form">
              <label className="agents-field">
                <span>Name</span>
                <input
                  value={selected.name}
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder="Opus, thinking hard"
                />
              </label>

              <label className="agents-field">
                <span>Agent</span>
                <select
                  value={selected.kind}
                  onChange={(event) => changeKind(event.target.value as AgentKind)}
                >
                  {(Object.keys(AGENT_KINDS) as AgentKind[]).map((key) => (
                    <option key={key} value={key}>
                      {AGENT_KINDS[key].label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="agents-field">
                <span>Command</span>
                <input
                  value={selected.command}
                  onChange={(event) => update({ command: event.target.value })}
                  placeholder={kind.command || "my-agent --flag"}
                  spellCheck={false}
                />
              </label>

              {selected.kind !== "custom" ? (
                <label className="agents-field">
                  <span>Model</span>
                  <input
                    value={selected.model}
                    onChange={(event) => update({ model: event.target.value })}
                    placeholder={`CLI default — ${kind.modelHint}`}
                    spellCheck={false}
                  />
                </label>
              ) : null}

              {selected.kind !== "custom" ? (
                <div className="agents-field">
                  <span>Reasoning</span>
                  {kind.efforts.length > 0 ? (
                    <div className="segmented" role="radiogroup" aria-label="Reasoning">
                      {["", ...kind.efforts].map((effort) => (
                        <button
                          key={effort || "default"}
                          type="button"
                          role="radio"
                          aria-checked={selected.effort === effort}
                          className={selected.effort === effort ? "on" : ""}
                          onClick={() => update({ effort })}
                        >
                          {effort || "default"}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">{kind.label} has no reasoning flag.</span>
                  )}
                </div>
              ) : null}

              <label className="agents-field">
                <span>Extra flags</span>
                <input
                  value={selected.extraArgs}
                  onChange={(event) => update({ extraArgs: event.target.value })}
                  placeholder="--permission-mode plan"
                  spellCheck={false}
                />
              </label>

              <div className="agents-preview">
                <span className="muted">Runs</span>
                <code>
                  {command ? `roer new --agent ${shellWord(command)}` : "Needs a command"}
                </code>
              </div>

              <div className="agents-row-actions">
                <button
                  type="button"
                  disabled={draft.defaultId === selected.id}
                  onClick={() => setDraft((current) => ({ ...current, defaultId: selected.id }))}
                >
                  {draft.defaultId === selected.id ? "Default agent" : "Make default"}
                </button>
                <button type="button" disabled={draft.agents.length <= 1} onClick={remove}>
                  Delete
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="setup-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!valid}
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
