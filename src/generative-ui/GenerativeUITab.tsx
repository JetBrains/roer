/**
 * The "plan review before execution" ADLC scenario from the research draft,
 * wired end to end: messages -> the same reducer a real drafting call feeds
 * -> the trusted renderer -> a result an agent would read back.
 *
 * State lives in the parent (`App`), because the live bridge needs to reach
 * it from outside a render: a `roer plugin-ui` message arrives as a Tauri
 * event, not a prop, and has to update the same reducer a checkbox flip does.
 * This component owns only the one piece of state nothing outside it cares
 * about — the approve/cancel result banner.
 */
import { useEffect, useState } from "react";

import { applyMessage } from "./apply";
import { GenerativeSurface } from "./GenerativeSurface";
import {
  listPluginUiBundles,
  readPluginUiBundle,
  reportPluginUiAction,
  writePluginUiBundle,
  type PluginUiBundleSummary,
} from "../lib/pluginUi";
import { resolveDir } from "../lib/session";
import type { A2uiMessage, ComponentId, RenderState } from "./schema";
import { writePath } from "./schema";

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

  const handleSetValue = (path: string, value: unknown) => {
    // A field edit becomes the same message shape a server-authored update
    // would send — proving the renderer only ever reacts to messages, never
    // to a shortcut path around them.
    onChange(
      applyMessage(state, {
        kind: "dataModelUpdate",
        surfaceId,
        patch: writePath({}, path, value),
      }),
    );
    setResult(null);
  };

  const handleAction = (action: string, sourceComponentId: ComponentId) => {
    if (action === "approve") {
      const chosen = Object.entries((dataModel.changes as Record<string, boolean>) ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id);
      setResult(
        chosen.length > 0
          ? `Approved: ${chosen.join(", ")}`
          : "Approved, but nothing was checked — nothing to apply.",
      );
    } else if (action === "reject") {
      setResult("Cancelled. Nothing was applied.");
    } else {
      setResult(null);
    }

    if (pane) {
      reportPluginUiAction({
        pane,
        surfaceId,
        name: action,
        sourceComponentId,
        timestamp: new Date().toISOString(),
        context: dataModel,
      }).catch((e: unknown) => console.error("roer: could not report a plugin-ui action", e));
    }
  };

  const handleSave = () => {
    if (!dir || !surface?.root) return;
    const name = saveName.trim();
    if (!name) return;

    const surfaceUpdate: Extract<A2uiMessage, { kind: "surfaceUpdate" }> = {
      kind: "surfaceUpdate",
      surfaceId,
      root: surface.root,
      components: Object.values(surface.components),
    };
    const dataModelUpdate =
      Object.keys(dataModel).length > 0
        ? ({ kind: "dataModelUpdate", surfaceId, patch: dataModel } as const)
        : undefined;

    writePluginUiBundle(dir, name, { prompt: savePrompt.trim(), surfaceUpdate, dataModelUpdate })
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
      .then((bundle) => {
        const messages: A2uiMessage[] = [bundle.surfaceUpdate];
        if (bundle.dataModelUpdate) messages.push(bundle.dataModelUpdate);
        messages.push({ kind: "beginRendering", surfaceId: bundle.surfaceUpdate.surfaceId });
        onLoadBundle(bundle.surfaceUpdate.surfaceId, messages);
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
        />
      ) : (
        <p className="gen-text muted">
          Canvas for the agent's <code>show_ui</code>
        </p>
      )}

      {result ? <p className="gen-result">{result}</p> : null}

      {dir ? (
        <div className="gen-bundles">
          <div className="gen-bundles-links">
            {surface?.root ? (
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
        <summary>Raw A2UI-shaped messages behind this surface</summary>
        <pre>{JSON.stringify(log, null, 2)}</pre>
      </details>
    </div>
  );
}
