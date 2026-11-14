import { describe, expect, it } from "vitest";

import { endedPins, loadPins, pinTab, savePins } from "./tabPins";

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

describe("tab pins", () => {
  it("pins a tab to a session, and lets it follow again", () => {
    const pinned = pinTab({}, "changes", "s1");
    expect(pinned).toEqual({ changes: "s1" });
    expect(pinTab(pinned, "changes", "s1")).toBe(pinned);
    expect(pinTab(pinned, "changes", null)).toEqual({});
    const none = {};
    expect(pinTab(none, "changes", null)).toBe(none);
  });

  it("are remembered, and forgotten when there are none", () => {
    const storage = memory();
    savePins({ changes: "s1" }, storage);
    expect(loadPins(storage)).toEqual({ changes: "s1" });
    savePins({}, storage);
    expect(storage.getItem("roer:tab-pins")).toBeNull();
    storage.setItem("roer:tab-pins", JSON.stringify({ changes: 4, deck: "s2" }));
    expect(loadPins(storage)).toEqual({ deck: "s2" });
    storage.setItem("roer:tab-pins", "[not json");
    expect(loadPins(storage)).toEqual({});
  });

  it("let go only of sessions seen live that have gone", () => {
    const pins = { changes: "s1", deck: "s2", notes: "s3" };
    expect(endedPins(pins, new Set(["s2"]), new Set(["s1", "s2"]))).toEqual(["changes"]);
  });
});
