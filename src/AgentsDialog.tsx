import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentCommand,
  agentDetail,
  agentModels,
  blankAgent,
  canStart,
  cliOf,
  removeAgent,
  saveAgent,
  setDefaultAgent,
  type Agent,
  type AgentList,
  type AgentScope,
} from "./lib/agents";

/** What the dialog opens on: a new agent, or an existing one by id. */
export type AgentsDialogStart = { mode: "new"; cli?: string } | { mode: "edit"; id?: string };

export interface AgentsDialogProps {
  list: AgentList;
  /** The directory whose project's agents are shown and shared into. */
  cwd?: string;
  start: AgentsDialogStart;
  /** Opened from the New session picker: saving also starts the agent. */
  startAfterSave?: boolean;
  onChanged: () => Promise<AgentList | void>;
  onStart: (id: string) => void;
  onClose: () => void;
}

const EFFORT_LABELS: Record<string, string> = { xhigh: "x-high" };
const PERMISSION_LABELS: Record<string, [string, string]> = {
  ask: ["Ask", "asks before it edits or runs anything"],
  auto: ["Auto", "decides for itself what is safe to do unasked"],
  full: ["Full", "does anything without asking"],
};

/**
 * Roer › Agents…: every agent a session can start, and a form for the one
 * picked. What it saves is a Markdown file, the same one `roer agents` and a
 * text editor see; the line at the bottom is exactly what the agent will
 * type into its session, so nothing about it is hidden.
 */
export function AgentsDialog({ list, cwd, start, startAfterSave, onChanged, onStart, onClose }: AgentsDialogProps) {
  const firstInstalled = list.clis.find((cli) => cli.installed)?.id ?? "claude";
  const initial = (): Agent => {
    if (start.mode === "new") return blankAgent(start.cli ?? list.agents.find((a) => a.id === list.default)?.cli ?? firstInstalled);
    return list.agents.find((agent) => agent.id === (start.id ?? list.default)) ?? list.agents[0];
  };
  const [selected, setSelected] = useState<Agent>(initial);
  const [draft, setDraft] = useState<Agent>(initial);
  const [scope, setScope] = useState<AgentScope>(initial().source === "project" ? "project" : "user");
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Held as typed: splitting on every keystroke would eat the space before
  // the next word, and a line with no `=` yet.
  const [argsText, setArgsText] = useState(() => joinArgs(initial().args));
  const [envText, setEnvText] = useState(() => envToText(initial().env));

  const isNew = draft.source === "builtin" ? false : !selected.path;
  const readOnly = draft.source === "builtin";
  const cli = cliOf(list, draft);

  const pick = (agent: Agent) => {
    setSelected(agent);
    setDraft(agent);
    setArgsText(joinArgs(agent.args));
    setEnvText(envToText(agent.env));
    setScope(agent.source === "project" ? "project" : "user");
    setMakeDefault(false);
    setError(null);
  };

  const startNew = (from?: Agent) => {
    const fresh = from
      ? { ...from, id: "", name: from.source === "builtin" ? "" : `${from.name} copy`, source: "user" as const, path: "" }
      : blankAgent(firstInstalled);
    setSelected(blankAgent(fresh.cli));
    setDraft(fresh);
    setArgsText(joinArgs(fresh.args));
    setEnvText(envToText(fresh.env));
    setScope(from?.source === "project" ? "project" : "user");
    setMakeDefault(false);
    setError(null);
    requestAnimationFrame(() => nameRef.current?.focus());
  };

  useEffect(() => {
    if (start.mode === "new") nameRef.current?.focus();
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What is saved: instructions a CLI cannot take stay in the form, greyed,
  // in case the CLI is switched back, but are not written.
  const effective = useMemo(
    () => (cli && !cli.instructions ? { ...draft, instructions: "" } : draft),
    [cli, draft],
  );

  // The line this agent will type, asked of the shim as the form changes.
  const [preview, setPreview] = useState<{ line?: string; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      agentCommand(effective)
        .then((line) => !cancelled && setPreview({ line }))
        .catch((cause: unknown) => !cancelled && setPreview({ error: String(cause) }));
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [effective]);

  // Model suggestions: the CLI's own list where it has one.
  const [models, setModels] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!cli || models[cli.id]) return;
    let cancelled = false;
    void agentModels(cli.id)
      .then((found) => !cancelled && setModels((current) => ({ ...current, [cli.id]: found })))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cli, models]);
  const suggestions = cli ? (models[cli.id] ?? cli.models) : [];

  const update = (change: Partial<Agent>) => setDraft((current) => ({ ...current, ...change }));

  // A new CLI keeps only what it can take.
  const changeCli = (id: string) => {
    const next = list.clis.find((candidate) => candidate.id === id);
    setDraft((current) => ({
      ...current,
      cli: id,
      model: "",
      effort: next?.efforts.includes(current.effort) ? current.effort : "",
      permissions: next?.permissions.includes(current.permissions) ? current.permissions : "",
    }));
  };

  const moved = !isNew && scope !== selected.source;
  const dirty = JSON.stringify(draft) !== JSON.stringify(selected) || makeDefault || moved;
  const valid = draft.name.trim() !== "" && !preview.error;
  const canSave = valid && (dirty || isNew);
  const canSaveAndStart = valid && canStart(list, draft);

  const save = async (andStart: boolean) => {
    if (!dirty && !isNew) {
      if (andStart) {
        onStart(selected.id);
        onClose();
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A rename is a new file: the id follows the name unless it was set.
      const renamed = !isNew && draft.name !== selected.name;
      const toSave = { ...effective, id: renamed || isNew ? "" : draft.id };
      const saved = await saveAgent(cwd, toSave, scope, isNew ? undefined : selected.path);
      if (makeDefault || (list.default === selected.id && saved.id !== selected.id && !isNew)) {
        await setDefaultAgent(cwd, saved.id, "user");
      }
      const refreshed = await onChanged();
      if (andStart) {
        onStart(saved.id);
        onClose();
        return;
      }
      const fresh = refreshed?.agents.find((agent) => agent.id === saved.id) ?? saved;
      pick(fresh);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isNew || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await removeAgent(cwd, selected.id, selected.source as AgentScope);
      const refreshed = await onChanged();
      const next = refreshed?.agents.find((agent) => agent.id === refreshed.default) ?? list.agents[0];
      pick(next);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const makeBuiltinDefault = async () => {
    setBusy(true);
    try {
      await setDefaultAgent(cwd, draft.id, "user");
      await onChanged();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    const saved = list.agents.filter((agent) => agent.source !== "builtin");
    return [
      ["Project", saved.filter((agent) => agent.source === "project")],
      ["My agents", saved.filter((agent) => agent.source === "user")],
      ["CLIs", list.agents.filter((agent) => agent.source === "builtin")],
    ] as [string, Agent[]][];
  }, [list]);

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div
        className="popup agents"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agents-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && dirty && !readOnly && !busy) {
            void save(Boolean(startAfterSave));
          }
        }}
      >
        <nav className="agents-list" aria-label="Agents">
          <div className="agents-list-head">
            <h2 id="agents-title">Agents</h2>
            <button type="button" className="link" onClick={() => startNew()}>
              + New
            </button>
          </div>
          {isNew ? (
            <ul>
              <li>
                <button type="button" className="agent-row on">
                  <strong>{draft.name || "New agent"}</strong>
                  <span className="muted">{agentDetail(draft)}</span>
                </button>
              </li>
            </ul>
          ) : null}
          {groups.map(([label, agents]) =>
            agents.length > 0 ? (
              <section key={label}>
                <h3 className="muted">{label}</h3>
                <ul>
                  {agents.map((agent) => (
                    <li key={`${agent.source}-${agent.id}`}>
                      <button
                        type="button"
                        className={!isNew && agent.id === selected.id && agent.source === selected.source ? "agent-row on" : "agent-row"}
                        onClick={() => pick(agent)}
                      >
                        <strong>
                          {agent.name}
                          {agent.id === list.default ? <span className="badge here">default</span> : null}
                        </strong>
                        <span className="muted">
                          {canStart(list, agent)
                            ? agent.source === "builtin"
                              ? "as installed"
                              : agentDetail(agent)
                            : `${agent.cli} not installed`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
        </nav>

        <form
          className="agents-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(Boolean(startAfterSave));
          }}
        >
          {readOnly ? (
            <div className="agents-builtin">
              <h2>{draft.name}</h2>
              <p className="muted">
                {cli?.installed
                  ? `${cli.label} as it starts on its own: its default model, reasoning and permissions, or whatever you have configured for it.`
                  : `${cli?.label ?? draft.cli} was not found on this machine. Install it and it appears in New session.`}
              </p>
              <div className="setup-actions start">
                <button type="button" className="primary" onClick={() => startNew(draft)}>
                  Customize…
                </button>
                {list.default !== draft.id ? (
                  <button type="button" onClick={() => void makeBuiltinDefault()} disabled={busy || !cli?.installed}>
                    Make default
                  </button>
                ) : (
                  <span className="muted">The default for New session</span>
                )}
              </div>
            </div>
          ) : (
            <>
              <Field label="CLI">
                <div className="segmented wrap" role="radiogroup" aria-label="CLI">
                  {list.clis.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      role="radio"
                      aria-checked={draft.cli === candidate.id}
                      className={draft.cli === candidate.id ? "on" : ""}
                      title={candidate.installed ? candidate.bin : `${candidate.bin} is not installed`}
                      onClick={() => changeCli(candidate.id)}
                    >
                      {candidate.label}
                      {candidate.installed ? null : <span className="muted"> ·  missing</span>}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.cli === "custom"}
                    className={draft.cli === "custom" ? "on" : ""}
                    onClick={() => changeCli("custom")}
                  >
                    Custom…
                  </button>
                </div>
              </Field>

              <Field label="Name">
                <input
                  ref={nameRef}
                  value={draft.name}
                  placeholder={cli ? `${cli.label} reviewer` : "My agent"}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>

              <Field label="Description">
                <input
                  value={draft.description}
                  placeholder="What it is for, shown in the picker"
                  onChange={(event) => update({ description: event.target.value })}
                />
              </Field>

              {draft.cli === "custom" ? (
                <Field label="Command" hint="Typed into the session's shell as it is.">
                  <input
                    className="mono"
                    value={draft.command}
                    placeholder="aider --model sonnet"
                    onChange={(event) => update({ command: event.target.value })}
                  />
                </Field>
              ) : (
                <>
                  <Field label="Model" hint={draft.model ? undefined : "Empty: the CLI's own default."}>
                    <input
                      className="mono"
                      list="agent-models"
                      value={draft.model}
                      placeholder={suggestions[0] ?? "default"}
                      onChange={(event) => update({ model: event.target.value })}
                    />
                    <datalist id="agent-models">
                      {suggestions.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </Field>

                  <Field label="Reasoning">
                    {cli && cli.efforts.length > 0 ? (
                      <Segmented
                        label="Reasoning"
                        value={draft.effort}
                        options={[["", "Default"], ...cli.efforts.map((e): [string, string] => [e, EFFORT_LABELS[e] ?? e])]}
                        onChange={(effort) => update({ effort })}
                      />
                    ) : (
                      <span className="muted">{cli?.label ?? draft.cli} has no reasoning setting.</span>
                    )}
                  </Field>

                  <Field
                    label="Permissions"
                    hint={draft.permissions ? `${cli?.label} ${PERMISSION_LABELS[draft.permissions]?.[1]}.` : undefined}
                  >
                    {cli && cli.permissions.length > 0 ? (
                      <Segmented
                        label="Permissions"
                        value={draft.permissions}
                        options={[["", "Default"], ...cli.permissions.map((p): [string, string] => [p, PERMISSION_LABELS[p]?.[0] ?? p])]}
                        onChange={(permissions) => update({ permissions })}
                      />
                    ) : (
                      <span className="muted">{cli?.label ?? draft.cli} has no permission setting.</span>
                    )}
                  </Field>

                  <Field
                    label="Instructions"
                    hint={
                      cli?.instructions
                        ? "Added to the agent's system prompt."
                        : `${cli?.label ?? draft.cli} takes no extra instructions from the command line.`
                    }
                  >
                    <textarea
                      rows={4}
                      value={draft.instructions}
                      disabled={!cli?.instructions}
                      placeholder={cli?.instructions ? "Review the diff. Report bugs first, style last." : ""}
                      onChange={(event) => update({ instructions: event.target.value })}
                    />
                  </Field>
                </>
              )}

              <details className="agents-advanced" open={draft.args.length > 0 || Object.keys(draft.env).length > 0}>
                <summary>Advanced</summary>
                <Field label="Extra arguments" hint="Added after everything else, as typed.">
                  <input
                    className="mono"
                    value={argsText}
                    placeholder="--search"
                    onChange={(event) => {
                      setArgsText(event.target.value);
                      update({ args: splitArgs(event.target.value) });
                    }}
                  />
                </Field>
                <Field label="Environment" hint="One NAME=value per line.">
                  <textarea
                    className="mono"
                    rows={2}
                    value={envText}
                    placeholder="CODEX_HOME=~/.codex-work"
                    onChange={(event) => {
                      setEnvText(event.target.value);
                      update({ env: parseEnv(event.target.value) });
                    }}
                  />
                </Field>
              </details>

              <div className="agents-preview" aria-live="polite">
                <span className="muted">Will run</span>
                {preview.error ? (
                  <code className="setup-error">{preview.error}</code>
                ) : (
                  <code>{preview.line ?? "…"}</code>
                )}
              </div>

              <div className="agents-save-row">
                <div className="segmented" role="radiogroup" aria-label="Save for">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === "user"}
                    className={scope === "user" ? "on" : ""}
                    onClick={() => setScope("user")}
                    title="~/.roer/agents"
                  >
                    Just me
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === "project"}
                    className={scope === "project" ? "on" : ""}
                    disabled={!list.project}
                    onClick={() => setScope("project")}
                    title={list.project ? "<project>/.roer/agents, to commit and share" : "No project here to share it in"}
                  >
                    This project
                  </button>
                </div>
                {list.default === draft.id && !isNew ? (
                  <span className="muted">Default for New session</span>
                ) : (
                  <label className="agents-default">
                    <input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
                    Make default
                  </label>
                )}
              </div>
              {moved ? <p className="muted">Saving moves the file to {scope === "project" ? "the project" : "your agents"}.</p> : null}
              {!isNew && selected.path ? <p className="muted agents-path">{selected.path}</p> : null}

              {error ? <p className="setup-error">{error}</p> : null}

              <div className="setup-actions">
                {!isNew ? (
                  <>
                    <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
                      Delete
                    </button>
                    <button type="button" onClick={() => startNew(draft)} disabled={busy}>
                      Duplicate
                    </button>
                    <span className="spacer" />
                  </>
                ) : (
                  <span className="spacer" />
                )}
                <button type="button" onClick={onClose} disabled={busy}>
                  {dirty ? "Cancel" : "Close"}
                </button>
                {/* Whichever of the two the dialog was not opened for. */}
                {startAfterSave ? (
                  <button type="button" onClick={() => void save(false)} disabled={busy || !canSave}>
                    Save
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void save(true)}
                    disabled={busy || !canSaveAndStart}
                    title={canStart(list, draft) ? undefined : `${draft.cli} is not installed`}
                  >
                    {dirty || isNew ? "Save & start" : "Start"}
                  </button>
                )}
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || (startAfterSave ? !canSaveAndStart : !canSave)}
                >
                  {busy ? "Saving…" : startAfterSave ? "Save & start" : "Save"}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="agents-field">
      <span className="agents-label">{label}</span>
      <span className="agents-control">
        {children}
        {hint ? <span className="muted agents-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option || "default"}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={value === option ? "on" : ""}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Words as a shell splits them, quotes kept together. */
export function splitArgs(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

export function joinArgs(args: string[]): string {
  return args.map((arg) => (/^[\w./=:@%+,-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "'")}"`)).join(" ");
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
}
