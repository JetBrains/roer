import { useEffect, useRef, useState } from "react";

import type { AgentState, AskAgent } from "./lib/askAgent";

/** Tabs worth having in most repositories, to show what a tab can be. */
export const TAB_IDEAS: readonly string[] = [
  "my open pull requests and their checks",
  "the TODO and FIXME comments in this repo, by file",
  "this branch's commits since main",
  "the GitHub issues assigned to me",
];

/** What "New tab…" asks the agent, for a tab that shows `what`. */
export function newTabPrompt(what: string): string {
  return [
    `Make me a Roer extension tab that shows ${what}.`,
    "Use the roer-extension-authoring skill and build it from roer/ui.",
    "Ask me where its data comes from if that is not clear. Load it with extension_dev for me to try, and ask me before you install it.",
  ].join(" ");
}

/**
 * Asks the session's agent for a tab of the person's own: the way to an
 * extension for someone who never saw a view worth keeping. The agent may be
 * busy; then the request waits for it, held by `agent`, which outlives the
 * dialog.
 */
export function NewTabDialog({
  agent,
  agentState,
  onClose,
}: {
  agent: AskAgent;
  agentState?: AgentState;
  onClose: () => void;
}) {
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
      .ask(newTabPrompt(text), `a tab that shows ${text}`)
      .then((outcome) => {
        if (outcome === "sent") onClose();
        else {
          setHeld(true);
          setStatus("Asked. The agent gets this as soon as it is waiting for you.");
        }
      })
      .catch((e: unknown) => {
        console.error("roer: could not ask the agent for a tab", e);
        setStatus("Could not ask the agent for a tab.");
      });
  };

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className="popup new-tab"
        role="dialog"
        aria-modal="true"
        aria-label="New tab"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2>New tab</h2>
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
        <p className="muted">
          Say what you want to keep an eye on, and the session's agent writes a tab for it: an
          extension, code that runs in Roer with your permissions. It stays in the strip and fetches
          its own data. The agent loads it for you to try, and installs it only when you say so.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleAsk();
          }}
        >
          <textarea
            className="gen-bundles-input"
            aria-label="What the tab shows"
            placeholder="What should the tab show?"
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
            {TAB_IDEAS.map((idea) => (
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
