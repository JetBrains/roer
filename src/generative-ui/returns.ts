/**
 * How often the person comes back to a view, per project: someone who keeps
 * asking for the same one would be better served by a tab, which stays in
 * the strip and fetches its own data, and the panel offers that once.
 *
 * Kept in the browser's storage, since it only decides whether to offer;
 * losing it costs no more than the offer coming later.
 */
const KEY = "roer.viewReturns";

/** Visits to one view before the panel offers it as a tab. */
export const VISITS_BEFORE_OFFER = 3;

/** Showings closer together than this are one visit: an agent redrawing a
 * view while it works on it is not the person coming back to it. */
const SAME_VISIT_MS = 30 * 60 * 1000;

interface Visits {
  count: number;
  last: number;
  /** Declined, or already asked for: never offered again. */
  declined?: boolean;
}

const read = (): Record<string, Visits> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Visits>;
  } catch {
    return {};
  }
};

const write = (all: Record<string, Visits>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* Storage is off: the offer just never comes. */
  }
};

const keyOf = (dir: string, surfaceId: string) => `${dir}\n${surfaceId}`;

/** Counts a showing of `surfaceId` in the project at `dir`. */
export function noteShown(dir: string, surfaceId: string, now = Date.now()): void {
  const all = read();
  const key = keyOf(dir, surfaceId);
  const visits = all[key] ?? { count: 0, last: -Infinity };
  if (now - visits.last >= SAME_VISIT_MS) visits.count += 1;
  visits.last = now;
  all[key] = visits;
  write(all);
}

/** Whether to offer `surfaceId` as a tab. */
export function offerTab(dir: string, surfaceId: string): boolean {
  const visits = read()[keyOf(dir, surfaceId)];
  return !!visits && !visits.declined && visits.count >= VISITS_BEFORE_OFFER;
}

/** Stops offering `surfaceId` as a tab: "Not now", or it was asked for. */
export function stopOfferingTab(dir: string, surfaceId: string): void {
  const all = read();
  const key = keyOf(dir, surfaceId);
  all[key] = { ...(all[key] ?? { count: 0, last: -Infinity }), declined: true };
  write(all);
}
