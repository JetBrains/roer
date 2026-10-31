/**
 * The viewer's own layout of the stage's tab strip: the order they dragged
 * the tabs into, and the Workspaces and Projects a tab is kept to.
 *
 * Order is one for every Workspace, so Cmd+3 means the same tab wherever you
 * are; where a tab is shown is per Workspace or Project, since which tabs are
 * worth the room depends on the work. Both live in localStorage, as hidden
 * Workspace sections do: how one lays out one's screen is one's own business,
 * not the Workspace's.
 */

const ORDER_KEY = "roer:tab-order";

/** Where a Workspace or Project's hidden tabs are kept: `kind:id`. */
export const scopeKeyOf = (scope: { kind: string; id: string } | null | undefined): string | null =>
  scope ? `${scope.kind}:${scope.id}` : null;

/**
 * `tabs` in the saved `order`.
 *
 * Only the places the saved tabs already hold are reshuffled: a tab the saved
 * order has never seen (one just installed) keeps the place its own `order`
 * gives it, and the ones that are saved fill their own places in the order
 * they were dragged into. So a new tab never pushes the arranged ones around,
 * and one that is gone leaves no hole.
 */
export function arrange<T extends { tabId: string }>(tabs: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, at) => [id, at]));
  const saved = tabs.filter((tab) => rank.has(tab.tabId)).sort((a, b) => rank.get(a.tabId)! - rank.get(b.tabId)!);
  let next = 0;
  return tabs.map((tab) => (rank.has(tab.tabId) ? saved[next++] : tab));
}

/**
 * The order to save once `id` is put just `side` of `target`, both among
 * `ids` (every movable tab, hidden ones too, as the strip arranges them).
 * Every one of them is written down, so the result no longer depends on
 * anyone's `order`. A `target` that is not there leaves the order as it was.
 */
export function place(ids: readonly string[], id: string, target: string, side: "before" | "after"): string[] {
  const rest = ids.filter((one) => one !== id);
  const at = rest.indexOf(target);
  if (rest.length === ids.length || at < 0) return [...ids];
  const to = side === "before" ? at : at + 1;
  return [...rest.slice(0, to), id, ...rest.slice(to)];
}

function read<T>(key: string, fallback: T, valid: (value: unknown) => boolean): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    return valid(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* only a convenience */
  }
}

const isStrings = (value: unknown) => Array.isArray(value) && value.every((one) => typeof one === "string");

export const loadOrder = (): string[] => read(ORDER_KEY, [], isStrings);
export const saveOrder = (order: readonly string[]) => write(ORDER_KEY, order);

const ONLY_KEY = "roer:only-tabs";

/**
 * The Workspaces and Projects a tab is kept to, by tab id, as `kind:id`
 * (`scopeKeyOf`). A tab with no entry is shown everywhere; one with an entry
 * only there. Hiding a tab in one Workspace is the same list without that one.
 */
export type Only = Readonly<Record<string, readonly string[]>>;

export const loadOnly = (): Only =>
  read(ONLY_KEY, {}, (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as object).every(isStrings));
export const saveOnly = (only: Only) => write(ONLY_KEY, only);

/** `only` with `id` kept to `places`; none, or null, is everywhere again. */
export function setPlaces(only: Only, id: string, places: readonly string[] | null): Only {
  const next: Record<string, readonly string[]> = { ...only };
  if (!places || places.length === 0) delete next[id];
  else next[id] = [...new Set(places)];
  return next;
}

/**
 * Whether a tab is on the strip `where`. With nothing selected (`where`
 * null) every tab is, since there is no Workspace to be particular about.
 */
export function shownIn(id: string, where: string | null, only: Only): boolean {
  if (where === null) return true;
  const places = only[id];
  return !places || places.includes(where);
}
