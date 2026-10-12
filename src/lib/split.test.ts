import { describe, expect, it } from "vitest";

import { clampRatio, closeSide, loadSplit, openSide, ratioAt, saveSplit, settle, type Split } from "./split";
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

describe("openSide", () => {
  it("puts a tab beside the stage, focused, and the stage back on what it had before", () => {
    const tabs = activate(activate(noTabs, "changes"), deck);
    const next = openSide(tabs, null, deck);
    expect(next.split).toEqual({ side: deck, place: "right", ratio: 0.5, focus: "side" });
    expect(next.tabs.active).toBe("changes");
  });

  it("leaves the stage alone when the tab was not on it", () => {
    const next = openSide(noTabs, null, deck, "below");
    expect(next.tabs).toBe(noTabs);
    expect(next.split?.place).toBe("below");
  });

  it("replaces the side tab and keeps the split's place and size", () => {
    const split: Split = { side: "changes", place: "below", ratio: 0.3, focus: "main" };
    expect(openSide(noTabs, split, deck).split).toEqual({ side: deck, place: "below", ratio: 0.3, focus: "side" });
  });

  it("won't put the terminal or the session list beside itself", () => {
    expect(openSide(noTabs, null, "terminal").split).toBeNull();
    expect(openSide(noTabs, null, "sessions").split).toBeNull();
  });
});

describe("settle", () => {
  it("focuses the side tab when it is asked for on the stage", () => {
    const split: Split = { side: deck, place: "right", ratio: 0.5, focus: "main" };
    const next = settle(activate(noTabs, deck), split);
    expect(next.tabs.active).toBe("terminal");
    expect(next.split?.focus).toBe("side");
  });

  it("changes nothing otherwise", () => {
    const split: Split = { side: deck, place: "right", ratio: 0.5, focus: "main" };
    const tabs = activate(noTabs, "changes");
    expect(settle(tabs, split)).toEqual({ tabs, split });
    expect(settle(tabs, null)).toEqual({ tabs, split: null });
  });
});

describe("closeSide", () => {
  it("puts the side tab back on the stage", () => {
    const split: Split = { side: deck, place: "right", ratio: 0.5, focus: "side" };
    const next = closeSide(noTabs, split);
    expect(next.split).toBeNull();
    expect(next.tabs.active).toBe(deck);
  });
});

describe("ratioAt", () => {
  it("gives the terminal the share on its side of the divider", () => {
    expect(ratioAt("right", 0.7)).toBeCloseTo(0.7);
    expect(ratioAt("below", 0.3)).toBeCloseTo(0.3);
    expect(ratioAt("left", 0.3)).toBeCloseTo(0.7);
    expect(ratioAt("above", 0.25)).toBeCloseTo(0.75);
    expect(ratioAt("above", 0.01)).toBe(0.8);
  });
});

describe("clampRatio", () => {
  it("keeps both panes usable", () => {
    expect(clampRatio(0.05)).toBe(0.2);
    expect(clampRatio(0.95)).toBe(0.8);
    expect(clampRatio(0.4)).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe("loadSplit and saveSplit", () => {
  it("remember the split, focused on the stage", () => {
    const storage = memory();
    saveSplit({ side: deck, place: "below", ratio: 0.6, focus: "side" }, storage);
    expect(loadSplit(storage)).toEqual({ side: deck, place: "below", ratio: 0.6, focus: "main" });
    saveSplit(null, storage);
    expect(loadSplit(storage)).toBeNull();
  });

  it("open on the right a split saved without a place it knows", () => {
    const storage = memory();
    storage.setItem("roer:split", JSON.stringify({ side: deck, axis: "row", ratio: 0.5 }));
    expect(loadSplit(storage)?.place).toBe("right");
  });

  it("forget a file, which won't be open after a restart, and anything unreadable", () => {
    const storage = memory();
    const file = openFile(noTabs, { kind: "file", root: "/r", path: "a.ts" }).active;
    saveSplit({ side: file, place: "right", ratio: 0.5, focus: "side" }, storage);
    expect(loadSplit(storage)).toBeNull();
    storage.setItem("roer:split", "{not json");
    expect(loadSplit(storage)).toBeNull();
  });
});
