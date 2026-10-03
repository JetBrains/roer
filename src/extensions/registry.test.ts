import { describe, expect, it, vi } from "vitest";

import { defineExtension } from "./api";
import { Registry } from "./registry";

const View = () => null;

describe("Registry", () => {
  it("namespaces an extension's tab, but not a bundled one's", () => {
    const registry = new Registry();
    registry.load("todos", defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "TODOs", component: View })));
    registry.load(
      "changes",
      defineExtension((roer) => void roer.stage.registerTab({ id: "changes", title: "Changes", component: View, order: 20 })),
      { bundled: true },
    );

    expect(registry.tabs().map((tab) => tab.tabId)).toEqual(["changes", "ext:todos/main"]);
    expect(registry.tabs()[1]).toMatchObject({ order: 100, needsSession: true, keepAcrossSessions: false });
  });

  it("keeps a badge the new version sets as it activates, on a reload too", () => {
    const registry = new Registry();
    const version = (text: string) =>
      defineExtension((roer) => {
        roer.stage.registerTab({ id: "main", title: "TODOs", component: View });
        roer.badge.set("main", text);
      });
    registry.load("todos", version("1"));
    registry.load("todos", version("2"));
    expect(registry.badgesByTab().get("ext:todos/main")).toBe("2");
    registry.unload("todos");
    expect(registry.badgesByTab().size).toBe(0);
  });

  it("keeps the version that works when a new one throws", () => {
    const registry = new Registry();
    registry.load("todos", defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "v1", component: View })));

    expect(() =>
      registry.load(
        "todos",
        defineExtension((roer) => {
          roer.stage.registerTab({ id: "main", title: "v2", component: View });
          throw new Error("broken");
        }),
      ),
    ).toThrow("broken");
    expect(registry.tabs().map((tab) => tab.title)).toEqual(["v1"]);
  });

  it("disposes the old version, last first, once the new one is in", () => {
    const registry = new Registry();
    const calls: string[] = [];
    registry.load(
      "todos",
      defineExtension((roer) => {
        roer.stage.registerTab({ id: "main", title: "v1", component: View });
        return () => calls.push("cleanup v1");
      }),
    );
    const before = registry.tabs()[0].generation;

    registry.load(
      "todos",
      defineExtension((roer) => {
        calls.push("activate v2");
        roer.stage.registerTab({ id: "main", title: "v2", component: View });
      }),
    );

    expect(calls).toEqual(["activate v2", "cleanup v1"]);
    expect(registry.tabs().map((tab) => tab.title)).toEqual(["v2"]);
    expect(registry.tabs()[0].generation).toBeGreaterThan(before);
  });

  it("drops a tab's badge with the tab", () => {
    const registry = new Registry();
    registry.load(
      "todos",
      defineExtension((roer) => {
        roer.stage.registerTab({ id: "main", title: "TODOs", component: View });
        roer.badge.set("main", "3");
      }),
    );
    expect(registry.badgesByTab().get("ext:todos/main")).toBe("3");

    registry.unload("todos");
    expect(registry.badgesByTab().size).toBe(0);
    expect(registry.tabs()).toEqual([]);
  });

  it("tells its subscribers, and hands them the same snapshot until something changes", () => {
    const registry = new Registry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const empty = registry.tabs();
    expect(registry.tabs()).toBe(empty);

    registry.load("todos", defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "TODOs", component: View })));
    expect(listener).toHaveBeenCalled();
    expect(registry.tabs()).not.toBe(empty);
  });
});
