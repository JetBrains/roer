/**
 * A Roer extension's tab, opened in another app as an MCP App: the page
 * `roer mcp` serves as `ui://roer/extension`. It hands the extension the same
 * host modules the desktop app does (`extensions/host.ts`), with the backend
 * swapped for `./backend`, then mounts the tab the extension registers, so
 * the extension's own build runs here unchanged. Served as `ui://roer/view`,
 * it draws `show_ui`'s views instead (`./view`).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import "./mcp-app.css";
import type { Extension, Session } from "../extensions/api";
import { HostProvider } from "../extensions/context";
import { installHost } from "../extensions/host";
import { Registry, type StageTabEntry } from "../extensions/registry";
import { setExtension } from "./backend";
import { call, failed, on, open, request, resized, say, type HostContext } from "./bridge";
import { runView } from "./view";

interface Args {
  id?: string;
  tab?: string;
  cwd?: string;
}

interface Loaded {
  id: string;
  name: string;
  js: string;
  css: string;
  cwd: string | null;
}

declare global {
  var __roerExtension: Extension | undefined;
}

const root = createRoot(document.getElementById("root")!);
const show = (node: ReactNode) => root.render(node);

class Catch extends Component<{ extension: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.extension} failed`, error, info.componentStack);
    failed(this.props.extension, `render failed: ${error.stack ?? error.message}${info.componentStack ?? ""}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <Message error>{`${this.props.extension} failed: ${this.state.error.message}`}</Message>;
  }
}

function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <div className="mcp-message">
      <p className={error ? "error" : "muted"}>{children}</p>
    </div>
  );
}

let context: HostContext = {};

function applyContext(next: HostContext) {
  context = { ...context, ...next };
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  fit();
}

/** The tab's height: a tab fills its stage in Roer, so here it gets a 16:10 box of the width it has, or the whole
 * screen when fullscreen. */
function fit() {
  const dims = context.containerDimensions ?? {};
  const width = dims.width ?? dims.maxWidth ?? document.documentElement.clientWidth;
  const full = context.displayMode === "fullscreen";
  const height = full ? (dims.height ?? dims.maxHeight ?? window.innerHeight) : Math.min(dims.maxHeight ?? 5000, Math.round((width * 10) / 16));
  document.documentElement.style.setProperty("--mcp-height", `${height}px`);
  resized(width, height);
}

/** Runs the extension's built code as an inline module, which every host's CSP lets through, and waits for it
 * to hand over its `defineExtension`. */
function run(loaded: Loaded): Promise<Extension> {
  const style = document.createElement("style");
  style.textContent = loaded.css;
  document.head.appendChild(style);
  return new Promise((resolve, reject) => {
    const done = () => (globalThis.__roerExtension ? resolve(globalThis.__roerExtension) : reject(new Error("the extension's app has no default export")));
    window.addEventListener("roer-extension", done, { once: true });
    window.addEventListener("error", (event) => reject(event.error ?? new Error(event.message)), { once: true });
    const script = document.createElement("script");
    script.type = "module";
    script.textContent = loaded.js;
    document.head.appendChild(script);
  });
}

function Frame({ entry, session, canFullscreen }: { entry: StageTabEntry; session: Session; canFullscreen: boolean }) {
  const View = entry.component;
  return (
    <div className="mcp-frame ext-tab">
      {canFullscreen && context.displayMode !== "fullscreen" ? (
        <button className="mcp-full" title="Fullscreen" onClick={() => void request("ui/request-display-mode", { mode: "fullscreen" }).then(() => undefined)}>
          ⤢
        </button>
      ) : null}
      <HostProvider
        value={{
          extension: entry.extension,
          session,
          active: true,
          focused: true,
          openFile: () => undefined,
          activateTab: () => undefined,
        }}
      >
        <Catch extension={entry.extension}>
          <View />
        </Catch>
      </HostProvider>
    </div>
  );
}

async function main() {
  installHost();
  show(<Message>Opening…</Message>);
  // The arguments the model opened us with come after the handshake; hear them before it can send them.
  const args = new Promise<Args>((resolve) => on("ui/notifications/tool-input", (params) => resolve(params?.arguments ?? {})));
  on("ui/notifications/host-context-changed", (next: HostContext) => {
    applyContext(next);
    render?.();
  });
  const opened = await open();
  applyContext(opened.context);
  const { id, tab, cwd } = await args;
  if (!id) return show(<Message error>No extension named: open_extension needs an id.</Message>);
  setExtension(id);
  opening = id;

  const loaded = await call<Loaded>("load", { id, cwd });
  const extension = await run(loaded);
  const registry = new Registry();
  registry.load(id, extension);
  const tabs = registry.tabs();
  const entry = tabs.find((one) => one.id === tab) ?? tabs[0];
  if (!entry) return show(<Message error>{`${loaded.name} has no tab to show.`}</Message>);

  const session: Session = {
    cwd: loaded.cwd ?? undefined,
    root: loaded.cwd,
    branch: null,
    // Whatever runs the conversation reads what the tab sends it.
    agent: opened.hostName,
    busy: false,
    changed: null,
    send: (text) => say(text),
  };
  const canFullscreen = (context.availableDisplayModes ?? []).includes("fullscreen");
  render = () => show(<Frame entry={entry} session={session} canFullscreen={canFullscreen} />);
  render();
}

let render: (() => void) | undefined;

let opening = "";

const fail = (error: unknown) => String(error instanceof Error ? error.message : error);

// The same page draws `show_ui`'s views, when the root it is served with says so.
if (document.getElementById("root")?.dataset.view === "genui") {
  runView(root).catch((error: unknown) => show(<Message error>{fail(error)}</Message>));
} else {
  main().catch((error: unknown) => {
    const message = fail(error);
    if (opening) failed(opening, `could not open: ${message}`);
    show(<Message error>{message}</Message>);
  });
}
