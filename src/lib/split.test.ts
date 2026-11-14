import { describe, expect, it } from "vitest";

import {
  boundOf,
  boundSide,
  clampRatio,
  closePane,
  dropPane,
  hasPane,
  leaves,
  loadSplit,
  neighbourOf,
  openPane,
  paneOfSide,
  placeOf,
  placePane,
  prune,
  ratioAt,
  rects,
  saveSplit,
  sessionOfPane,
  sessionSide,
  setRatio,
  settle,
  STAGE,
  type Split,
} from "./split";
import { activate, noTabs, openFile } from "./tabs";

const deck = "ext:deck/main";

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

/** The stage with `id` to its right. */
const beside = (id: string, ratio = 0.5, focus = id): Split => ({
  root: { axis: "row", ratio, first: { leaf: STAGE }, second: { leaf: id } },
  focus,
});

describe("openPane", () => {
  it("puts a tab beside the stage, focused, and the stage back on what it had before", () => {
    const tabs = activate(activate(noTabs, "changes"), deck);
    const next = openPane(tabs, null, deck);
    expect(next.split).toEqual(beside(deck));
    expect(next.tabs.active).toBe("changes");
  });

  it("leaves the stage alone when the tab was not on it, and puts the tab first for left or above", () => {
    const next = openPane(noTabs, null, deck, "above");
    expect(next.tabs).toBe(noTabs);
    expect(next.split?.root).toEqual({ axis: "column", ratio: 0.5, first: { leaf: deck }, second: { leaf: STAGE } });
  });

  it("splits the pane with the keyboard, so there can be more than two", () => {
    const two = openPane(noTabs, null, deck).split;
    const three = openPane(noTabs, two, "changes", "below").split;
    expect(three?.root).toEqual({
      axis: "row",
      ratio: 0.5,
      first: { leaf: STAGE },
      second: { axis: "column", ratio: 0.5, first: { leaf: deck }, second: { leaf: "changes" } },
    });
    expect(three?.focus).toBe("changes");
    // Next to the stage, when it is the one asked for.
    const four = openPane(noTabs, three, sessionSide("%1"), "below", STAGE).split;
    expect(leaves(four!.root)).toEqual([STAGE, sessionSide("%1"), deck, "changes"]);
  });

  it("moves a tab that already has a pane, rather than showing it twice", () => {
    const three = openPane(noTabs, openPane(noTabs, null, deck).split, "changes", "below").split;
    const moved = openPane(noTabs, three, deck, "left", STAGE).split;
    expect(leaves(moved!.root)).toEqual([deck, STAGE, "changes"]);
  });

  it("won't give the terminal, the session list or the stage a pane", () => {
    expect(openPane(noTabs, null, "terminal").split).toBeNull();
    expect(openPane(noTabs, null, "sessions").split).toBeNull();
    expect(openPane(noTabs, null, STAGE).split).toBeNull();
  });
});

describe("closing panes", () => {
  const three = openPane(noTabs, openPane(noTabs, null, deck).split, "changes", "below").split;

  it("gives a closed pane's room to its neighbour, and the tab back to the stage", () => {
    const next = closePane(noTabs, three, deck);
    expect(next.split?.root).toEqual({ axis: "row", ratio: 0.5, first: { leaf: STAGE }, second: { leaf: "changes" } });
    expect(next.split?.focus).toBe("changes");
    expect(next.tabs.active).toBe(deck);
  });

  it("ends the split once only the stage is left, focused on it", () => {
    expect(dropPane(dropPane(three, deck), "changes")).toBeNull();
    expect(dropPane(three, "changes")?.focus).toBe(STAGE);
  });

  it("lets a session leave without becoming a tab of the strip", () => {
    const tabs = activate(noTabs, "changes");
    const split = beside(sessionSide("%7"));
    expect(closePane(tabs, split, sessionSide("%7"))).toEqual({ tabs, split: null });
  });

  it("prunes what cannot be drawn, keeping the same split when all of it can", () => {
    expect(prune(three, () => true)).toBe(three);
    expect(leaves(prune(three, (id) => id !== deck)!.root)).toEqual([STAGE, "changes"]);
  });
});

describe("placing a pane", () => {
  const three = openPane(noTabs, openPane(noTabs, null, deck).split, "changes", "below").split;

  it("knows where a pane is and what it is next to", () => {
    expect(placeOf(three, "changes")).toBe("below");
    expect(neighbourOf(three, "changes")).toBe(deck);
    // The stage is beside two panes, not one.
    expect(neighbourOf(three, STAGE)).toBeNull();
    expect(placeOf(three, "nothing")).toBeUndefined();
  });

  it("moves a pane around its neighbour, each keeping its share", () => {
    const split = setRatio(three, "2", 0.3);
    const moved = placePane(split, "changes", "left");
    expect(placeOf(moved, "changes")).toBe("left");
    const inner = moved!.root as { second: { ratio: number } };
    expect(inner.second.ratio).toBeCloseTo(0.7);
  });
});

describe("settle", () => {
  it("focuses a tab with a pane when it is asked for on the stage", () => {
    const next = settle(activate(noTabs, deck), beside(deck, 0.5, STAGE));
    expect(next.tabs.active).toBe("terminal");
    expect(next.split?.focus).toBe(deck);
  });

  it("changes nothing otherwise", () => {
    const split = beside(deck, 0.5, STAGE);
    const tabs = activate(noTabs, "changes");
    expect(settle(tabs, split)).toEqual({ tabs, split });
    expect(settle(tabs, null)).toEqual({ tabs, split: null });
  });
});

describe("rects and ratioAt", () => {
  it("lays every pane and divider out as fractions of the stage", () => {
    const three = setRatio(openPane(noTabs, openPane(noTabs, null, deck).split, "changes", "below").split, "", 0.6);
    const { panes, dividers } = rects(three!.root);
    expect(panes).toEqual([
      { id: STAGE, rect: { x: 0, y: 0, w: 0.6, h: 1 } },
      { id: deck, rect: { x: 0.6, y: 0, w: expect.closeTo(0.4), h: 0.5 } },
      { id: "changes", rect: { x: 0.6, y: 0.5, w: expect.closeTo(0.4), h: 0.5 } },
    ]);
    expect(dividers.map((one) => [one.path, one.axis, one.at])).toEqual([
      ["", "row", 0.6],
      ["2", "column", 0.5],
    ]);
  });

  it("reads a drag as the first half's share of its own split", () => {
    expect(ratioAt("row", { x: 0, y: 0, w: 1, h: 1 }, 0.7)).toBeCloseTo(0.7);
    expect(ratioAt("column", { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0.75)).toBeCloseTo(0.5);
    expect(ratioAt("row", { x: 0, y: 0, w: 1, h: 1 }, 0.01)).toBe(0.15);
  });
});

describe("clampRatio", () => {
  it("keeps both panes usable", () => {
    expect(clampRatio(0.05)).toBe(0.15);
    expect(clampRatio(0.95)).toBe(0.85);
    expect(clampRatio(0.4)).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe("loadSplit and saveSplit", () => {
  it("remember the panes, focused on the stage", () => {
    const storage = memory();
    const split = openPane(noTabs, beside(deck, 0.6), "changes", "below").split!;
    saveSplit(split, storage);
    expect(loadSplit(storage)).toEqual({ ...split, focus: STAGE });
    saveSplit(null, storage);
    expect(loadSplit(storage)).toBeNull();
  });

  it("read a split kept before the stage had panes", () => {
    const storage = memory();
    storage.setItem("roer:split", JSON.stringify({ side: deck, place: "left", ratio: 0.7 }));
    expect(loadSplit(storage)?.root).toEqual({ axis: "row", ratio: expect.closeTo(0.3), first: { leaf: deck }, second: { leaf: STAGE } });
    storage.setItem("roer:split", JSON.stringify({ side: deck, axis: "row", ratio: 0.5 }));
    expect(placeOf(loadSplit(storage), deck)).toBe("right");
  });

  it("forget files and sessions, which won't be there after a restart, and anything unreadable", () => {
    const storage = memory();
    const file = openFile(noTabs, { kind: "file", root: "/r", path: "a.ts" }).active;
    saveSplit(openPane(noTabs, beside(file), sessionSide("%7")).split, storage);
    expect(loadSplit(storage)).toBeNull();
    saveSplit(openPane(noTabs, beside(file), deck).split, storage);
    expect(hasPane(loadSplit(storage), deck)).toBe(true);
    expect(hasPane(loadSplit(storage), file)).toBe(false);
    storage.setItem("roer:split", "{not json");
    expect(loadSplit(storage)).toBeNull();
  });
});

describe("a session's pane", () => {
  it("names its pane, and nothing else does", () => {
    expect(paneOfSide(sessionSide("%7"))).toBe("%7");
    expect(paneOfSide(deck)).toBeUndefined();
    expect(paneOfSide(undefined)).toBeUndefined();
  });
});

describe("a tab that belongs to a session", () => {
  const changes = boundSide("%7", "ext:changes/main");

  it("names its session and its tab, so one tab can be open once for each session", () => {
    expect(boundOf(changes)).toEqual({ pane: "%7", tab: "ext:changes/main" });
    expect(boundOf(boundSide("%8", "ext:changes/main"))?.pane).toBe("%8");
    expect(boundOf(deck)).toBeUndefined();
    expect(sessionOfPane(changes)).toBe("%7");
    expect(sessionOfPane(sessionSide("%7"))).toBe("%7");
    expect(sessionOfPane(deck)).toBeUndefined();
  });

  it("is not the strip's tab: opening it leaves the strip alone, and closing it puts nothing back", () => {
    const tabs = activate(noTabs, "ext:changes/main");
    const opened = openPane(tabs, beside(sessionSide("%7")), changes, "below");
    expect(opened.tabs).toBe(tabs);
    expect(hasPane(opened.split, "ext:changes/main")).toBe(false);
    expect(closePane(tabs, opened.split, changes).tabs).toBe(tabs);
  });

  it("is not brought back on the next launch", () => {
    const storage = memory();
    saveSplit(openPane(noTabs, beside(deck), changes).split, storage);
    expect(leaves(loadSplit(storage)!.root)).toEqual([STAGE, deck]);
  });
});
