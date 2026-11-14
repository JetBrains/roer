/**
 * Tabs pinned to a session. A tab that needs a session follows the one you
 * work in (the terminal clicked last) unless it is pinned here, by the
 * session's id rather than its pane, so a pin survives the session being
 * attached again.
 */
export type TabPins = Readonly<Record<string, string>>;

const KEY = "roer:tab-pins";

export function loadPins(storage: Pick<Storage, "getItem"> = localStorage): TabPins {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function savePins(pins: TabPins, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (Object.keys(pins).length === 0) storage.removeItem(KEY);
    else storage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // A pin that isn't remembered still holds until the app quits.
  }
}

export const pinTab = (pins: TabPins, tab: string, session: string | null): TabPins => {
  if (session === null) {
    if (!(tab in pins)) return pins;
    const { [tab]: _gone, ...rest } = pins;
    return rest;
  }
  return pins[tab] === session ? pins : { ...pins, [tab]: session };
};

/**
 * The pins whose session has ended: of those seen live before, the ones no
 * longer listed. A pin whose session was never seen in this run (kept from
 * before a restart) waits for the list instead of being dropped on an empty one.
 */
export function endedPins(pins: TabPins, live: ReadonlySet<string>, seen: ReadonlySet<string>): string[] {
  return Object.entries(pins)
    .filter(([, session]) => !live.has(session) && seen.has(session))
    .map(([tab]) => tab);
}
