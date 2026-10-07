import { useState } from "react";

import { applyClaudeSetup, dismissClaudeSetup, type SetupStatus } from "./lib/claudeSetup";
import { isMac } from "./lib/keys";

export interface ClaudeSetupProps {
  status: SetupStatus;
  /** Put by the app itself on first launch, rather than asked for from the
   * menu: available integrations start ticked, and declining is "Not now". */
  firstRun: boolean;
  onClose: () => void;
}

/** Roer's agent integrations, each with its own install state and control. */
export function ClaudeSetup({ status, firstRun, onClose }: ClaudeSetupProps) {
  const [skills, setSkills] = useState((firstRun && status.claudeCode) || status.skills);
  const [sharedSkills, setSharedSkills] = useState(firstRun || status.sharedSkills);
  const [mcp, setMcp] = useState((firstRun && status.claudeCode) || status.mcp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = firstRun || skills !== status.skills || sharedSkills !== status.sharedSkills || mcp !== status.mcp;

  const apply = () => {
    setBusy(true);
    setError(null);
    applyClaudeSetup(skills, sharedSkills, mcp)
      .then(onClose)
      .catch((cause: unknown) => {
        setError(String(cause));
        setBusy(false);
      });
  };

  const decline = () => {
    if (!firstRun) {
      onClose();
      return;
    }
    // Nothing to undo if this fails: it only stops the question coming back.
    void dismissClaudeSetup().catch(() => undefined).finally(onClose);
  };

  return (
    <div className="popup-scrim">
      <div
        className="popup setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-setup-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) decline();
        }}
      >
        <h2 id="agent-setup-title">Agent Integrations</h2>
        <p>
          Choose which Roer integrations to make available to your coding agents.
          {isMac() ? <> Change these later from <strong>Roer › Agent Integrations…</strong>.</> : null}
        </p>

        <label className="setup-option">
          <input
            type="checkbox"
            checked={sharedSkills}
            disabled={busy}
            onChange={(event) => setSharedSkills(event.target.checked)}
          />
          <span>
            <strong>Roer authoring guidance for Codex, Pi and Junie</strong>
            <span className="muted">
              Helps them recognize requests for Roer tabs, read the extension API, and keep drafts outside
              the project. Linked into <code>~/.agents/skills/roer-extension-authoring</code>, which all three read.
            </span>
          </span>
        </label>

        {!status.claudeCode ? <p className="muted">Claude Code was not found; its options are unavailable.</p> : null}

        <label className="setup-option">
          <input
            type="checkbox"
            checked={skills}
            disabled={busy || !status.claudeCode}
            onChange={(event) => setSkills(event.target.checked)}
          />
          <span>
            <strong>Claude Code skills</strong>
            <span className="muted">
              Adds <code>/roer-handoff</code> and extension authoring to <code>~/.claude/skills</code>.
            </span>
          </span>
        </label>

        <label className="setup-option">
          <input
            type="checkbox"
            checked={mcp}
            disabled={busy || !status.claudeCode}
            onChange={(event) => setMcp(event.target.checked)}
          />
          <span>
            <strong>Roer's MCP server for Claude Code</strong>
            <span className="muted">
              Lets Claude Code in a Roer session show interactive UI in the session's Generative UI panel
              and read your clicks back. Added as <code>roer</code> to your user-level MCP servers with{" "}
              <code>claude mcp add-json --scope user</code>. In a terminal outside Roer it offers no tools
              and adds nothing to Claude's context.
            </span>
          </span>
        </label>

        <p className="muted">New agent sessions pick up these changes; ones already running do not.</p>

        {error ? <p className="setup-error">{error}</p> : null}

        <div className="setup-actions">
          <button type="button" onClick={decline} disabled={busy}>
            {firstRun ? "Not now" : "Cancel"}
          </button>
          <button
            type="button"
            className="primary"
            onClick={apply}
            disabled={busy || !changed}
            autoFocus
          >
            {busy ? "Working…" : firstRun ? "Set up" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
