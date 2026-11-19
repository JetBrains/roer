/**
 * Drawing Mermaid source as SVG, for every place that shows a diagram: a Generative UI view's, and a ```mermaid
 * block in Markdown (a thread's answer, a file read rendered).
 *
 * `mermaid` is big, so it is imported the first time a diagram is drawn rather than with the app. It runs in its
 * `strict` security level: labels are sanitized, and `click` directives in the source bind nothing.
 */
import type { Theme } from "./theme";

type MermaidApi = typeof import("mermaid").default;

let loading: Promise<MermaidApi> | undefined;
const loadMermaid = (): Promise<MermaidApi> => (loading ??= import("mermaid").then((m) => m.default));

/** `mermaid` keeps one configuration for the page, so drawings take turns:
 * one diagram's theme must not leak into another's that is being drawn. */
let queue: Promise<unknown> = Promise.resolve();

export async function draw(id: string, source: string, theme: Theme): Promise<string> {
  const mermaid = await loadMermaid();
  const turn = queue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // A syntax error is ours to show, not a bomb drawn into the page.
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: themeVariables(theme),
      // ELK, mermaid's own default, is left out of the app (see
      // vite.config.ts), and a diagram may not ask for it back: its config
      // can change any key but the secure ones.
      layout: "dagre",
      // Nor its looks: CSS in a diagram's own config could load from the web (`@import`, `url(…)`).
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "layout", ...LOOKS],
    });
    const { svg } = await mermaid.render(id, source);
    return offline(svg);
  });
  queue = turn.catch(() => {});
  return turn;
}

/** The config keys that style a diagram: Roer's to set, never the diagram's, since CSS can fetch. */
const LOOKS = ["theme", "themeVariables", "themeCSS", "fontFamily", "altFontFamily", "darkMode"];

/**
 * The drawing with nothing in it that reaches out: a diagram comes from whoever wrote the file, the comment or the
 * answer, and must not be able to tell anyone it was read. A `style` line's `url(…)` and `@import` go, and so does an
 * image in a label that points anywhere but inside the drawing; `url(#marker)`, the arrowheads, stays.
 */
export function offline(svg: string): string {
  return svg
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, "none")
    .replace(/(\s(?:src|href|xlink:href)\s*=\s*)(["'])(?!#)(?:[a-z][a-z0-9+.-]*:|\/\/)[^"']*\2/gi, "$1$2$2");
}

/** Roer's palette as Mermaid's `base` theme takes it; the rest of its colours
 * are derived from these. Read from the page, so a diagram matches the theme
 * on screen. */
function themeVariables(theme: Theme): Record<string, string | boolean> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const dark = theme === "dark";
  return {
    darkMode: dark,
    background: token("--roer-bg", dark ? "#1e1e1e" : "#ffffff"),
    primaryColor: token("--roer-panel", dark ? "#252526" : "#f7f8fa"),
    primaryTextColor: token("--roer-fg", dark ? "#d4d4d4" : "#000000"),
    primaryBorderColor: token("--roer-border", dark ? "#3a3a3c" : "#d3d5db"),
    lineColor: token("--roer-muted", dark ? "#8c8c92" : "#6c707e"),
    textColor: token("--roer-fg", dark ? "#d4d4d4" : "#000000"),
    edgeLabelBackground: token("--roer-bg", dark ? "#1e1e1e" : "#ffffff"),
    fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif",
    fontSize: "13px",
  };
}

