/**
 * A diagram written in Mermaid, drawn by the `mermaid` package in Roer's own
 * page. The source is the truth: the view only draws it, and whatever the
 * person says about a node goes back to whoever wrote the source, who changes
 * it and sends it again.
 *
 * `mermaid` is big, so it is imported the first time a diagram is drawn
 * rather than with the app. It runs in its `strict` security level: labels
 * are sanitized, and `click` directives in the source bind nothing.
 */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { NoteCard } from "../DiffNote";
import { currentTheme, onThemeChange, type Theme } from "../lib/theme";

import { Button, EmptyState, Expandable, Text, TextField, type Common } from "./components";
import type { DiagramFile, DiagramThread } from "./workItem";

export type { DiagramFile, DiagramThread };

/** What the person did on a diagram: started a thread on a node, replied in
 * one, or resolved or reopened one. */
export interface DiagramComment {
  action: "comment" | "reply" | "resolve" | "reopen";
  /** The node's id in the source (`A` in `A[Start] --> B`), or the edge's. */
  node: string;
  /** Its text on screen. */
  label: string;
  /** The thread a reply, resolve or reopen is about. */
  thread?: string;
  /** What they wrote, for a comment or a reply. */
  text?: string;
}

type MermaidApi = typeof import("mermaid").default;

let loading: Promise<MermaidApi> | undefined;
const loadMermaid = (): Promise<MermaidApi> => (loading ??= import("mermaid").then((m) => m.default));

/** `mermaid` keeps one configuration for the page, so drawings take turns:
 * one diagram's theme must not leak into another's that is being drawn. */
let queue: Promise<unknown> = Promise.resolve();

async function draw(id: string, source: string, theme: Theme): Promise<string> {
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
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "layout"],
    });
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  queue = turn.catch(() => {});
  return turn;
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

/** The elements a click can be about: a node, a subgraph, a sequence
 * diagram's actor, an edge's label. */
const NODE = "g.node, g.cluster, [data-id]";

/**
 * A node's id in the source, from the element drawn for it. Sequence
 * diagrams, clusters and edges carry it as `data-id`; flowchart, class and
 * state nodes only in their DOM id, as `<svg id>-flowchart-A-0`.
 */
export function nodeIdOf(element: Element, svgId: string): string {
  const dataId = element.getAttribute("data-id");
  if (dataId) return dataId;
  let id = element.id;
  if (id.startsWith(`${svgId}-`)) id = id.slice(svgId.length + 1);
  const drawn = /^(?:flowchart|classId|agentflow|state|entity)-(.+)-\d+$/.exec(id);
  return drawn ? drawn[1] : id;
}

/** An element's text on screen, without the count a badge adds to it. */
function labelOf(element: Element): string {
  let text = "";
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(".gen-mermaid-badge")) text += ` ${node.textContent ?? ""}`;
  }
  return text.replace(/\s+/g, " ").trim();
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** What the person did that the threads they were given don't show yet. It
 * is shown at once, and dropped as soon as new threads arrive: those are the
 * owner's answer to it. */
interface Pending {
  /** The threads this was done over, as JSON. */
  base: string;
  started: { node: string; text: string }[];
  replies: Record<string, string[]>;
  states: Record<string, DiagramThread["state"]>;
}

const nothingPending = (base: string): Pending => ({ base, started: [], replies: {}, states: {} });

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** `view` scaled by `factor` about a point of the viewport, so what is under
 * the pointer stays under it. */
export function zoomAbout(view: View, factor: number, px: number, py: number): View {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/**
 * Pan and zoom for what `viewport` shows: a pinch on a trackpad, or ⌘/Ctrl
 * and the wheel, zooms about the pointer; once zoomed in, scrolling or a drag
 * on the background pans. At its fitted size the wheel is left to the page,
 * so a diagram in a long panel does not trap its scrolling.
 *
 * WebKit, which Roer's window is, reports a pinch as `gesture*` events rather
 * than the ctrl-wheel Chromium sends, so both are taken.
 */
function useZoom(viewport: RefObject<HTMLDivElement | null>, ready: boolean) {
  const [view, setView] = useState<View>(FIT);
  // The wheel must decide at once whether it is ours to take, before the
  // page scrolls, so it reads the view from here rather than from state.
  const current = useRef(view);
  current.current = view;
  const dragged = useRef(false);

  useEffect(() => {
    const el = viewport.current;
    if (!el || !ready) return;
    const at = (e: { clientX: number; clientY: number }) => {
      const box = el.getBoundingClientRect();
      return [e.clientX - box.left, e.clientY - box.top] as const;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // A trackpad's pinch comes as many small deltas, a mouse's notch as
        // one big one: capped, a notch is a step and a pinch is smooth.
        const delta = Math.max(-50, Math.min(50, e.deltaY));
        const [px, py] = at(e);
        setView((v) => zoomAbout(v, Math.exp(-delta * 0.01), px, py));
        return;
      }
      if (current.current.scale <= 1) return;
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    let gestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const factor = g.scale / gestureScale;
      gestureScale = g.scale;
      const [px, py] = at(g);
      setView((v) => zoomAbout(v, factor, px, py));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [viewport, ready]);

  // A drag pans; one that moved swallows the click that ends it, so letting
  // go over a node does not open its threads.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let last = start;
    dragged.current = false;
    const target = e.currentTarget;
    const move = (m: PointerEvent) => {
      if (!dragged.current && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 4) return;
      if (!dragged.current) target.setPointerCapture?.(e.pointerId);
      dragged.current = true;
      const dx = m.clientX - last.x;
      const dy = m.clientY - last.y;
      last = { x: m.clientX, y: m.clientY };
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const zoomBy = (factor: number) => {
    const el = viewport.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    setView((v) => zoomAbout(v, factor, w / 2, h / 2));
  };

  /** Whether the click that just ended was the end of a drag; asking clears it. */
  const wasDrag = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };

  return { view, onPointerDown, zoomBy, reset: () => setView(FIT), wasDrag };
}

/** How far past its own size a diagram is blown up to fill the room: a few
 * nodes fill it at twice their size, not with letters an inch tall. */
const MAX_FIT = 2;
/** Kept free under the diagram in the panel, for the line under it and the
 * panel's own links. */
const BELOW = 96;
const MIN_HEIGHT = 240;

/** The height a diagram in `viewport` may take: down to the bottom of the
 * panel it is in, or most of the window elsewhere (an extension's tab). */
function roomBelow(viewport: HTMLElement): number {
  const panel = viewport.closest<HTMLElement>(".gen-tab");
  if (!panel) return Math.max(MIN_HEIGHT, window.innerHeight * 0.72);
  const top = viewport.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
  return Math.max(MIN_HEIGHT, panel.clientHeight - top - BELOW);
}

/**
 * Sizes the drawn SVG to fill what it has: the full width of `viewport` and
 * the height left under it, whichever runs out first, larger than mermaid
 * drew it if there is room. Returns the viewport's height, so the diagram
 * leaves no empty band under it. Refits as the panel resizes.
 *
 * Zoom is applied here too, as the SVG's size rather than a CSS `scale()`:
 * WebKit draws a scaled layer at its unscaled size and stretches the bitmap,
 * so a diagram zoomed that way blurs.
 */
function useFit(
  viewport: RefObject<HTMLDivElement | null>,
  canvas: RefObject<HTMLDivElement | null>,
  svg: string | null,
  zoom: number,
) {
  const [height, setHeight] = useState<number | undefined>(undefined);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const refit = useRef(() => {});
  useEffect(() => {
    const el = viewport.current;
    const drawn = canvas.current?.querySelector("svg");
    const box = drawn?.viewBox?.baseVal;
    if (!el || !drawn || !box || box.width <= 0 || box.height <= 0) return;
    const fit = () => {
      const scale = Math.min(el.clientWidth / box.width, roomBelow(el) / box.height, MAX_FIT);
      if (!(scale > 0)) return;
      drawn.style.maxWidth = "none";
      drawn.style.width = `${box.width * scale * zoomNow.current}px`;
      drawn.style.height = `${box.height * scale * zoomNow.current}px`;
      setHeight(box.height * scale);
    };
    refit.current = fit;
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    const panel = el.closest(".gen-tab");
    if (panel) observer.observe(panel);
    return () => {
      observer.disconnect();
      refit.current = () => {};
    };
  }, [viewport, canvas, svg]);
  useEffect(() => refit.current(), [zoom]);
  return height;
}

const YOU = "You";

export function Mermaid({
  source,
  title,
  notes = [],
  files = [],
  onComment,
  onOpenFile,
  ...common
}: Common & {
  source: string;
  title?: string;
  /** Conversations pinned to nodes, as their owner keeps them. */
  notes?: DiagramThread[];
  /** Lets the person comment on a node: a click (or Enter on it) opens its
   * threads under the diagram, with a box for a new one. Without it the
   * diagram is only drawn, threads and all. */
  onComment?: (comment: DiagramComment) => void;
  /** The project files each node is made of, listed in its panel. */
  files?: DiagramFile[];
  /** Opens one of `files`; without it they are only named. */
  onOpenFile?: (path: string) => void;
}) {
  const baseId = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [theme, setTheme] = useState<Theme>(currentTheme);
  // Each drawing gets an id of its own: before drawing, `mermaid.render`
  // removes whatever element already has the id it is given, which would be
  // the drawing on screen. Its nodes' DOM ids start with it, so it is kept
  // with the markup.
  const [drawing, setDrawing] = useState<{ svg: string; id: string } | null>(null);
  const draws = useRef(0);
  const svg = drawing?.svg ?? null;
  const svgId = drawing?.id ?? baseId;
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const canvas = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const zoom = useZoom(viewport, svg !== null);
  const height = useFit(viewport, canvas, svg, zoom.view.scale);

  const notesKey = JSON.stringify(notes);
  const [ownPending, setPending] = useState<Pending>(() => nothingPending(notesKey));
  const pending = ownPending.base === notesKey ? ownPending : nothingPending(notesKey);

  // The threads as the person sees them: the owner's, with what they have
  // done since laid over.
  const threads = useMemo<(DiagramThread & { sending?: boolean })[]>(
    () => [
      ...notes.map((thread) => ({
        ...thread,
        state: pending.states[thread.id] ?? thread.state,
        replies: [...thread.replies, ...(pending.replies[thread.id] ?? []).map((text) => ({ author: YOU, text }))],
      })),
      ...pending.started.map((start, i) => ({
        id: `pending-${i}`,
        node: start.node,
        author: YOU,
        text: start.text,
        replies: [],
        state: "open" as const,
        sending: true,
      })),
    ],
    [notes, pending],
  );

  const open = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) if (thread.state === "open") counts.set(thread.node, (counts.get(thread.node) ?? 0) + 1);
    return counts;
  }, [threads]);

  useEffect(() => onThemeChange(setTheme), []);

  useEffect(() => {
    if (source.trim() === "") return;
    let cancelled = false;
    const id = `${baseId}d${++draws.current}`;
    draw(id, source, theme).then(
      (drawn) => {
        if (cancelled) return;
        setDrawing({ svg: drawn, id });
        setError(null);
      },
      (e: unknown) => {
        if (cancelled) return;
        setDrawing(null);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [baseId, source, theme]);

  // The SVG is mermaid's markup, not React's: once it is in the page, mark
  // what can be commented on, so it can be reached with Tab and named, and
  // badge the nodes that have open threads.
  useEffect(() => {
    const root = canvas.current;
    if (!root || !svg) return;
    const found: Record<string, string> = {};
    for (const element of root.querySelectorAll(NODE)) {
      const label = labelOf(element);
      if (!label) continue;
      const node = nodeIdOf(element, svgId);
      found[node] ??= label;
      const count = open.get(node) ?? 0;
      element.classList.toggle("gen-mermaid-has-notes", count > 0);
      element.querySelector(":scope > .gen-mermaid-badge")?.remove();
      if (count > 0) badge(element, count);
      if (!onComment) continue;
      element.setAttribute("tabindex", "0");
      element.setAttribute("role", "button");
      element.setAttribute(
        "aria-label",
        count > 0 ? `Comment on ${label}, ${count} open ${count === 1 ? "thread" : "threads"}` : `Comment on ${label}`,
      );
      element.classList.add("gen-mermaid-target");
      element.classList.toggle("gen-mermaid-selected", node === selected);
    }
    setLabels((was) => (JSON.stringify(was) === JSON.stringify(found) ? was : found));
  }, [svg, svgId, onComment, open, selected]);

  if (source.trim() === "") return <EmptyState {...common} text="No diagram." />;

  const pick = (from: EventTarget | null) => {
    if (!onComment || !(from instanceof Element)) return;
    const element = from.closest(NODE);
    if (!element || !canvas.current?.contains(element) || !labelOf(element)) return;
    setSelected(nodeIdOf(element, svgId));
  };

  const labelFor = (node: string) => labels[node] ?? node;

  const act = (comment: Omit<DiagramComment, "label">) => {
    onComment?.({ ...comment, label: labelFor(comment.node) });
    setPending((was) => {
      const now = was.base === notesKey ? was : nothingPending(notesKey);
      if (comment.action === "comment") {
        return { ...now, started: [...now.started, { node: comment.node, text: comment.text ?? "" }] };
      }
      if (comment.action === "reply" && comment.thread) {
        const sent = [...(now.replies[comment.thread] ?? []), comment.text ?? ""];
        return { ...now, replies: { ...now.replies, [comment.thread]: sent } };
      }
      if (comment.thread) {
        return { ...now, states: { ...now.states, [comment.thread]: comment.action === "resolve" ? "resolved" : "open" } };
      }
      return now;
    });
  };

  const unresolved = [...open.keys()];

  return (
    <div {...common} className="gen-mermaid">
      {title ? <Text variant="h3">{title}</Text> : null}
      {/* What is open on the diagram is pinned to the bottom of the view
          (see .gen-mermaid-side): a tall diagram must not push it out of
          sight. */}
      <div className="gen-mermaid-body">
        <div className="gen-mermaid-main">
          {error !== null ? (
            <div className="gen-mermaid-error" role="alert">
              <p className="error">Mermaid could not draw this diagram: {error}</p>
              <pre>{source}</pre>
            </div>
          ) : svg === null ? (
            <EmptyState text="Drawing the diagram…" variant="loading" />
          ) : (
            <div
              ref={viewport}
              className={zoom.view === FIT ? "gen-mermaid-viewport" : "gen-mermaid-viewport zoomed"}
              onPointerDown={zoom.onPointerDown}
              style={height === undefined ? undefined : { height }}
            >
              <div
                ref={canvas}
                className="gen-mermaid-canvas"
                // As wide as the viewport times the zoom, so the SVG centred
                // in it lands where a scale about the corner would put it.
                style={{ width: `${zoom.view.scale * 100}%`, transform: `translate(${zoom.view.x}px, ${zoom.view.y}px)` }}
                onClick={(e) => {
                  if (!zoom.wasDrag()) pick(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  pick(e.target);
                }}
                // Sanitized by mermaid itself under `securityLevel: "strict"`.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
              <div className="gen-mermaid-zoom" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" className="gen-button borderless" aria-label="Zoom out" onClick={() => zoom.zoomBy(1 / 1.25)}>
                  −
                </button>
                <button type="button" className="gen-button borderless" aria-label="Reset zoom" onClick={zoom.reset}>
                  {`${Math.round(zoom.view.scale * 100)}%`}
                </button>
                <button type="button" className="gen-button borderless" aria-label="Zoom in" onClick={() => zoom.zoomBy(1.25)}>
                  +
                </button>
              </div>
            </div>
          )}
        </div>
        {selected !== null && onComment ? (
          <div className="gen-mermaid-side">
            <NodeThreads
              key={selected}
              label={labelFor(selected)}
              threads={threads.filter((thread) => thread.node === selected)}
              files={files.filter((file) => file.node === selected).map((file) => file.path)}
              onOpenFile={onOpenFile}
              onClose={() => setSelected(null)}
              onAct={(comment) => act({ ...comment, node: selected })}
            />
          </div>
        ) : svg !== null && unresolved.length > 0 ? (
          <div className="gen-mermaid-open">
            <span className="muted">Open threads:</span>
            {unresolved.map((node) => (
              <Button key={node} variant="borderless" onClick={onComment ? () => setSelected(node) : undefined}>
                {`${labelFor(node)} · ${open.get(node)}`}
              </Button>
            ))}
          </div>
        ) : onComment && svg !== null ? (
          <p className="gen-mermaid-hint muted">Click a node to comment on it. Pinch or ⌘-scroll to zoom, drag to pan.</p>
        ) : null}
      </div>
    </div>
  );
}

/** A count in a dot on the node's top-right corner, drawn into the SVG so it
 * moves and scales with the node. Needs layout, so a page without it (a
 * test's) gets only the class. */
function badge(element: Element, count: number) {
  if (!(element instanceof SVGGraphicsElement) || typeof element.getBBox !== "function") return;
  const box = element.getBBox();
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "gen-mermaid-badge");
  g.setAttribute("aria-hidden", "true");
  g.setAttribute("transform", `translate(${box.x + box.width - 2}, ${box.y + 2})`);
  // Inline, since mermaid's own stylesheet is keyed by the SVG's id and
  // outranks any class of ours.
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", "8");
  dot.setAttribute("style", "fill: var(--roer-warn); stroke: none");
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("style", "fill: var(--roer-bg); font-size: 10px; font-weight: 600; stroke: none");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.textContent = String(count);
  g.append(dot, text);
  element.append(g);
}

/** One node's threads, open ones first, and a box to start another. */
function NodeThreads({
  label,
  threads,
  files,
  onOpenFile,
  onClose,
  onAct,
}: {
  label: string;
  threads: (DiagramThread & { sending?: boolean })[];
  files: string[];
  onOpenFile?: (path: string) => void;
  onClose: () => void;
  onAct: (comment: Omit<DiagramComment, "label" | "node">) => void;
}) {
  const [draft, setDraft] = useState("");
  const live = threads.filter((thread) => thread.state === "open");
  const resolved = threads.filter((thread) => thread.state === "resolved");

  const start = () => {
    const text = draft.trim();
    if (text === "") return;
    onAct({ action: "comment", text });
    setDraft("");
  };

  return (
    <div className="gen-mermaid-threads" role="region" aria-label={`Threads on ${label}`}>
      <div className="gen-mermaid-threads-head">
        <Text variant="h4">{label}</Text>
        <Button variant="borderless" onClick={onClose}>
          Close
        </Button>
      </div>
      {files.length > 0 ? (
        <ul className="gen-mermaid-files" aria-label={`Files of ${label}`}>
          {files.map((path) => (
            <li key={path}>
              {onOpenFile ? (
                <button type="button" className="link" onClick={() => onOpenFile(path)}>
                  {path}
                </button>
              ) : (
                <code>{path}</code>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {live.map((thread) => (
        <Thread key={thread.id} thread={thread} onAct={onAct} />
      ))}
      {resolved.length > 0 ? (
        <Expandable title={`${resolved.length} resolved`}>
          {resolved.map((thread) => (
            <Thread key={thread.id} thread={thread} onAct={onAct} />
          ))}
        </Expandable>
      ) : null}
      <div className="gen-mermaid-comment">
        <TextField
          label={`New comment on ${label}`}
          variant="longText"
          value={draft}
          onChange={(v) => setDraft(String(v))}
        />
        <div className="gen-row">
          <Button variant="primary" onClick={start} disabled={draft.trim() === ""}>
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

function Thread({
  thread,
  onAct,
}: {
  thread: DiagramThread & { sending?: boolean };
  onAct: (comment: Omit<DiagramComment, "label" | "node">) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const resolved = thread.state === "resolved";

  const reply = () => {
    const text = draft.trim();
    if (text === "") return;
    onAct({ action: "reply", thread: thread.id, text });
    setDraft("");
    setReplying(false);
  };

  return (
    <div className={resolved ? "gen-mermaid-thread resolved" : "gen-mermaid-thread"}>
      <NoteCard
        note={{
          path: "",
          id: thread.id,
          author: thread.author || "Agent",
          text: thread.text,
          replies: thread.replies,
          ...(thread.sending ? { tag: "sending" } : resolved ? { tag: "resolved" } : {}),
        }}
      />
      {thread.sending ? null : replying ? (
        <div className="gen-mermaid-comment">
          <TextField label="Reply" variant="longText" value={draft} onChange={(v) => setDraft(String(v))} />
          <div className="gen-row">
            <Button variant="primary" onClick={reply} disabled={draft.trim() === ""}>
              Reply
            </Button>
            <Button variant="borderless" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="gen-row">
          {resolved ? null : <Button onClick={() => setReplying(true)}>Reply</Button>}
          <Button
            variant="borderless"
            onClick={() => onAct({ action: resolved ? "reopen" : "resolve", thread: thread.id })}
          >
            {resolved ? "Reopen" : "Resolve"}
          </Button>
        </div>
      )}
    </div>
  );
}
