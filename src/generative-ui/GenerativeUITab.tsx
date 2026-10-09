/**
 * The panel an agent's `show_ui` draws in: messages -> the reducer -> the
 * trusted renderer -> the actions the agent reads back.
 *
 * State lives in the parent (`App`), because the live bridge needs to reach
 * it from outside a render: a `roer plugin-ui` message arrives as a Tauri
 * event, not a prop, and has to update the same reducer a checkbox flip does.
 * This component owns only the one piece of state nothing outside it cares
 * about — the line saying a click reached the agent.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { applyMessage } from "./apply";
import { GenerativeSurface, type ResolvedEvent } from "./GenerativeSurface";
import { upgradeBundle } from "./legacy";
import {
  listPluginUiBundles,
  readPluginUiBundle,
  reportPluginUiAction,
  writePluginUiBundle,
  type PluginUiBundleSummary,
} from "../lib/pluginUi";
import { gitRoot } from "../lib/git";
import { sendToSession } from "../lib/github";
import { typedSince } from "../lib/pty";
import { resolveDir } from "../lib/session";
import { A2UI_VERSION, type A2uiMessage, type ComponentId, type JsonPointer, type RenderState } from "./schema";

interface Props {
  state: RenderState;
  surfaceId: string;
  onChange: (state: RenderState) => void;
  /** The messages that produced `state`, for the raw-wire debug view. */
  log: readonly A2uiMessage[];
  /** False while showing the built-in fixture; true once a real message has
   * arrived over the bridge. */
  live: boolean;
  /** The session's pane, so a button click can be reported back to whatever
   * agent is watching it. Undefined (the fixture, or no session yet) means
   * an action only updates local state — there's nowhere to report it. */
  pane?: string;
  /** The session's working directory, for locating the project's
   * `.roer/plugin-ui/bundles`. Undefined (the fixture, or no session yet)
   * means saving/loading bundles is unavailable — there's no project to
   * scope them to. */
  cwd?: string;
  /** A saved bundle was loaded: replaces the whole surface, the same way a
   * live message from `roer plugin-ui` does — the parent owns `surfaceId`
   * and `log`, which `onChange` alone can't reach. */
  onLoadBundle: (surfaceId: string, messages: A2uiMessage[]) => void;
  /** Opens a file of the session's repository in a tab of its own. */
  onOpenFile?: (root: string, path: string) => void;
  /** What the session's agent last said it is doing, from its own hooks;
   * undefined when no agent with hooks runs there. */
  agentState?: "working" | "waiting" | "done" | "";
}

/** Submitted for the agent when a click finds it idle at its prompt. Its
 * prompt hook hands it the click itself; this only starts the turn. */
export const NUDGE = "I left something for you in the Generative UI panel.";

export function GenerativeUITab({
  state,
  surfaceId,
  onChange,
  log,
  live,
  pane,
  cwd,
  onLoadBundle,
  onOpenFile,
  agentState,
}: Props) {
  const [result, setResult] = useState<string | null>(null);
  const [bundles, setBundles] = useState<PluginUiBundleSummary[]>([]);
  const [saveName, setSaveName] = useState("");
  const [savePrompt, setSavePrompt] = useState("");
  const [bundleStatus, setBundleStatus] = useState<string | null>(null);
  // Which of the links' dialogs is open, if any. They open over the window
  // rather than in the panel, so the surface keeps the panel to itself.
  const [dialog, setDialog] = useState<"save" | "open" | "wire" | null>(null);
  // The terminal's own `cd` moves it to a new project without a remount, so
  // `cwd` (the session's *opening* directory) is only a fallback — the same
  // resolution `DiffBrowserView`/`GoToFile` use, so bundles always come from
  // the project the pane is actually sitting in.
  const [dir, setDir] = useState<string | undefined>(cwd);
  // An agent's hooks hand it the panel's clicks only at its own steps, so a
  // click made while it sits at its prompt would wait for the person's next
  // message. One nudge starts its turn; more before it does would queue
  // prompts, so this holds until its state moves off "done".
  const nudged = useRef(false);
  // When the agent's current turn started. Typing since then may be a draft
  // still sitting in its prompt, which a nudge would be typed onto and
  // submit; answering a permission prompt starts the turn again, so it
  // does not count.
  const turnStarted = useRef(0);
  useEffect(() => {
    if (agentState !== "done") nudged.current = false;
    if (agentState === "working") turnStarted.current = Date.now();
  }, [agentState]);

  useEffect(() => {
    let cancelled = false;
    void resolveDir(cwd, pane).then((next) => {
      if (!cancelled) setDir(next || undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, pane]);

  useEffect(() => {
    if (!dir) return;
    listPluginUiBundles(dir)
      .then(setBundles)
      .catch((e: unknown) => console.error("roer: could not list plugin-ui bundles", e));
  }, [dir]);

  const surface = state.surfaces[surfaceId];
  const dataModel = state.dataModels[surfaceId] ?? {};

  const handleSetValue = (path: JsonPointer, value: unknown) => {
    // A field edit becomes the same message an agent-authored update would
    // send — proving the renderer only ever reacts to messages, never to a
    // shortcut path around them.
    onChange(applyMessage(state, { version: A2UI_VERSION, updateDataModel: { surfaceId, path, value } }));
    setResult(null);
  };

  const handleAction = (event: ResolvedEvent, sourceComponentId: ComponentId) => {
    // What the click means is the agent's to say; all this can tell is that
    // it went where the agent reads, and when the agent will get to it.
    const idle = agentState === "done";
    const drafting = idle && !!pane && typedSince(pane, turnStarted.current);
    const later = `Sent “${event.name}”. The agent sees it with your next message.`;
    setResult(
      !pane
        ? null
        : drafting
          ? later
          : idle
            ? `Sent “${event.name}”. Asked the agent to look.`
            : agentState === "working"
              ? `Sent “${event.name}”. The agent sees it at its next step.`
              : agentState === "waiting"
                ? `Sent “${event.name}”. The agent is waiting for you in the terminal and sees it after.`
                : `Sent “${event.name}” to the agent.`,
    );

    if (pane) {
      const nudge = idle && !drafting && !nudged.current;
      // Taken now, so a second click while this one is on its way does not
      // nudge too; given back if this one never reaches the agent.
      if (nudge) nudged.current = true;
      reportPluginUiAction({
        pane,
        message: {
          version: A2UI_VERSION,
          action: {
            name: event.name,
            surfaceId,
            sourceComponentId,
            timestamp: new Date().toISOString(),
            context: event.context,
            ...(event.userMessage ? { userMessage: event.userMessage } : {}),
          },
        },
        ...(surface?.sendDataModel ? { dataModel } : {}),
      })
        // The click is on file before the prompt goes, so the hook finds it.
        .then(
          () =>
            nudge
              ? sendToSession(pane, NUDGE).catch((e: unknown) => {
                  nudged.current = false;
                  setResult(later);
                  console.error("roer: could not ask the agent to look at a plugin-ui action", e);
                })
              : undefined,
          (e: unknown) => {
            if (nudge) nudged.current = false;
            setResult(`Could not send “${event.name}” to the agent.`);
            console.error("roer: could not report a plugin-ui action", e);
          },
        );
    }
  };

  // A surface names files relative to the project, which is the repository
  // the pane is sitting in — or the directory itself outside one.
  const handleOpenFile =
    onOpenFile && dir
      ? (path: string) =>
          void gitRoot(dir)
            .then((root) => onOpenFile(root ?? dir, path))
            .catch((e: unknown) => console.error("roer: could not open a file from a plugin UI", e))
      : undefined;

  const handleSave = () => {
    if (!dir || !surface?.components.root) return;
    const name = saveName.trim();
    if (!name) return;

    // One `createSurface` with everything inline is the whole UI as it
    // stands, edits included — v1.0 made that a single message.
    const createSurface: Extract<A2uiMessage, { createSurface: unknown }> = {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId: surface.catalogId,
        ...(surface.sendDataModel ? { sendDataModel: true } : {}),
        components: Object.values(surface.components),
        ...(Object.keys(dataModel).length > 0 ? { dataModel } : {}),
      },
    };

    writePluginUiBundle(dir, name, { prompt: savePrompt.trim(), surface: createSurface })
      .then(() => {
        setBundleStatus(`Saved as "${name}".`);
        setSaveName("");
        setSavePrompt("");
        setDialog(null);
        return listPluginUiBundles(dir).then(setBundles);
      })
      .catch((e: unknown) => {
        console.error("roer: could not save a plugin-ui bundle", e);
        setBundleStatus(`Could not save "${name}".`);
      });
  };

  const handleLoad = (name: string) => {
    if (!dir) return;
    readPluginUiBundle(dir, name)
      .then(async (bundle) => {
        let surface = bundle.surface;
        if (!surface && bundle.legacy) {
          // Saved before v1.0: upgrade it once and write it back, so the old
          // shape never lives on beside the new one.
          surface = upgradeBundle(bundle.legacy);
          if (surface) await writePluginUiBundle(dir, name, { prompt: bundle.prompt, surface });
        }
        if (!surface) throw new Error(`bundle "${name}" has no surface`);
        onLoadBundle(surface.createSurface.surfaceId, [surface]);
        setResult(null);
        setBundleStatus(`Loaded "${name}".`);
        setDialog(null);
      })
      .catch((e: unknown) => {
        console.error("roer: could not load a plugin-ui bundle", e);
        setBundleStatus(`Could not load "${name}".`);
      });
  };

  return (
    <div className="gen-tab">
      {live && surface ? (
        <GenerativeSurface
          surface={surface}
          dataModel={dataModel}
          onSetValue={handleSetValue}
          onAction={handleAction}
          onOpenFile={handleOpenFile}
        />
      ) : (
        <p className="gen-text muted">
          Nothing here yet. When an agent shows you something to look at or answer, such as a
          plan to approve or a dashboard, it appears here.
        </p>
      )}

      {result ? <p className="gen-result">{result}</p> : null}

      <div className="gen-panel-links">
        {dir && surface?.components.root ? (
          <button type="button" className="link" onClick={() => setDialog("save")}>
            Save…
          </button>
        ) : null}
        {dir ? (
          <button type="button" className="link" onClick={() => setDialog("open")}>
            Open…
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => setDialog("wire")}>
          Messages
        </button>
        {bundleStatus ? <span className="muted">{bundleStatus}</span> : null}
      </div>

      {dialog === "save" ? (
        <PanelDialog title="Save this UI" onClose={() => setDialog(null)}>
          <form
            className="gen-bundles-save"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
          >
            <input
              className="gen-bundles-input"
              placeholder="save as…"
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
            />
            <input
              className="gen-bundles-input"
              placeholder="prompt that built this (optional)"
              value={savePrompt}
              onChange={(e) => setSavePrompt(e.target.value)}
            />
            <div className="gen-row">
              <button type="submit" className="gen-button primary" disabled={!saveName.trim()}>
                Save
              </button>
              <button type="button" className="gen-button borderless" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        </PanelDialog>
      ) : null}

      {dialog === "open" ? (
        <PanelDialog title="Open a saved UI" onClose={() => setDialog(null)}>
          {bundles.length > 0 ? (
            <ul className="gen-bundles-list">
              {bundles.map((bundle) => (
                <li key={bundle.name}>
                  <button className="gen-button" onClick={() => handleLoad(bundle.name)}>
                    {bundle.name}
                  </button>
                  {bundle.prompt ? <span className="gen-text muted"> — {bundle.prompt}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="gen-text muted">No saved generative UIs in this project yet.</p>
          )}
        </PanelDialog>
      ) : null}

      {dialog === "wire" ? (
        <PanelDialog title="Raw A2UI v1.0 messages behind this surface" onClose={() => setDialog(null)} wide>
          <pre className="gen-wire">{JSON.stringify(log, null, 2)}</pre>
        </PanelDialog>
      ) : null}
    </div>
  );
}

/** A dialog over the whole window, the way Roer's others are: Escape or a
 * click outside closes it, and focus goes back where it was. */
function PanelDialog({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className={wide ? "popup gen-dialog wide" : "popup gen-dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
