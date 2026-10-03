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

/** One row: a bundled extension, or one from disk. */
interface Row {
  id: string;
  name: string;
  description?: string | null;
  scope: "bundled" | "user" | "session";
  dir?: string;
  errors: string[];
}

const SCOPES: Record<Row["scope"], string> = {
  bundled: "Built in",
  user: "Installed",
  session: "Session",
};

const SCOPE_TITLES: Record<Row["scope"], string> = {
  bundled: "Ships with Roer",
  user: "In ~/.roer/extensions",
  session: "Loaded with `roer ext dev`: gone when Roer restarts",
};

/**
 * Every extension, built in or not, with a switch to turn each off. Off means
 * neither built nor loaded: its tabs leave the strip and its server stops.
 */
export function ExtensionsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<ExtensionInfo[] | null>(null);
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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
        <h2>Extensions</h2>
        <p className="muted ext-intro">A switched-off extension is neither built nor loaded: its tabs and tools go away until you switch it on.</p>
        {error ? <p className="error">{error}</p> : null}

        <h3>Built in</h3>
        <ul className="ext-list">{bundled.map(row)}</ul>

        <h3>Yours</h3>
        {found === null && !error ? <EmptyState variant="loading" text="Reading your extensions…" /> : null}
        {found !== null && yours.length === 0 ? (
          <EmptyState text="No extensions of your own yet." detail="Ask your agent for a tab you will keep coming back to, and it makes one." />
        ) : null}
        {yours.length > 0 ? <ul className="ext-list">{yours.map(row)}</ul> : null}
      </div>
    </div>
  );
}
