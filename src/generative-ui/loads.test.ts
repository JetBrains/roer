import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/backend", () => ({ invoke: mocks.invoke }));

import { parseLoaded, readLoadData, useLiveLoads, type PanelLoad } from "./loads";

const message = (loadData: Record<string, unknown>) => ({ version: "v1.0", loadData });
const ITEM = { surfaceId: "w", path: "/item" };

describe("a loadData message", () => {
  it("is read as a load, or refused with a reason", () => {
    expect(readLoadData({ version: "v1.0", deleteSurface: { surfaceId: "s" } })).toBeUndefined();
    expect(readLoadData(message({ ...ITEM, file: "~/.roer/items.json", as: "json", pick: "/~1r\u0000main/item", every: 2 }))).toEqual({
      ...ITEM,
      file: "~/.roer/items.json",
      as: "json",
      pick: "/~1r\u0000main/item",
      every: 2,
    });
    expect(readLoadData(message({ ...ITEM, run: ["git", "diff"] }))).toEqual({ ...ITEM, run: ["git", "diff"], as: "text" });
    expect(readLoadData(message({ ...ITEM }))).toMatch(/exactly one of run, file/);
    expect(readLoadData(message({ ...ITEM, file: "a", run: ["git"] }))).toMatch(/exactly one of run, file/);
    expect(readLoadData(message({ ...ITEM, file: "a", every: 0.2 }))).toMatch(/every is seconds/);
    expect(readLoadData(message({ ...ITEM, file: "a", pick: "/x" }))).toMatch(/picks from JSON/);
    expect(readLoadData({ version: "v0.9", loadData: { ...ITEM, file: "a" } })).toMatch(/version/);
  });

  it("takes one part of what it read, and null where nothing is there yet", () => {
    const load: PanelLoad = { ...ITEM, as: "json", pick: "/~1r\u0000main/item", file: "f" };
    expect(parseLoaded(load, JSON.stringify({ "/r\u0000main": { item: { title: "T" } } }))).toEqual({ value: { title: "T" } });
    expect(parseLoaded(load, "{}")).toEqual({ value: null });
    expect(parseLoaded(load, "not json")).toEqual({ error: "f is not JSON" });
    expect(parseLoaded({ ...ITEM, as: "text", file: "f" }, "hi")).toEqual({ value: "hi" });
  });
});

describe("live loads in the panel", () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.invoke.mockReset();
  });

  const setUp = (shown: { current: boolean }) => {
    const written: unknown[] = [];
    const hook = renderHook(
      ({ session }) => useLiveLoads((_load, value) => written.push(value), () => shown.current, session),
      { initialProps: { session: "%1" } },
    );
    return { hook, written };
  };
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it("reads again on its own, writes only what changed, and stops when its surface is gone", async () => {
    vi.useFakeTimers();
    let n = 0;
    mocks.invoke.mockImplementation(async () => JSON.stringify({ n: Math.min(++n, 2) }));
    const shown = { current: true };
    const { hook, written } = setUp(shown);
    const load: PanelLoad = { ...ITEM, as: "json", pick: "/n", file: "items.json", every: 2 };

    expect(await hook.result.current.run(load, "/repo")).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("genui_load", { cwd: "/repo", run: null, file: "items.json" });
    expect(written).toEqual([1]);
    await tick(2100);
    expect(written).toEqual([1, 2]);
    await tick(2100);
    // Read again, unchanged: nothing written.
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(written).toEqual([1, 2]);

    shown.current = false;
    await tick(5000);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("stops every live load when the stage moves to another session, and keeps a failed one's last value", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValueOnce("first").mockRejectedValue(new Error("gone"));
    const shown = { current: true };
    const { hook, written } = setUp(shown);
    await hook.result.current.run({ ...ITEM, as: "text", run: ["git", "status"], every: 1 }, "/repo");
    await tick(1100);
    expect(written).toEqual(["first"]);

    const calls = mocks.invoke.mock.calls.length;
    hook.rerender({ session: "%2" });
    await tick(5000);
    expect(mocks.invoke.mock.calls.length).toBe(calls);
  });

  it("says why a load failed, and writes nothing", async () => {
    mocks.invoke.mockRejectedValue(new Error("`git push` is not one a load may run"));
    const { hook, written } = setUp({ current: true });
    expect(await hook.result.current.run({ ...ITEM, as: "text", run: ["git", "push"] }, "/repo")).toMatch(/not one a load may run/);
    expect(written).toEqual([]);
  });
});
