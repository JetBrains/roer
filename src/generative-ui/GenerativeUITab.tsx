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
import { useEffect, useState } from "react";

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
}

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
}: Props) {
  const [result, setResult] = useState<string | null>(null);
  const [bundles, setBundles] = useState<PluginUiBundleSummary[]>([]);
  const [saveName, setSaveName] = useState("");
  const [savePrompt, setSavePrompt] = useState("");
  const [bundleStatus, setBundleStatus] = useState<string | null>(null);
  // Which of the two link-triggered panels is open, if either — never both,
  // so picking one always replaces whatever the other was showing.
  const [bundlePanel, setBundlePanel] = useState<"save" | "open" | null>(null);
  // The terminal's own `cd` moves it to a new project without a remount, so
  // `cwd` (the session's *opening* directory) is only a fallback — the same
  // resolution `DiffBrowserView`/`GoToFile` use, so bundles always come from
  // the project the pane is actually sitting in.
  const [dir, setDir] = useState<string | undefined>(cwd);

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
    // it went where the agent reads.
    setResult(pane ? `Sent “${event.name}” to the agent.` : null);

    if (pane) {
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
      }).catch((e: unknown) => console.error("roer: could not report a plugin-ui action", e));
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
        setBundlePanel(null);
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
        setBundlePanel(null);
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

      {dir ? (
        <div className="gen-bundles">
          <div className="gen-bundles-links">
            {surface?.components.root ? (
              <button
                type="button"
                className="link"
                onClick={() => setBundlePanel((current) => (current === "save" ? null : "save"))}
              >
                {bundlePanel === "save" ? "Cancel" : "Save"}
              </button>
            ) : null}
            <button
              type="button"
              className="link"
              onClick={() => setBundlePanel((current) => (current === "open" ? null : "open"))}
            >
              {bundlePanel === "open" ? "Cancel" : "Open"}
            </button>
          </div>

          {bundlePanel === "save" ? (
            <div className="gen-bundles-save">
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
              <button className="gen-button" disabled={!saveName.trim()} onClick={handleSave}>
                Save
              </button>
            </div>
          ) : null}

          {bundlePanel === "open" ? (
            bundles.length > 0 ? (
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
            )
          ) : null}

          {bundleStatus ? <p className="gen-text muted">{bundleStatus}</p> : null}
        </div>
      ) : null}

      <details className="gen-wire">
        <summary>Raw A2UI v1.0 messages behind this surface</summary>
        <pre>{JSON.stringify(log, null, 2)}</pre>
      </details>
    </div>
  );
}
