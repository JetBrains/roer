import { useEffect, useRef, useState } from "react";

import type { AgentState, AskAgent } from "./lib/askAgent";

/** Tabs worth having in most repositories, to show what a tab can be. */
export const TAB_IDEAS: readonly string[] = [
  "my open pull requests and their checks",
  "the TODO and FIXME comments in this repo, by file",
  "this branch's commits since main",
  "the GitHub issues assigned to me",
];

/** Sections worth having on the Workspace tab, about all of its projects. */
export const SECTION_IDEAS: readonly string[] = [
  "each project's open pull requests and their checks",
  "each project's branch and what is not committed",
  "the CI status of each project's main branch",
  "the GitHub issues assigned to me across these projects",
];

/** What "New tab…" asks the agent, for a tab that shows `what`. */
export function newTabPrompt(what: string): string {
  return [
    `Make me a Roer extension tab that shows ${what}.`,
    "Use the roer-extension-authoring skill and build it from roer/ui.",
    "Ask me where its data comes from if that is not clear. Load it with extension_dev for me to try, and ask me before you install it.",
  ].join(" ");
}

/** What "Add a section…" asks the agent, for a Workspace tab section that shows `what`. */
export function newSectionPrompt(what: string): string {
  return [
    `Make me a Roer extension that adds a section to the Workspace tab showing ${what}.`,
    "Register it with roer.workspace.registerSection and read the workspace's projects with useScope().",
    "Use the roer-extension-authoring skill and build it from roer/ui; keep it short, since it sits in the list with my sessions.",
    "Ask me where its data comes from if that is not clear. Load it with extension_dev for me to try, and ask me before you install it.",
  ].join(" ");
}

/** What the dialog says and asks, for a tab or for a Workspace tab section. */
const KINDS = {
  tab: {
    title: "New tab",
    intro:
      "Say what you want to keep an eye on, and the session's agent writes a tab for it: an extension, code that runs in Roer with your permissions. It stays in the strip and fetches its own data. The agent loads it for you to try, and installs it only when you say so.",
    placeholder: "What should the tab show?",
    field: "What the tab shows",
    ideas: TAB_IDEAS,
    prompt: newTabPrompt,
    label: (what: string) => `a tab that shows ${what}`,
  },
  section: {
    title: "New section",
    intro:
      "Say what you want to see about this workspace's projects, and the session's agent writes a section of the Workspace tab for it: an extension, code that runs in Roer with your permissions. It shows after Projects, for every workspace and project, and fetches its own data. The agent loads it for you to try, and installs it only when you say so.",
    placeholder: "What should the section show?",
    field: "What the section shows",
    ideas: SECTION_IDEAS,
    prompt: newSectionPrompt,
    label: (what: string) => `a Workspace section that shows ${what}`,
  },
} as const;

/**
 * Asks the session's agent for a tab of the person's own: the way to an
 * extension for someone who never saw a view worth keeping. The agent may be
 * busy; then the request waits for it, held by `agent`, which outlives the
 * dialog.
 */
export function NewTabDialog({
  agent,
  agentState,
  kind = "tab",
  onClose,
}: {
  agent: AskAgent;
  agentState?: AgentState;
  /** A tab of the stage's strip, or a section of the Workspace tab. */
  kind?: keyof typeof KINDS;
  onClose: () => void;
}) {
  const asked = KINDS[kind];
  const ref = useRef<HTMLDivElement>(null);
  const [what, setWhat] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const back = document.activeElement;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const handleAsk = () => {
    const text = what.trim();
    if (!text) return;
    agent
      .ask(asked.prompt(text), asked.label(text))
      .then((outcome) => {
        if (outcome === "sent") onClose();
        else {
          setHeld(true);
          setStatus("Asked. The agent gets this as soon as it is waiting for you.");
        }
      })
      .catch((e: unknown) => {
        console.error(`roer: could not ask the agent for ${asked.label(text)}`, e);
        setStatus(`Could not ask the agent for a ${kind}.`);
      });
  };

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className="popup new-tab"
        role="dialog"
        aria-modal="true"
        aria-label={asked.title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2>{asked.title}</h2>
        {agent.held.length > 0 ? (
          <div className="new-tab-held" role="status">
            <p className="muted">
              {agentState === "done"
                ? "Waiting until you send or clear what is in your prompt:"
                : "Waiting for the agent to finish what it is doing:"}
            </p>
            <ul>
              {agent.held.map((request) => (
                <li key={request.text}>
                  <span>{request.label}</span>
                  <button
                    type="button"
                    className="gen-button"
                    onClick={() =>
                      void agent.sendNow(request.text).catch((e: unknown) => {
                        console.error("roer: could not send a held request to the agent", e);
                        setStatus("Could not ask the agent.");
                      })
                    }
                  >
                    Send now
                  </button>
                  <button type="button" className="gen-button borderless" onClick={() => agent.cancel(request.text)}>
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="muted">{asked.intro}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleAsk();
          }}
        >
          <textarea
            className="gen-bundles-input"
            aria-label={asked.field}
            placeholder={asked.placeholder}
            rows={3}
            autoFocus
            disabled={held}
            value={what}
            onChange={(event) => setWhat(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                handleAsk();
              }
            }}
          />
          <div className="new-tab-ideas" aria-label="Ideas">
            {asked.ideas.map((idea) => (
              <button key={idea} type="button" className="gen-button" disabled={held} onClick={() => setWhat(idea)}>
                {idea}
              </button>
            ))}
          </div>
          {status ? (
            <p className="muted" role="status">
              {status}
            </p>
          ) : !agent.canAsk ? (
            <p className="muted">No agent here to ask: start one in this session first.</p>
          ) : !agent.ready ? (
            <p className="muted">
              {agentState === "done"
                ? "Your prompt has text in it, so this waits until you send or clear it."
                : "The agent is busy, so this waits and goes to it when it is next waiting for you."}
            </p>
          ) : null}
          <div className="gen-row new-tab-actions">
            {held ? (
              <button type="button" className="gen-button primary" onClick={onClose}>
                Close
              </button>
            ) : (
              <>
                <button type="button" className="gen-button borderless" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="gen-button primary" disabled={!agent.canAsk || !what.trim()}>
                  {agent.canAsk && !agent.ready ? "Ask when it is ready" : "Ask the agent"}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
