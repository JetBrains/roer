import { useState } from "react";

import { applyClaudeSetup, dismissClaudeSetup, type SetupStatus } from "./lib/claudeSetup";
import { isMac } from "./lib/keys";

export interface ClaudeSetupProps {
  status: SetupStatus;
  /** Put by the app itself on first launch, rather than asked for from the
   * menu: both parts start ticked, and declining is "Not now". */
  firstRun: boolean;
  onClose: () => void;
}

/**
 * What Roer would add to Claude Code, each part said plainly with where it
 * goes, and a tick for each. From the menu the ticks show what is set up now,
 * so unticking one is how it is taken back.
 */
export function ClaudeSetup({ status, firstRun, onClose }: ClaudeSetupProps) {
  const [skills, setSkills] = useState(firstRun || status.skills);
  const [mcp, setMcp] = useState(firstRun || status.mcp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = firstRun || skills !== status.skills || mcp !== status.mcp;

  const apply = () => {
    setBusy(true);
    setError(null);
    applyClaudeSetup(skills, mcp)
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
        aria-labelledby="claude-setup-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) decline();
        }}
      >
        <h2 id="claude-setup-title">Use Roer from Claude Code</h2>

        {!status.claudeCode ? (
          <>
            <p>
              Claude Code was not found on this computer, so there is nothing to set up.{" "}
              {isMac() ? (
                <>
                  Once it is installed, choose <strong>Roer › Claude Code Integration…</strong> to
                  come back here.
                </>
              ) : (
                <>
                  Once it is installed, <code>roer skills install --agent claude</code> and{" "}
                  <code>roer mcp install</code> set it up.
                </>
              )}
            </p>
            <div className="setup-actions">
              <button type="button" className="primary" onClick={onClose} autoFocus>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Roer can add two things to Claude Code for your user account. Nothing else on this
              computer changes, and you can remove either one later
              {isMac() ? (
                <>
                  {" "}
                  from <strong>Roer › Claude Code Integration…</strong>
                </>
              ) : (
                <>
                  {" "}
                  with <code>roer skills uninstall --agent claude</code> and <code>roer mcp uninstall</code>.
                </>
              )}
            </p>

            <label className="setup-option">
              <input
                type="checkbox"
                checked={skills}
                disabled={busy}
                onChange={(event) => setSkills(event.target.checked)}
              />
              <span>
                <strong>
                  The <code>/roer-handoff</code> skill
                </strong>
                <span className="muted">
                  Lets a Claude Code session in any terminal move itself into Roer when you ask it
                  to, for example "open this in Roer". Linked into{" "}
                  <code>~/.claude/skills/roer-handoff</code>.
                </span>
              </span>
            </label>

            <label className="setup-option">
              <input
                type="checkbox"
                checked={mcp}
                disabled={busy}
                onChange={(event) => setMcp(event.target.checked)}
              />
              <span>
                <strong>Roer's MCP server</strong>
                <span className="muted">
                  Lets Claude Code in a Roer session show interactive UI in the session's
                  Generative UI panel and read your clicks back. Added as <code>roer</code> to
                  your user-level MCP servers with <code>claude mcp add-json --scope user</code>.
                  In a terminal outside Roer it offers no tools and adds nothing to Claude's
                  context.
                </span>
              </span>
            </label>

            <p className="muted">
              New Claude Code sessions pick up the change; ones already running do not.
            </p>

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
          </>
        )}
      </div>
    </div>
  );
}
