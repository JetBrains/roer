/**
 * Comments on a view's parts, for the session's agent, in threads it answers. Off, the view is only the view: parts
 * with threads carry a count, which opens them. In Comment mode (the toggle in the view's corner, Esc to leave) a
 * click picks the part under it instead of pressing it — any component, by the id `GenerativeSurface` marks it with,
 * or a whole `Commentable` group — Shift-click adds more, and one comment is about all of them.
 *
 * The threads are Roer's (`lib/threads`), kept per repository and view. A view drawn where there is no repository
 * to keep them with (another app's chat) has no toggle and no counts.
 */
import { useCommentsOn } from "../lib/experimental";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { ThreadCards, ThreadComposer, useClaimSessions, useThreadPeople, useThreadSender } from "../Threads";
import { useViewThreads, type Thread } from "../lib/threads";

interface Part {
  id: string;
  label: string;
}

/** A box over a part, relative to the scope. */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** "a", "a and b", "a, b and c". */
const names = (parts: readonly { label?: string; id: string }[]) => {
  const all = parts.map((one) => one.label || one.id);
  return all.length <= 1 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
};

const partsOf = (thread: Thread) =>
  thread.anchors.flatMap((a) => (a.kind === "part" ? [{ id: a.id, ...(a.label ? { label: a.label } : {}) }] : []));

/** The parts directly inside `part`, not inside one of those. */
const childParts = (part: HTMLElement) =>
  [...part.querySelectorAll<HTMLElement>("[data-part]")].filter((one) => one.parentElement?.closest("[data-part]") === part);

/** The part a click or a pointer is on: the `Commentable` group around it when there is one; else the innermost
 * component, or the one around it while it is that one's only child (a button's label is the button). */
function partAt(target: EventTarget | null, within: HTMLElement): Part | null {
  if (!(target instanceof Element) || !within.contains(target)) return null;
  const found = target.closest<HTMLElement>("[data-part-group]") ?? target.closest<HTMLElement>("[data-part]");
  if (!found || !within.contains(found) || !found.dataset.part) return null;
  let marked: HTMLElement = found;
  if (!marked.hasAttribute("data-part-group")) {
    for (;;) {
      const up: HTMLElement | null | undefined = marked.parentElement?.closest<HTMLElement>("[data-part]");
      if (!up || !within.contains(up) || childParts(up).length !== 1) break;
      marked = up;
    }
  }
  return { id: marked.dataset.part!, label: marked.dataset.partLabel || marked.dataset.part! };
}

/** Where a part is drawn. Its wrapper takes no box (`display: contents`), so this is the box of what is in it. */
function boxOf(id: string, within: HTMLElement): Box | null {
  const marked = [...within.querySelectorAll<HTMLElement>("[data-part]")].find((one) => one.dataset.part === id);
  if (!marked) return null;
  const range = document.createRange();
  range.selectNodeContents(marked);
  // Not every engine measures a range (jsdom does not); then the part is not drawn over.
  if (typeof range.getBoundingClientRect !== "function") return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const outer = within.getBoundingClientRect();
  return { top: rect.top - outer.top, left: rect.left - outer.left, width: rect.width, height: rect.height };
}

export function CommentScope({
  root,
  view,
  title,
  children,
}: {
  root: string | null;
  view: string;
  title?: string;
  children: ReactNode;
}) {
  const on = useCommentsOn();
  const people = useThreadPeople();
  const threads = useViewThreads(root, view);
  const sender = useThreadSender(people);
  useClaimSessions(threads, people.sessions ?? []);

  const [commenting, setCommenting] = useState(false);
  const [picked, setPicked] = useState<Part[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The part whose threads are open, from its count; null shows every thread while commenting. */
  const [open, setOpen] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const stop = useCallback(() => {
    setCommenting(false);
    setPicked([]);
    setHovered(null);
  }, []);

  useEffect(() => {
    if (!commenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commenting, stop]);

  // In Comment mode a click picks; it never reaches the view's buttons and fields.
  const onClickCapture = (event: MouseEvent) => {
    if (!commenting || !boxRef.current) return;
    if ((event.target as Element).closest(".gen-comments, .gen-comment-toggle, .gen-comment-count")) return;
    event.preventDefault();
    event.stopPropagation();
    const part = partAt(event.target, boxRef.current);
    if (!part) return;
    const extend = event.shiftKey || event.metaKey;
    setPicked((current) =>
      !extend ? [part] : current.some((one) => one.id === part.id) ? current.filter((one) => one.id !== part.id) : [...current, part],
    );
    setOpen(null);
  };

  // Counts on every part a thread is about, and outlines on what is picked, hovered or tied to the open thread.
  const counts = useMemo(() => {
    const at = new Map<string, { open: number; all: number; label?: string }>();
    for (const thread of threads) {
      for (const part of partsOf(thread)) {
        const slot = at.get(part.id) ?? { open: 0, all: 0, label: part.label };
        slot.all += 1;
        if (thread.state === "open") slot.open += 1;
        at.set(part.id, slot);
      }
    }
    return at;
  }, [threads]);
  const shown = useMemo(
    () => (open ? threads.filter((thread) => partsOf(thread).some((part) => part.id === open)) : threads),
    [open, threads],
  );
  const linked = useMemo(() => {
    const ids = new Set<string>();
    if (open) for (const thread of shown) for (const part of partsOf(thread)) ids.add(part.id);
    return ids;
  }, [open, shown]);

  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const wanted = useMemo(
    () => [...new Set([...counts.keys(), ...picked.map((one) => one.id), ...(hovered ? [hovered] : []), ...linked])],
    [counts, picked, hovered, linked],
  );
  const measure = useCallback(() => {
    const within = boxRef.current;
    if (!within) return;
    const next = new Map<string, Box>();
    for (const id of wanted) {
      const box = boxOf(id, within);
      if (box) next.set(id, box);
    }
    // The same boxes keep the same map, so measuring after a render does not render again.
    setBoxes((last) => {
      const same =
        last.size === next.size &&
        [...next].every(([id, box]) => {
          const was = last.get(id);
          return !!was && was.top === box.top && was.left === box.left && was.width === box.width && was.height === box.height;
        });
      return same ? last : next;
    });
  }, [wanted]);
  useLayoutEffect(measure, [measure, children]);
  useEffect(() => {
    const within = boxRef.current;
    if (!within || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(within);
    return () => watch.disconnect();
  }, [measure]);

  if (!root || !on) return <>{children}</>;

  const outline = (id: string, kind: string) => {
    const box = boxes.get(id);
    return box ? <div key={`${kind}:${id}`} className={`gen-part-outline ${kind}`} style={box} /> : null;
  };

  return (
    <div
      ref={boxRef}
      className={commenting ? "gen-comment-scope commenting" : "gen-comment-scope"}
      onClickCapture={onClickCapture}
      // A press on the view picks, so it must not take the keys from the comment box or select its text.
      onMouseDownCapture={(event) => {
        if (commenting && !(event.target as Element).closest(".gen-comments, .gen-comment-toggle, .gen-comment-count")) {
          event.preventDefault();
        }
      }}
      onMouseOver={(event) => commenting && boxRef.current && setHovered(partAt(event.target, boxRef.current)?.id ?? null)}
      onMouseLeave={() => setHovered(null)}
    >
      <button
        type="button"
        className="gen-comment-toggle"
        aria-pressed={commenting}
        title={commenting ? "Stop commenting (Esc)" : "Comment on parts of this view, for the session's agent"}
        onClick={() => (commenting ? stop() : setCommenting(true))}
      >
        {commenting ? "Done" : "Comment"}
      </button>

      {children}

      {/* Drawn over the view, not in it, so the view's own layout is untouched. */}
      <div className="gen-part-overlays" aria-hidden>
        {commenting && hovered && !picked.some((one) => one.id === hovered) ? outline(hovered, "hovered") : null}
        {picked.map((one) => outline(one.id, "picked"))}
        {[...linked].map((id) => outline(id, "linked"))}
      </div>
      {[...counts].map(([id, count]) => {
        const box = boxes.get(id);
        if (!box) return null;
        return (
          <button
            key={`count:${id}`}
            type="button"
            className="gen-comment-count"
            style={{ top: box.top - 8, left: box.left + box.width - 10 }}
            aria-pressed={open === id}
            aria-label={`${count.open} open of ${count.all} ${count.all === 1 ? "thread" : "threads"} on ${count.label ?? id}`}
            onClick={() => setOpen(open === id ? null : id)}
          >
            {count.open > 0 ? count.open : "✓"}
          </button>
        );
      })}

      {commenting || open ? (
        <div className="gen-comments">
          {picked.length > 0 ? (
            <ThreadComposer
              root={root}
              sender={sender}
              name={names(picked)}
              onSubmit={(text) => {
                const started = sender.start({
                  root,
                  view,
                  ...(title ? { viewTitle: title } : {}),
                  anchors: picked.map((one) => ({ kind: "part", id: one.id, label: one.label })),
                  text,
                });
                setPicked([]);
                setOpen(partsOf(started).at(-1)?.id ?? null);
              }}
              onCancel={() => setPicked([])}
            />
          ) : commenting ? (
            <p className="gen-text muted">Click a part to comment on it; Shift-click to add more. Esc when done.</p>
          ) : null}
          <ThreadCards threads={shown} sender={sender} name={(thread) => names(partsOf(thread))} />
        </div>
      ) : null}
    </div>
  );
}
