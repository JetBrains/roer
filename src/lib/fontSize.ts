/**
 * How big the terminal's text is, and the code's: a file, a diff. Two
 * sizes rather than one zoom, since the sidebar and the rest of the window
 * are not what people find hard to read. `Cmd+=` and `Cmd+-` step whichever
 * is in front, `Cmd+0` puts it back; kept per browser profile, as the other
 * view preferences are.
 */
import { useSyncExternalStore } from "react";

export type FontArea = "terminal" | "code";

export const DEFAULT_FONT_SIZE: Record<FontArea, number> = { terminal: 14, code: 13 };

const MIN = 9;
const MAX = 28;

const key = (area: FontArea) => `roer:font-size:${area}`;

const clamp = (size: number) => Math.min(MAX, Math.max(MIN, Math.round(size)));

function stored(area: FontArea): number {
  const size = Number(localStorage.getItem(key(area)));
  return Number.isFinite(size) && size > 0 ? clamp(size) : DEFAULT_FONT_SIZE[area];
}

const sizes: Record<FontArea, number> = { terminal: stored("terminal"), code: stored("code") };
const listeners = new Set<() => void>();

/** The code's size as CSS variables, with line heights rounded to whole
 * pixels so rows stay crisp: a file's at 1.5, a diff's a little looser. */
function applyCode(): void {
  const style = document.documentElement.style;
  style.setProperty("--code-font-size", `${sizes.code}px`);
  style.setProperty("--code-line-height", `${Math.round(sizes.code * 1.5)}px`);
  style.setProperty("--diff-line-height", `${Math.round(sizes.code * (5 / 3))}px`);
}
applyCode();

export const fontSize = (area: FontArea): number => sizes[area];

/** Sets `area`'s size, or puts it back on the default with `null`. */
export function setFontSize(area: FontArea, size: number | null): void {
  const next = size === null ? DEFAULT_FONT_SIZE[area] : clamp(size);
  if (next === sizes[area]) return;
  sizes[area] = next;
  if (next === DEFAULT_FONT_SIZE[area]) localStorage.removeItem(key(area));
  else localStorage.setItem(key(area), String(next));
  if (area === "code") applyCode();
  for (const listener of listeners) listener();
}

/** One step bigger or smaller, or back to the default with `0`. */
export const stepFontSize = (area: FontArea, step: 1 | -1 | 0): void =>
  setFontSize(area, step === 0 ? null : sizes[area] + step);

/** Calls `listener` on every change of either size; returns the unsubscribe. */
export function onFontSizeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `area`'s size, re-rendering whenever it changes. */
export const useFontSize = (area: FontArea): number => useSyncExternalStore(onFontSizeChange, () => sizes[area]);
