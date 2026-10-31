import { describe, expect, it } from "vitest";

import { arrange, place, scopeKeyOf, setPlaces, shownIn } from "./stripLayout";

const tabs = (...ids: string[]) => ids.map((tabId) => ({ tabId }));
const ids = (list: { tabId: string }[]) => list.map((tab) => tab.tabId);

describe("arrange", () => {
  it("keeps the default order with nothing saved", () => {
    expect(ids(arrange(tabs("sessions", "terminal", "a", "b"), []))).toEqual(["sessions", "terminal", "a", "b"]);
  });

  it("puts saved tabs in the saved order, in their own places", () => {
    expect(ids(arrange(tabs("sessions", "terminal", "a", "b", "c"), ["c", "a", "b"]))).toEqual([
      "sessions",
      "terminal",
      "c",
      "a",
      "b",
    ]);
  });

  it("leaves a tab the order never saw where its own order puts it", () => {
    expect(ids(arrange(tabs("a", "new", "b"), ["b", "a"]))).toEqual(["b", "new", "a"]);
  });

  it("ignores saved tabs that are gone", () => {
    expect(ids(arrange(tabs("a", "b"), ["gone", "b", "a"]))).toEqual(["b", "a"]);
  });
});

describe("place", () => {
  it("moves a tab before or after another", () => {
    expect(place(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(place(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(place(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
  });

  it("leaves the order alone for an unknown tab or target", () => {
    expect(place(["a", "b"], "x", "a", "before")).toEqual(["a", "b"]);
    expect(place(["a", "b"], "a", "x", "before")).toEqual(["a", "b"]);
  });
});

describe("setPlaces and shownIn", () => {
  it("keeps a tab to its places, and shows it everywhere again with none", () => {
    const only = setPlaces({}, "a", ["workspace:w", "workspace:w"]);
    expect(only).toEqual({ a: ["workspace:w"] });
    expect(shownIn("a", "workspace:w", only)).toBe(true);
    expect(shownIn("a", "workspace:x", only)).toBe(false);
    expect(shownIn("b", "workspace:x", only)).toBe(true);
    expect(setPlaces(only, "a", [])).toEqual({});
    expect(setPlaces(only, "a", null)).toEqual({});
  });

  it("shows every tab with nothing selected", () => {
    expect(shownIn("a", null, { a: ["workspace:w"] })).toBe(true);
  });

  it("keys a scope by kind and id", () => {
    expect(scopeKeyOf({ kind: "workspace", id: "w1" })).toBe("workspace:w1");
    expect(scopeKeyOf(null)).toBeNull();
  });
});
