/**
 * How a coloured line is drawn, shared by the diff and the file viewer.
 *
 * Both get their colour from `lib/highlight` as `Span[]` — from a grammar or
 * from the regex fallback — so both draw it the same way, and a change to one
 * cannot leave the two views disagreeing about what a keyword looks like.
 */
import { memo, type CSSProperties } from "react";

import type { Span } from "./lib/highlight";

/** Colour from a grammar, which names it outright. */
export function look(span: Span): CSSProperties | undefined {
  if (!span.color && !span.italic && !span.bold) return undefined;
  return {
    color: span.color,
    fontStyle: span.italic ? "italic" : undefined,
    fontWeight: span.bold ? "bold" : undefined,
  };
}

/** Colour from `paint`, which names a kind and lets CSS decide. */
export function classes(span: Span): string | undefined {
  const names = [span.kind ? `t-${span.kind}` : "", span.marked ? "ink" : ""].filter(Boolean);
  return names.length > 0 ? names.join(" ") : undefined;
}

/**
 * A row of coloured spans.
 *
 * Memoised because it is drawn thousands of times and is not cheap: in the
 * diff every keystroke that steps a hunk re-renders the whole thing, and in
 * the viewer every scroll re-renders the window. Both keep their span arrays
 * stable across those renders so this can hold.
 */
export const Spans = memo(function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <span key={i} className={classes(span)} style={look(span)}>
          {span.text}
        </span>
      ))}
    </>
  );
});
