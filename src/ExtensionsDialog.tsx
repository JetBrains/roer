import { useCallback, useEffect, useRef, useState } from "react";

import { BUNDLED } from "./extensions/bundled";
import {
  EXTENSIONS_EVENT,
  listDisabled,
  listExtensions,
  setExtensionEnabled,
  type ExtensionInfo,
} from "./extensions/loader";
import { Badge, EmptyState } from "./generative-ui/components";
import { listen } from "./lib/backend";
import { connectOtherApp, MCP_APP_HOST, otherApps, type OtherApp } from "./lib/otherApps";

/** One row: a bundled extension, or one from disk. */
interface Row {
  id: string;
  name: string;
  description?: string | null;
  scope: "bundled" | "user" | "session";
  dir?: string;
  errors: string[];
  /** Opens in the Claude app's and Codex's chats too. */
  elsewhere?: boolean;
}

const SCOPES: Record<Row["scope"], string> = {
  bundled: "Built in",
  user: "Installed",
  session: "Session",
};

/** What each state of a connection to another app means, said in its row. */
const APP_STATES: Record<OtherApp["state"], string> = {
  connected: "Its chats open the ones marked Other apps",
  off: "Its chats could open the ones marked Other apps",
  theirs: "Has a roer entry you set up yourself, left as it is",
  missing: "Not on this machine",
};

const SCOPE_TITLES: Record<Row["scope"], string> = {
  bundled: "Ships with Roer",
  user: "In ~/.roer/extensions",
  session: "Loaded with `roer ext dev`: gone when Roer restarts",
};

/**
 * Every extension, built in or not, with a switch to turn each off. Off means
 * neither built nor loaded: its tabs leave the strip, its sections the
 * Workspace tab, and its server stops.
 * `onNewTab` asks the agent for one of the person's own.
 */
export function ExtensionsDialog({ onClose, onNewTab }: { onClose: () => void; onNewTab?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<ExtensionInfo[] | null>(null);
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<OtherApp[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  // Its own: trouble with another app says nothing about the extensions above it.
  const [appsError, setAppsError] = useState<string | null>(null);

  useEffect(() => {
    otherApps().then(setApps, (cause: unknown) => setAppsError(String(cause)));
  }, []);

  const connect = async (app: OtherApp, on: boolean) => {
    setAppsError(null);
    setConnecting(app.id);
    try {
      setApps(await connectOtherApp(app.id, on));
    } catch (cause) {
      setAppsError(String(cause));
      void otherApps().then(setApps, () => undefined);
    } finally {
      setConnecting(null);
    }
  };

  useEffect(() => {
    const back = document.activeElement;
    ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [all, off] = await Promise.all([listExtensions(), listDisabled()]);
      setFound(all);
      setDisabled(new Set(off));
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let stop: (() => void) | undefined;
    let gone = false;
    void listen(EXTENSIONS_EVENT, () => void refresh()).then((unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [refresh]);

  const toggle = async (id: string, enabled: boolean) => {
    setError(null);
    // Shown at once; the backend's event brings the truth a moment later.
    setDisabled((current) => {
      const next = new Set(current);
      if (enabled) next.delete(id);
      else next.add(id);
      return next;
    });
    try {
      await setExtensionEnabled(id, enabled);
    } catch (cause) {
      setError(String(cause));
      void refresh();
    }
  };

  const bundled: Row[] = BUNDLED.map(({ id, name, description }) => ({ id, name, description, scope: "bundled", errors: [] }));
  const yours: Row[] = (found ?? []).map((info) => ({
    id: info.id,
    name: info.name,
    description: info.description,
    scope: info.scope,
    dir: info.dir,
    errors: info.ok ? [] : info.errors,
    elsewhere: info.hosts?.includes(MCP_APP_HOST) ?? false,
  }));

  const row = (item: Row) => {
    const on = !disabled.has(item.id);
    const failed = on && item.errors.length > 0;
    return (
      <li key={`${item.scope}:${item.id}`} className={on ? "ext-row" : "ext-row off"}>
        <div className="ext-row-main">
          <div className="ext-row-head">
            <strong>{item.name}</strong>
            <span title={SCOPE_TITLES[item.scope]}>
              <Badge tone={item.scope === "session" ? "warning" : "neutral"}>{SCOPES[item.scope]}</Badge>
            </span>
            {item.elsewhere ? (
              <span title="Opens in the Claude app's and Codex's chats, once they are connected">
                <Badge tone="accent">Other apps</Badge>
              </span>
            ) : null}
            {!on ? <Badge>Off</Badge> : failed ? <Badge tone="danger">Build failed</Badge> : null}
          </div>
          {item.description ? <p className="ext-row-text">{item.description}</p> : null}
          {item.dir ? (
            <p className="ext-row-dir" title={item.dir}>
              {item.dir}
            </p>
          ) : null}
          {failed ? <pre className="ext-row-errors">{item.errors.join("\n")}</pre> : null}
        </div>
        <label className="ext-switch" title={on ? "Switch off" : "Switch on"}>
          <input
            type="checkbox"
            role="switch"
            aria-label={`${item.name} enabled`}
            checked={on}
            onChange={(event) => void toggle(item.id, event.target.checked)}
          />
          <span aria-hidden="true" />
        </label>
      </li>
    );
  };

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className="popup extensions"
        role="dialog"
        aria-modal="true"
        aria-label="Extensions"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="ext-head">
          <h2>Extensions</h2>
          <p className="muted ext-intro">A switched-off extension is neither built nor loaded: its tabs, Workspace tab sections and tools go away until you switch it on.</p>
          {error ? <p className="error">{error}</p> : null}
        </div>

        <div className="ext-body">
          <h3>Built in</h3>
          <ul className="ext-list">{bundled.map(row)}</ul>

          <h3>Yours</h3>
          {found === null && !error ? <EmptyState variant="loading" text="Reading your extensions…" /> : null}
          {found !== null && yours.length === 0 ? (
            <EmptyState
              text="No extensions of your own yet."
              detail="Ask your agent for a tab you will keep coming back to, such as one with your open pull requests, or for a section of the Workspace tab about all of its projects, and it writes one."
              footer={
                onNewTab ? (
                  <button type="button" className="gen-button" onClick={onNewTab}>
                    New extension…
                  </button>
                ) : undefined
              }
            />
          ) : null}
          {yours.length > 0 ? <ul className="ext-list">{yours.map(row)}</ul> : null}
          {/* Held at the bottom of the list as it scrolls, so a new extension is always a click away. */}
          {yours.length > 0 && onNewTab ? (
            <div className="ext-new-tab">
              <button type="button" className="gen-button" onClick={onNewTab}>
                New extension…
              </button>
            </div>
          ) : null}
        </div>

        {/* Always in view, under the list: whether the person's other apps can open these. */}
        <div className="ext-apps">
          <h3>In other apps</h3>
          {appsError ? <p className="error">{appsError}</p> : null}
          {apps === null && !appsError ? <p className="muted ext-intro">Looking for the apps…</p> : null}
          {apps ? (
            <ul className="ext-list">
              {apps.map((app) => (
                <li key={app.id} className={app.state === "missing" ? "ext-row ext-app off" : "ext-row ext-app"} title={app.config ?? undefined}>
                  <div className="ext-row-main">
                    <div className="ext-row-head">
                      <strong>{app.name}</strong>
                      {app.state === "connected" ? <Badge tone="success">Connected</Badge> : null}
                      <span className="ext-row-text ext-app-state">{APP_STATES[app.state]}</span>
                    </div>
                  </div>
                  {app.state === "connected" || app.state === "off" ? (
                    <button
                      type="button"
                      className={app.state === "off" ? "gen-button primary" : "gen-button"}
                      disabled={connecting !== null}
                      onClick={() => void connect(app, app.state === "off")}
                    >
                      {connecting === app.id ? "…" : app.state === "off" ? "Connect" : "Disconnect"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
