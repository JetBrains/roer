/**
 * A tab shown beside the stage rather than on top of it.
 *
 * The stage stays what it was: the terminal with the strip's active tab
 * covering it. The split adds one pane next to it for another tab, so an
 * extension, the Changes tab or a file can stay in view while you work in
 * the terminal. Pure functions over plain values, like `tabs.ts`, so the
 * rules are tested apart from `App`.
 */
import { activate, type Tabs } from "./tabs";

/** Where the side pane is, from the terminal's point of view. */
export type SplitPlace = "right" | "left" | "below" | "above";

/** Every place, in the order the side pane's header offers them. */
export const SPLIT_PLACES: readonly { place: SplitPlace; label: string }[] = [
  { place: "left", label: "Left of the terminal" },
  { place: "right", label: "Right of the terminal" },
  { place: "above", label: "Above the terminal" },
  { place: "below", label: "Below the terminal" },
];

/** Side by side, or one above the other. */
export const splitAxis = (place: SplitPlace): "row" | "column" =>
  place === "left" || place === "right" ? "row" : "column";

/** Whether the side pane comes first, on the left or on top. */
export const sideFirst = (place: SplitPlace): boolean => place === "left" || place === "above";

export interface Split {
  /** The `tabId` in the side pane. */
  side: string;
  place: SplitPlace;
  /** The share of the stage the main pane keeps, between the bounds below. */
  ratio: number;
  /** Which pane takes the keyboard. */
  focus: "main" | "side";
}

export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : 0.5;

/** The tabs that may go beside the stage: anything but the terminal itself and
 * the session list, which only make sense as the stage. */
export const canSplit = (id: string): boolean => id !== "terminal" && id !== "sessions";

/** What the main pane shows once `side` has left it: the tab used before it. */
const mainWithout = (tabs: Tabs, side: string): Tabs =>
  tabs.active !== side ? tabs : activate(tabs, tabs.used.find((id) => id !== side) ?? "terminal");

/**
 * Puts `id` beside the stage, focused. A tab already there is replaced, and
 * the place and size of the split are kept, so swapping what is beside the
 * terminal doesn't move the divider: the terminal keeps its share.
 */
export function openSide(
  tabs: Tabs,
  split: Split | null,
  id: string,
  place: SplitPlace = split?.place ?? "right",
): { tabs: Tabs; split: Split | null } {
  if (!canSplit(id)) return { tabs, split };
  return {
    tabs: mainWithout(tabs, id),
    split: { side: id, place, ratio: split?.ratio ?? 0.5, focus: "side" },
  };
}

/**
 * The terminal's share for a divider dragged to `at`, the pointer's fraction
 * of the stage along the split's axis.
 */
export const ratioAt = (place: SplitPlace, at: number): number => clampRatio(sideFirst(place) ? 1 - at : at);

/**
 * Keeps one tab in one pane. Asking for the side tab on the stage (its strip
 * button, Cmd+number, `useActivateTab`) focuses it where it already is, and
 * the stage goes back to what it showed.
 */
export function settle(tabs: Tabs, split: Split | null): { tabs: Tabs; split: Split | null } {
  if (!split || tabs.active !== split.side) return { tabs, split };
  return { tabs: mainWithout(tabs, split.side), split: { ...split, focus: "side" } };
}

/** Takes the side tab back into the strip, on top. */
export function closeSide(tabs: Tabs, split: Split | null): { tabs: Tabs; split: null } {
  return { tabs: split ? activate(tabs, split.side) : tabs, split: null };
}

const KEY = "roer:split";

/** The split as it was left, if it was. Which tab was beside the stage is kept
 * too: an extension's tab comes back once the extension loads. */
export function loadSplit(storage: Pick<Storage, "getItem"> = localStorage): Split | null {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const { side, place, ratio } = raw as Record<string, unknown>;
    if (typeof side !== "string" || !canSplit(side) || side.startsWith("file:")) return null;
    return {
      side,
      place: SPLIT_PLACES.some((one) => one.place === place) ? (place as SplitPlace) : "right",
      ratio: clampRatio(Number(ratio)),
      focus: "main",
    };
  } catch {
    return null;
  }
}

export function saveSplit(split: Split | null, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (!split) storage.removeItem(KEY);
    else storage.setItem(KEY, JSON.stringify({ side: split.side, place: split.place, ratio: split.ratio }));
  } catch {
    // Storage is a convenience; a split that isn't remembered still works.
  }
}
