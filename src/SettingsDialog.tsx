import { useEffect, useRef, useState } from "react";

import { setCommentsOn, useCommentsOn } from "./lib/experimental";
import { bindKey, resetKeybindings } from "./lib/keybindings";
import {
  ACTIONS,
  chordFrom,
  chordLabel,
  chordOf,
  fontSizeShortcuts,
  isCustom,
  refusal,
  setRecording,
  shortcutLabel,
  useKeymap,
  type ActionId,
} from "./lib/keys";

/**
 * Settings: every keyboard shortcut on one sheet, each one the person can
 * move to a key of their own (Change, then the keys), and the experimental
 * features, each with a switch. `tabs` are the strip's, in order; their
 * numbers are a pattern rather than one key, and stay put.
 */
export function SettingsDialog({ tabs = [], onClose }: { tabs?: readonly string[]; onClose: () => void }) {
  useKeymap();
  const ref = useRef<HTMLDivElement>(null);
  const [recording, setRecordingFor] = useState<ActionId | null>(null);
  const [problem, setProblem] = useState<{ action: ActionId; text: string } | null>(null);
  const commentsOn = useCommentsOn();
  const [experimentProblem, setExperimentProblem] = useState<string | null>(null);

  useEffect(() => {
    const back = document.activeElement;
    ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  // While one is being recorded, the next key is its: taken before anything
  // else hears it, every other shortcut held off meanwhile.
  useEffect(() => {
    if (!recording) return;
    setRecording(true);
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingFor(null);
        return;
      }
      const chord = chordFrom(event);
      if (!chord) return;
      const why = refusal(recording, chord);
      if (why) {
        setProblem({ action: recording, text: `${chordLabel(chord)}: ${why}` });
        return;
      }
      setProblem(null);
      setRecordingFor(null);
      bindKey(recording, chord).catch((cause: unknown) => setProblem({ action: recording, text: `Not kept: ${String(cause)}` }));
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      setRecording(false);
    };
  }, [recording]);

  const reset = (action: ActionId) => {
    setProblem(null);
    bindKey(action, null).catch((cause: unknown) => setProblem({ action, text: `Not kept: ${String(cause)}` }));
  };

  const row = (action: ActionId, name: string) => (
    <div key={action}>
      <dt>{name}</dt>
      <dd>
        <kbd className={recording === action ? "recording" : undefined}>
          {recording === action ? "Press keys…" : chordLabel(chordOf(action))}
        </kbd>
        <button
          type="button"
          className="link"
          aria-label={`Change the key for ${name}`}
          onClick={() => {
            setProblem(null);
            setRecordingFor(recording === action ? null : action);
          }}
        >
          {recording === action ? "Cancel" : "Change"}
        </button>
        {isCustom(action) && recording !== action ? (
          <button type="button" className="link" aria-label={`Put ${name} back on its own key`} onClick={() => reset(action)}>
            Reset
          </button>
        ) : null}
      </dd>
      {problem?.action === action ? <p className="shortcut-problem">{problem.text}</p> : null}
    </div>
  );

  const actions = new Map(ACTIONS);
  const before: ActionId[] = ["newSession", "pickAgent", "newWorktree", "goToFile", "nextWaiting", "previousSession"];
  const after: ActionId[] = ["closeTab", "agents", "prevCommit", "nextCommit", "prevComment", "nextComment", "shortcuts"];
  const anyCustom = ACTIONS.some(([action]) => isCustom(action));

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className="popup shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !recording) onClose();
        }}
      >
        <h2>Settings</h2>
        <h3>Keyboard shortcuts</h3>
        <dl>
          {before.map((action) => row(action, actions.get(action)!))}
          {tabs.slice(0, 9).map((tab, i) => (
            <div key={`tab-${tab}`}>
              <dt>{tab}</dt>
              <dd>
                <kbd>{shortcutLabel.tab(i + 1)}</kbd>
              </dd>
            </div>
          ))}
          {after.map((action) => row(action, actions.get(action)!))}
          {fontSizeShortcuts().map(([name, keys]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="muted shortcuts-foot">
          Kept in <code>~/.roer/keybindings.json</code>.{" "}
          {anyCustom ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                setProblem(null);
                void resetKeybindings();
              }}
            >
              Put every one back
            </button>
          ) : null}
        </p>
        <h3>Experimental</h3>
        <div className="setting">
          <div>
            <div>Comments and Needs you</div>
            <p className="muted">
              Comment on a file&apos;s lines or a view&apos;s parts for a session&apos;s agent, and see what agents
              wait on you at the top of the sidebar. Off, comments are kept, and come back when it is on again.
            </p>
            {experimentProblem ? <p className="shortcut-problem">{experimentProblem}</p> : null}
          </div>
          <label className="ext-switch" title={commentsOn ? "Switch off" : "Switch on"}>
            <input
              type="checkbox"
              role="switch"
              aria-label="Comments and Needs you"
              checked={commentsOn}
              onChange={(event) => {
                setExperimentProblem(null);
                setCommentsOn(event.target.checked).catch((cause: unknown) => setExperimentProblem(`Not kept: ${String(cause)}`));
              }}
            />
            <span aria-hidden="true" />
          </label>
        </div>
      </div>
    </div>
  );
}
