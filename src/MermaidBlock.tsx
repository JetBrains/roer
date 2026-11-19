/**
 * A ```mermaid block in Markdown, drawn as its diagram: in a thread's answer, a comment, a file read rendered.
 * Only drawn, with nothing to click: the source shows instead while it is drawn and when it cannot be.
 */
import { useEffect, useId, useState } from "react";

import { draw } from "./lib/mermaid";
import { currentTheme, onThemeChange, type Theme } from "./lib/theme";

/** What each source was drawn as, per theme: a block mounted again (a thread re-rendered, a reply scrolled back
 * into view) shows its diagram at once, rather than its source while it is drawn again. */
const drawnBefore = new Map<string, string>();
const MAX_DRAWN = 50;

export function MermaidBlock({ source }: { source: string }) {
  const baseId = `md-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const cached = drawnBefore.get(`${theme}\0${source}`);
  const [drawn, setDrawn] = useState<{ svg: string } | { error: string } | null>(cached ? { svg: cached } : null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => onThemeChange(setTheme), []);

  useEffect(() => {
    const key = `${theme}\0${source}`;
    const known = drawnBefore.get(key);
    if (known) {
      setDrawn({ svg: known });
      return;
    }
    // New source: its own, not the last one's drawing, until it is drawn.
    setDrawn(null);
    let cancelled = false;
    // An id of its own each time: `mermaid.render` first removes whatever element already has the one it is given.
    const id = `${baseId}-${Math.random().toString(36).slice(2, 8)}`;
    draw(id, source, theme).then(
      (svg) => {
        if (drawnBefore.size >= MAX_DRAWN) drawnBefore.delete(drawnBefore.keys().next().value!);
        drawnBefore.set(key, svg);
        if (!cancelled) setDrawn({ svg });
      },
      (e: unknown) => !cancelled && setDrawn({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [baseId, source, theme]);

  const code = (
    <pre>
      <code className="language-mermaid">{source}</code>
    </pre>
  );
  if (!drawn) return <div className="md-mermaid drawing">{code}</div>;
  if ("error" in drawn) {
    return (
      <div className="md-mermaid failed">
        <p className="muted">Could not draw this diagram: {drawn.error}</p>
        {code}
      </div>
    );
  }
  return (
    <div className="md-mermaid">
      {/* Mermaid's own markup, drawn at its `strict` level: sanitized labels, no scripts, no click bindings. */}
      <div className="md-mermaid-svg" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      <button type="button" className="link md-mermaid-toggle" onClick={() => setShowSource((on) => !on)}>
        {showSource ? "Hide source" : "Source"}
      </button>
      {showSource ? code : null}
    </div>
  );
}
