/**
 * Panes beside the stage: a tree of splits, each pane showing one thing.
 *
 * The stage stays what it was: the terminal with the strip's active tab
 * covering it, in the pane named `STAGE`. Every other pane shows one tab, a
 * file or a live session, and any pane can be split again, to its left,
 * right, above or below. Pure functions over plain values, like `tabs.ts`,
 * so the rules are tested apart from `App`.
 *
 * `App` lays the panes out flat, side by side in one parent, at the places
 * `rects` gives them, rather than nesting them as the tree is: a terminal
 * whose parent changed would remount, and with it its PTY.
 */
import { activate, type Tabs } from "./tabs";

/** Where a pane goes, from the point of view of the pane it is put next to. */
export type SplitPlace = "right" | "left" | "below" | "above";

/** Every place, in the order menus and a pane's header offer them. */
export const SPLIT_PLACES: readonly { place: SplitPlace; label: string }[] = [
  { place: "left", label: "Left of" },
  { place: "right", label: "Right of" },
  { place: "above", label: "Above" },
  { place: "below", label: "Below" },
];

/** "Left of the terminal", "Below Changes". */
export const placeLabel = (place: SplitPlace, of: string): string =>
  `${SPLIT_PLACES.find((one) => one.place === place)!.label} ${of}`;

/** Side by side, or one above the other. */
export const splitAxis = (place: SplitPlace): "row" | "column" =>
  place === "left" || place === "right" ? "row" : "column";

/** Whether the new pane comes first, on the left or on top. */
export const sideFirst = (place: SplitPlace): boolean => place === "left" || place === "above";

/** The pane holding the stage: the terminal and the strip's active tab. */
export const STAGE = "stage";

/** A pane showing one thing, by its `tabId`, or a pane split in two. */
export type Pane =
  | { leaf: string }
  | {
      axis: "row" | "column";
      /** The share of the split the first pane keeps, between the bounds below. */
      ratio: number;
      first: Pane;
      second: Pane;
    };

export interface Split {
  root: Pane;
  /** The pane that takes the keyboard. */
  focus: string;
}

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : 0.5;

/** A live session in a pane: its pane, behind this prefix. Not a tab of the
 * strip, so it never goes back into it. */
const SESSION_SIDE = "session:";
export const sessionSide = (pane: string): string => SESSION_SIDE + pane;
export const paneOfSide = (id: string | undefined): string | undefined =>
  id?.startsWith(SESSION_SIDE) ? id.slice(SESSION_SIDE.length) : undefined;

/** A tab in a pane of its own that belongs to one session rather than
 * following the stage's: the session's pane, then the tab's id. Not the
 * strip's tab either, so the same tab can be open once for each session. */
const BOUND = "bound:";
export const boundSide = (pane: string, tab: string): string => `${BOUND}${pane}|${tab}`;
export function boundOf(id: string | undefined): { pane: string; tab: string } | undefined {
  if (!id?.startsWith(BOUND)) return undefined;
  const rest = id.slice(BOUND.length);
  const at = rest.indexOf("|");
  return at < 0 ? undefined : { pane: rest.slice(0, at), tab: rest.slice(at + 1) };
}
/** The session a pane is about: its own terminal's, or the one its tab belongs to. */
export const sessionOfPane = (id: string | undefined): string | undefined => paneOfSide(id) ?? boundOf(id)?.pane;

/** What may go in a pane of its own: anything but the terminal itself and
 * the session list, which only make sense as the stage. */
export const canSplit = (id: string): boolean => id !== "terminal" && id !== "sessions" && id !== STAGE;

const isLeaf = (pane: Pane): pane is { leaf: string } => "leaf" in pane;

/** Every pane's id, in the order the tree has them. */
export function leaves(pane: Pane): string[] {
  return isLeaf(pane) ? [pane.leaf] : [...leaves(pane.first), ...leaves(pane.second)];
}

/** Whether `id` has a pane of its own. The stage is not counted. */
export const hasPane = (split: Split | null, id: string): boolean =>
  !!split && id !== STAGE && leaves(split.root).includes(id);

/** The tree without `id`'s pane, its neighbour taking the room; null once
 * nothing is left. */
function without(pane: Pane, id: string): Pane | null {
  if (isLeaf(pane)) return pane.leaf === id ? null : pane;
  const first = without(pane.first, id);
  const second = without(pane.second, id);
  if (!first) return second;
  if (!second) return first;
  return first === pane.first && second === pane.second ? pane : { ...pane, first, second };
}

/** `id`'s pane replaced by what `make` makes of it. */
function replace(pane: Pane, id: string, make: (leaf: Pane) => Pane): Pane {
  if (isLeaf(pane)) return pane.leaf === id ? make(pane) : pane;
  const first = replace(pane.first, id, make);
  const second = replace(pane.second, id, make);
  return first === pane.first && second === pane.second ? pane : { ...pane, first, second };
}

/** A split down to the stage alone is no split. */
function settled(root: Pane | null, focus: string): Split | null {
  if (!root || (isLeaf(root) && root.leaf === STAGE)) return null;
  // Without the stage there is nowhere for the terminal: a tree saved by
  // something else, or broken. The stage comes back beside what is left.
  const withStage: Pane = leaves(root).includes(STAGE)
    ? root
    : { axis: "row", ratio: 0.5, first: { leaf: STAGE }, second: root };
  return { root: withStage, focus: leaves(withStage).includes(focus) ? focus : STAGE };
}

/** What the stage shows once `id` has left it: the tab used before it. */
const stageWithout = (tabs: Tabs, id: string): Tabs =>
  tabs.active !== id ? tabs : activate(tabs, tabs.used.find((one) => one !== id) ?? "terminal");

/**
 * Puts `id` in a pane of its own at `place` of the pane `next` (the one with
 * the keyboard, unless said), focused. One that already had a pane moves.
 * The pane it splits keeps half of its room.
 */
export function openPane(
  tabs: Tabs,
  split: Split | null,
  id: string,
  place: SplitPlace = "right",
  next: string = split?.focus ?? STAGE,
): { tabs: Tabs; split: Split | null } {
  if (!canSplit(id)) return { tabs, split };
  const root = (split && without(split.root, id)) ?? { leaf: STAGE };
  const at = next !== id && leaves(root).includes(next) ? next : STAGE;
  const made = replace(root, at, (old): Pane => {
    const added = { leaf: id };
    return sideFirst(place)
      ? { axis: splitAxis(place), ratio: 0.5, first: added, second: old }
      : { axis: splitAxis(place), ratio: 0.5, first: old, second: added };
  });
  return { tabs: stageWithout(tabs, id), split: settled(made, id) };
}

/** Takes `id`'s pane away, its neighbour taking the room, without touching
 * the strip: for a tab, file or session that has gone. */
export function dropPane(split: Split | null, id: string): Split | null {
  if (!split || !hasPane(split, id)) return split;
  return settled(without(split.root, id), split.focus === id ? STAGE : split.focus);
}

/** Takes `id` back from its pane into the strip, on top. A session, or a tab
 * that belongs to one, has no tab of the strip to go back to, so it just leaves. */
export function closePane(tabs: Tabs, split: Split | null, id: string): { tabs: Tabs; split: Split | null } {
  if (!hasPane(split, id)) return { tabs, split };
  return { tabs: sessionOfPane(id) === undefined ? activate(tabs, id) : tabs, split: dropPane(split, id) };
}

/** Shows `to` where `from` was, keeping its place, size and the keyboard; a
 * pane `to` already had goes, its neighbour taking the room. */
export function renamePane(split: Split | null, from: string, to: string): Split | null {
  if (!split || from === to || !hasPane(split, from) || !canSplit(to)) return split;
  const root = without(split.root, to) ?? split.root;
  const renamed = replace(root, from, () => ({ leaf: to }));
  return settled(renamed, split.focus === from ? to : split.focus);
}

/** Keeps the panes whose ids pass `keep`: what can be drawn now. */
export function prune(split: Split | null, keep: (id: string) => boolean): Split | null {
  if (!split) return null;
  const root = leaves(split.root)
    .filter((id) => id !== STAGE && !keep(id))
    .reduce<Pane | null>((pane, id) => (pane ? without(pane, id) : null), split.root);
  return root === split.root ? split : settled(root, split.focus);
}

type Fork = Exclude<Pane, { leaf: string }>;

/** The split `id`'s pane is one half of, and which half. */
function parentOf(pane: Pane, id: string): { parent: Fork; first: boolean } | null {
  if (isLeaf(pane)) return null;
  if (isLeaf(pane.first) && pane.first.leaf === id) return { parent: pane, first: true };
  if (isLeaf(pane.second) && pane.second.leaf === id) return { parent: pane, first: false };
  return parentOf(pane.first, id) ?? parentOf(pane.second, id);
}

/** Where `id`'s pane is, next to the other half of its split. */
export function placeOf(split: Split | null, id: string): SplitPlace | undefined {
  const at = split && parentOf(split.root, id);
  if (!at) return undefined;
  return at.parent.axis === "row" ? (at.first ? "left" : "right") : at.first ? "above" : "below";
}

/** The other half of `id`'s split: one pane's id, or null for several. */
export function neighbourOf(split: Split | null, id: string): string | null | undefined {
  const at = split && parentOf(split.root, id);
  if (!at) return undefined;
  const other = at.first ? at.parent.second : at.parent.first;
  return isLeaf(other) ? other.leaf : null;
}

/** Moves `id`'s pane to `place` of the other half of its split, keeping the
 * share each half has. */
export function placePane(split: Split | null, id: string, place: SplitPlace): Split | null {
  const at = split && parentOf(split.root, id);
  if (!split || !at) return split;
  const { parent } = at;
  const flip = at.first !== sideFirst(place);
  const moved: Fork = {
    axis: splitAxis(place),
    ratio: flip ? 1 - parent.ratio : parent.ratio,
    first: flip ? parent.second : parent.first,
    second: flip ? parent.first : parent.second,
  };
  const swap = (pane: Pane): Pane =>
    pane === parent ? moved : isLeaf(pane) ? pane : { ...pane, first: swap(pane.first), second: swap(pane.second) };
  return { ...split, root: swap(split.root) };
}

/** The split at `path` ("" for the top one, then "1" for a first half and
 * "2" for a second, all the way down) given `ratio`. */
export function setRatio(split: Split | null, path: string, ratio: number): Split | null {
  if (!split) return split;
  const set = (pane: Pane, rest: string): Pane => {
    if (isLeaf(pane)) return pane;
    if (rest === "") return { ...pane, ratio: clampRatio(ratio) };
    return rest[0] === "1"
      ? { ...pane, first: set(pane.first, rest.slice(1)) }
      : { ...pane, second: set(pane.second, rest.slice(1)) };
  };
  return { ...split, root: set(split.root, path) };
}

export const focusOn = (split: Split | null, id: string): Split | null =>
  split && split.focus !== id && leaves(split.root).includes(id) ? { ...split, focus: id } : split;

/** A part of the stage, as fractions of it. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  /** The split's path, as `setRatio` takes it. */
  path: string;
  axis: "row" | "column";
  /** The room the split shares out. */
  box: Rect;
  /** The divider's fraction of the stage along its axis. */
  at: number;
}

/** Where each pane goes, and each split's divider. */
export function rects(root: Pane): { panes: { id: string; rect: Rect }[]; dividers: Divider[] } {
  const panes: { id: string; rect: Rect }[] = [];
  const dividers: Divider[] = [];
  const walk = (pane: Pane, box: Rect, path: string) => {
    if (isLeaf(pane)) {
      panes.push({ id: pane.leaf, rect: box });
      return;
    }
    const row = pane.axis === "row";
    const cut = row ? box.w * pane.ratio : box.h * pane.ratio;
    const first = row ? { ...box, w: cut } : { ...box, h: cut };
    const second = row ? { ...box, x: box.x + cut, w: box.w - cut } : { ...box, y: box.y + cut, h: box.h - cut };
    dividers.push({ path, axis: pane.axis, box, at: row ? box.x + cut : box.y + cut });
    walk(pane.first, first, path + "1");
    walk(pane.second, second, path + "2");
  };
  walk(root, { x: 0, y: 0, w: 1, h: 1 }, "");
  return { panes, dividers };
}

/** The share of `box` the first half keeps for a divider dragged to `at`,
 * the pointer's fraction of the stage along the split's axis. */
export const ratioAt = (axis: "row" | "column", box: Rect, at: number): number =>
  clampRatio(axis === "row" ? (at - box.x) / box.w : (at - box.y) / box.h);

/**
 * Keeps one tab in one place. Asking for a tab that has a pane of its own on
 * the stage (its strip button, Cmd+number, `useActivateTab`) focuses it
 * where it already is, and the stage goes back to what it showed.
 */
export function settle(tabs: Tabs, split: Split | null): { tabs: Tabs; split: Split | null } {
  if (!split || !hasPane(split, tabs.active)) return { tabs, split };
  return { tabs: stageWithout(tabs, tabs.active), split: focusOn(split, tabs.active) };
}

const KEY = "roer:split";

function readPane(raw: unknown, depth = 0): Pane | null {
  if (!raw || typeof raw !== "object" || depth > 16) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.leaf === "string") return { leaf: value.leaf };
  const first = readPane(value.first, depth + 1);
  const second = readPane(value.second, depth + 1);
  if (!first || !second || (value.axis !== "row" && value.axis !== "column")) return null;
  return { axis: value.axis, ratio: clampRatio(Number(value.ratio)), first, second };
}

/** The panes as they were left, if they were. Which tabs had panes is kept
 * too: an extension's tab comes back once the extension loads. Files,
 * sessions and the tabs that belong to them are not brought back: any of
 * them may be long gone. */
export function loadSplit(storage: Pick<Storage, "getItem"> = localStorage): Split | null {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    let root = readPane(value.root);
    // One tab beside the stage, as it was kept before the stage had panes.
    if (!root && typeof value.side === "string") {
      const place = SPLIT_PLACES.some((one) => one.place === value.place) ? (value.place as SplitPlace) : "right";
      const side = { leaf: value.side };
      const ratio = clampRatio(Number(value.ratio));
      root = sideFirst(place)
        ? { axis: splitAxis(place), ratio: 1 - ratio, first: side, second: { leaf: STAGE } }
        : { axis: splitAxis(place), ratio, first: { leaf: STAGE }, second: side };
    }
    return prune(settled(root, STAGE), (id) => canSplit(id) && !id.startsWith("file:") && sessionOfPane(id) === undefined);
  } catch {
    return null;
  }
}

export function saveSplit(split: Split | null, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (!split) storage.removeItem(KEY);
    else storage.setItem(KEY, JSON.stringify({ root: split.root }));
  } catch {
    // Storage is a convenience; panes that aren't remembered still work.
  }
}
