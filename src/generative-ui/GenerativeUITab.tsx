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
import { AppWindow } from "lucide-react";

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
import { useAskAgent } from "../lib/askAgent";
import { sendToSession } from "../lib/github";
import { typedSince } from "../lib/pty";
import { resolveDir } from "../lib/session";
import { useStageTabs } from "../extensions/registry";
import { stopOfferingTab, noteShown, offerTab } from "./returns";
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
  /** Brings an extension's tab to the top, from the list of views. */
  onOpenTab?: (tabId: string) => void;
  /** Opens the dialog that asks the agent for a new tab. */
  onNewTab?: () => void;
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
  onOpenTab,
  onNewTab,
}: Props) {
  const [result, setResult] = useState<string | null>(null);
  const [bundles, setBundles] = useState<PluginUiBundleSummary[]>([]);
  const [saveName, setSaveName] = useState("");
  const [savePrompt, setSavePrompt] = useState("");
  const [bundleStatus, setBundleStatus] = useState<string | null>(null);
  // Which of the links' dialogs is open, if any. They open over the window
  // rather than in the panel, so the surface keeps the panel to itself.
  const [dialog, setDialog] = useState<"save" | "open" | "keep" | "wire" | null>(null);
  // Extensions' own tabs, beside the saved views: both are views the person
  // keeps, and they should find either in one place.
  const tabs = useStageTabs().filter((tab) => tab.tabId.startsWith("ext:"));
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

  // Each view's arrival counts as a showing of it, whether the agent drew it
  // or the person opened a saved one: coming back to a view is what makes it
  // worth offering as a tab.
  const counted = useRef(new WeakSet<A2uiMessage>());
  const [offering, setOffering] = useState(false);
  useEffect(() => {
    if (!live || !dir) {
      setOffering(false);
      return;
    }
    for (const message of log) {
      if (!("createSurface" in message) || counted.current.has(message)) continue;
      counted.current.add(message);
      noteShown(dir, message.createSurface.surfaceId);
    }
    setOffering(!!surfaceId && offerTab(dir, surfaceId));
  }, [log, live, dir, surfaceId]);

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

  /** Saves the view as it stands, edits included, as `name`. */
  const saveView = (name: string, prompt: string): Promise<void> => {
    if (!dir || !surface?.components.root) return Promise.reject(new Error("nothing to save"));

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

    return writePluginUiBundle(dir, name, { prompt, surface: createSurface }).then(() =>
      listPluginUiBundles(dir).then(setBundles),
    );
  };

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    saveView(name, savePrompt.trim())
      .then(() => {
        setBundleStatus(`Saved as "${name}".`);
        setSaveName("");
        setSavePrompt("");
        setDialog(null);
      })
      .catch((e: unknown) => {
        console.error("roer: could not save a view", e);
        setBundleStatus(`Could not save "${name}".`);
      });
  };

  // "Keep as tab": the view is saved, then the agent is asked to make it an
  // extension. The request goes only while it waits at its prompt, the one
  // moment it cannot land in the middle of its work or on a draft of the
  // person's; asked at any other, it waits for that moment.
  const agent = useAskAgent(pane, agentState);
  const keepName = (saveName.trim() || surfaceId).replace(/[^A-Za-z0-9_-]/g, "-");
  const keepPrompt = keepTabPrompt(keepName, savePrompt.trim());
  const replacing = bundles.some((bundle) => bundle.name === keepName);
  // Where the latest "Keep as tab" request is, from the click to the tab
  // showing up in the strip, so the person always sees what happens next.
  const [keeping, setKeeping] = useState<{
    name: string;
    prompt: string;
    tabsBefore: readonly string[];
    saved: boolean;
  } | null>(null);
  useEffect(() => setKeeping(null), [pane]);
  const keptTab = keeping ? tabs.find((tab) => !keeping.tabsBefore.includes(tab.tabId)) : undefined;
  const keepHeld = !!keeping && agent.held.some((request) => request.text === keeping.prompt);

  const handleKeep = () => {
    if (!agent.canAsk) {
      setBundleStatus("No agent here to ask: start one in this session first.");
      return;
    }
    if (keeping && !keeping.saved) return;
    const request = { name: keepName, prompt: keepPrompt, tabsBefore: tabs.map((tab) => tab.tabId), saved: false };
    // The dialog closes at once: what follows is shown under it, in the panel.
    setKeeping(request);
    setDialog(null);
    setBundleStatus(null);
    if (dir) stopOfferingTab(dir, surfaceId);
    setOffering(false);
    saveView(request.name, savePrompt.trim())
      .then(() => {
        setKeeping((current) => (current === request ? { ...request, saved: true } : current));
        return agent.ask(request.prompt, `make “${request.name}” a tab`);
      })
      .catch((e: unknown) => {
        console.error("roer: could not hand a view over to become a tab", e);
        setKeeping(null);
        setBundleStatus("Could not ask the agent to make this a tab.");
      });
  };

  const keepStatus = !keeping ? null : !keeping.saved ? (
    <>
      <span className="gen-spinner" aria-hidden="true" />
      <span className="gen-text">Saving “{keeping.name}”…</span>
    </>
  ) : keptTab ? (
    <>
      <span className="gen-text">“{keptTab.title}” is ready in the strip.</span>
      {onOpenTab ? (
        <button type="button" className="gen-button primary" onClick={() => onOpenTab(keptTab.tabId)}>
          Open tab
        </button>
      ) : null}
      <button type="button" className="gen-button borderless" onClick={() => setKeeping(null)}>
        Dismiss
      </button>
    </>
  ) : keepHeld ? (
    <>
      <span className="gen-text">
        {agentState === "done"
          ? `Your prompt has text in it, so asking the agent to make “${keeping.name}” a tab waits until you send or clear it.`
          : `Waiting for the agent to finish, then asking it to make “${keeping.name}” a tab.`}
      </span>
      <button
        type="button"
        className="gen-button"
        onClick={() =>
          void agent.sendNow(keeping.prompt).catch((e: unknown) => {
            console.error("roer: could not send a held request to the agent", e);
            setBundleStatus("Could not ask the agent to make this a tab.");
          })
        }
      >
        Send now
      </button>
      <button
        type="button"
        className="gen-button borderless"
        onClick={() => {
          agent.cancel(keeping.prompt);
          setKeeping(null);
        }}
      >
        Cancel
      </button>
    </>
  ) : (
    <>
      {agentState === "working" ? <span className="gen-spinner" aria-hidden="true" /> : null}
      <span className="gen-text">
        {agentState === "working"
          ? `The agent is making “${keeping.name}” a tab. It appears in the strip once it builds.`
          : `Asked the agent to make “${keeping.name}” a tab. It appears in the strip once it builds.`}
      </span>
      <button type="button" className="gen-button borderless" onClick={() => setKeeping(null)}>
        Dismiss
      </button>
    </>
  );

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
        console.error("roer: could not load a view", e);
        setBundleStatus(`Could not load "${name}".`);
      });
  };

  return (
    <div className="gen-tab">
      {keepStatus ? (
        <div className="gen-keep keeping" role="status" data-testid="keep-status">
          {keepStatus}
        </div>
      ) : dir && surface?.components.root && pane ? (
        <div className={offering ? "gen-keep offering" : "gen-keep"}>
          <button type="button" className="gen-button" onClick={() => setDialog("keep")}>
            <AppWindow size={13} aria-hidden="true" />
            Keep as tab…
          </button>
          <span className="gen-text muted">
            {offering
              ? "You keep coming back to this view. As a tab it stays in the strip and fetches its own data."
              : "A tab stays in the strip and fetches its own data."}
          </span>
          {offering ? (
            <button
              type="button"
              className="gen-button borderless"
              onClick={() => {
                stopOfferingTab(dir, surfaceId);
                setOffering(false);
              }}
            >
              Not now
            </button>
          ) : null}
        </div>
      ) : null}

      {live && surface ? (
        <GenerativeSurface
          surface={surface}
          dataModel={dataModel}
          onSetValue={handleSetValue}
          onAction={handleAction}
          onOpenFile={handleOpenFile}
        />
      ) : (
        <div className="gen-panel-empty gen-text muted">
          <p>
            Nothing here yet. When an agent shows you a view to look at or answer, such as a plan to
            approve or a dashboard, it appears here.
          </p>
          <p>
            For something you will come back to, ask for a tab instead, such as “a tab with my open
            pull requests”: the agent writes it, and it stays in the strip and fetches its own data.
          </p>
          {onNewTab ? (
            <button type="button" className="gen-button" onClick={onNewTab}>
              New tab…
            </button>
          ) : null}
        </div>
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
        <PanelDialog title="Save this view" onClose={() => setDialog(null)}>
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
              placeholder="what it shows (optional)"
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

      {dialog === "keep" ? (
        <PanelDialog title="Keep this view as a tab" onClose={() => setDialog(null)}>
          <p className="gen-text">
            A tab stays in Roer's strip and fetches its own data, where a view shows what the agent
            sends it. The agent writes it as an extension: code that runs in Roer with your
            permissions, which it loads for you to try and installs only when you say so.
          </p>
          <form
            className="gen-bundles-save"
            onSubmit={(e) => {
              e.preventDefault();
              handleKeep();
            }}
          >
            <input
              className="gen-bundles-input"
              placeholder={`save as… (${surfaceId})`}
              autoFocus
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
            />
            <input
              className="gen-bundles-input"
              placeholder="what it shows (optional)"
              value={savePrompt}
              onChange={(e) => setSavePrompt(e.target.value)}
            />
            <p className="gen-text muted">
              {replacing ? `Replaces the saved view “${keepName}”, then` : `Saved as “${keepName}”, then`} this goes to the
              agent:
            </p>
            <pre className="gen-wire">{keepPrompt}</pre>
            {!agent.canAsk ? (
              <p className="gen-text muted">No agent here to ask: start one in this session first.</p>
            ) : !agent.ready ? (
              <p className="gen-text muted">
                {agentState === "done"
                  ? "Your prompt has text in it, so this waits until you send or clear it."
                  : "The agent is busy, so this waits and goes to it when it is next waiting for you."}
              </p>
            ) : null}
            <div className="gen-row">
              <button type="submit" className="gen-button primary" disabled={!agent.canAsk}>
                {agent.canAsk && !agent.ready ? "Save and ask when it is ready" : "Save and ask the agent"}
              </button>
              <button type="button" className="gen-button borderless" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        </PanelDialog>
      ) : null}

      {dialog === "open" ? (
        <PanelDialog title="Views" onClose={() => setDialog(null)}>
          <h3 className="gen-dialog-section">Saved views</h3>
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
            <p className="gen-text muted">No saved views in this project yet. Save… keeps the one on screen.</p>
          )}
          <h3 className="gen-dialog-section">Tabs</h3>
          {tabs.length > 0 ? (
            <ul className="gen-bundles-list">
              {tabs.map((tab) => (
                <li key={tab.tabId}>
                  <button
                    className="gen-button"
                    disabled={!onOpenTab}
                    onClick={() => {
                      onOpenTab?.(tab.tabId);
                      setDialog(null);
                    }}
                  >
                    {tab.title}
                  </button>
                  <span className="gen-text muted"> — an extension: runs code, fetches its own data</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="gen-text muted">No tabs of your own yet. Keep as tab… makes one from a view.</p>
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

/** What "Keep as tab" asks the agent, about the view saved as `name`. */
export function keepTabPrompt(name: string, about: string): string {
  return [
    `Make the saved view "${name}" (.roer/plugin-ui/bundles/${name}/surface.json${about ? `, which shows ${about}` : ""}) into a Roer extension tab I can keep.`,
    "Use the roer-extension-authoring skill. Draw it with `Surface` from roer/ui and its saved components, and have the tab fetch its own data rather than keep the data model saved with it.",
    "Ask me where that data comes from if it is not clear. Load it with extension_dev for me to try, and ask me before you install it.",
  ].join(" ");
}
