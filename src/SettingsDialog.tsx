import { useEffect, useRef, useState, type ComponentProps } from "react";

import { ExtensionsSettings } from "./ExtensionsSettings";
import { setCommentsOn, useCommentsOn } from "./lib/experimental";
import { allowHost, forgetHosts, setAlwaysShow, useRemoteMediaPrefs } from "./lib/remoteMedia";
import type { SettingsSection } from "./lib/settingsNav";
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

/** Settings' topics, in the order its column lists them. */
const TOPICS: { id: SettingsSection; title: string }[] = [
  { id: "keyboard", title: "Keyboard shortcuts" },
  { id: "threads", title: "Threads" },
  { id: "privacy", title: "Privacy" },
  { id: "extensions", title: "Extensions" },
];

/** Past this many hosts let through, the list gets a filter. */
const FILTER_FROM = 6;

/**
 * Settings, one topic at a time from the column on the left: every keyboard shortcut, each one the person can move to
 * a key of their own (Change, then the keys); threads, which are experimental; what loads from the web; and the
 * extensions, each with a switch. `tabs` are the strip's, in order; their numbers are a pattern rather than one key,
 * and stay put.
 */
export function SettingsDialog({
  tabs = [],
  section,
  extensions,
  onClose,
}: {
  tabs?: readonly string[];
  /** The topic to open at, e.g. Privacy from a picture's placeholder; Keyboard shortcuts otherwise. */
  section?: SettingsSection;
  /** What the Extensions topic needs of the app: where each tab is shown, and a new extension. */
  extensions?: ComponentProps<typeof ExtensionsSettings>;
  onClose: () => void;
}) {
  const [topic, setTopic] = useState<SettingsSection>(section ?? "keyboard");
  useEffect(() => {
    if (section) setTopic(section);
  }, [section]);
  const [hostFilter, setHostFilter] = useState("");
  useKeymap();
  const ref = useRef<HTMLDivElement>(null);
  const [recording, setRecordingFor] = useState<ActionId | null>(null);
  const [problem, setProblem] = useState<{ action: ActionId; text: string } | null>(null);
  const commentsOn = useCommentsOn();
  const [experimentProblem, setExperimentProblem] = useState<string | null>(null);
  const media = useRemoteMediaPrefs();

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
        className="popup shortcuts settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !recording) onClose();
        }}
      >
        <nav className="settings-nav" aria-label="Settings topics">
          <h2>Settings</h2>
          {TOPICS.map((one) => (
            <button
              key={one.id}
              type="button"
              className={topic === one.id ? "on" : undefined}
              aria-current={topic === one.id ? "page" : undefined}
              onClick={() => setTopic(one.id)}
            >
              {one.title}
            </button>
          ))}
        </nav>
        <section className={topic === "extensions" ? "settings-pane settings-pane-split" : "settings-pane"} aria-label={TOPICS.find((one) => one.id === topic)?.title}>
          <h3>{TOPICS.find((one) => one.id === topic)?.title}</h3>
          {topic === "keyboard" ? (
            <>
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
            </>
          ) : null}
          {topic === "threads" ? (
            <div className="setting">
              <div>
                <div>
                  Comments and Needs you <span className="settings-badge">Experimental</span>
                </div>
                <p className="muted">
                  Comment on a file&apos;s lines, a diff&apos;s or a view&apos;s parts for a session&apos;s agent, with
                  its answers under them, and see what agents wait on you at the top of the sidebar. Off, comments are
                  kept, and come back when it is on again.
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
          ) : null}
          {topic === "privacy" ? (
            <>
              <div className="setting">
                <div>
                  <div>Load pictures from the web without asking</div>
                  <p className="muted">
                    In threads, comments, pull requests, files under review and agents&apos; views. Off, each is a
                    placeholder until you press Show: an agent that read something hostile can be made to write a picture
                    whose address carries a secret out. Pictures in the text itself and GitHub&apos;s own always show.
                  </p>
                </div>
                <label className="ext-switch" title={media.always ? "Switch off" : "Switch on"}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Load pictures from the web without asking"
                    checked={media.always}
                    onChange={(event) => setAlwaysShow(event.target.checked)}
                  />
                  <span aria-hidden="true" />
                </label>
              </div>
              <div className="setting settings-hosts-block">
                <div className="settings-hosts-head">
                  <div>Loaded without asking</div>
                  <p className="muted">
                    {media.hosts.length === 0
                      ? "None yet: Always from a host, on a picture's placeholder, adds it here."
                      : `${media.hosts.length} ${media.hosts.length === 1 ? "host" : "hosts"}, added from pictures' placeholders.`}
                  </p>
                </div>
                {media.hosts.length > 0 ? (
                  <button type="button" className="link" onClick={() => forgetHosts()}>
                    Remove all
                  </button>
                ) : null}
              </div>
              {media.hosts.length >= FILTER_FROM ? (
                <input
                  className="settings-filter"
                  type="search"
                  aria-label="Filter hosts"
                  placeholder="Filter hosts"
                  value={hostFilter}
                  onChange={(event) => setHostFilter(event.target.value)}
                />
              ) : null}
              {media.hosts.length > 0 ? (
                <ul className="settings-hosts" aria-label="Hosts loaded without asking">
                  {media.hosts
                    .filter((host) => host.toLowerCase().includes(hostFilter.trim().toLowerCase()))
                    .map((host) => (
                      <li key={host}>
                        <code>{host}</code>
                        <button type="button" className="link" aria-label={`Ask again for ${host}`} onClick={() => allowHost(host, false)}>
                          Remove
                        </button>
                      </li>
                    ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {topic === "extensions" ? <ExtensionsSettings {...extensions} /> : null}
        </section>
      </div>
    </div>
  );
}
