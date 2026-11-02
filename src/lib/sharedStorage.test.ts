import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handler: { current: undefined as undefined | ((event: { payload: { key: string; value: string | null } }) => void) },
}));

vi.mock("./backend", () => ({
  invoke: mocks.invoke,
  listen: vi.fn(async (_event: string, handler: typeof mocks.handler.current) => {
    mocks.handler.current = handler;
    return () => undefined;
  }),
}));

/** A fresh copy of the module: it keeps what it loaded in module state. */
const fresh = async () => {
  vi.resetModules();
  return import("./sharedStorage");
};

describe("shared storage", () => {
  afterEach(() => {
    localStorage.clear();
    mocks.invoke.mockReset();
    mocks.handler.current = undefined;
  });

  it("is the page's own localStorage where the backend keeps none", async () => {
    mocks.invoke.mockRejectedValue(new Error("unknown command"));
    const { loadSharedStorage, sharedStorage } = await fresh();
    await loadSharedStorage();
    sharedStorage.setItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
    expect(sharedStorage.getItem("k")).toBe("v");
  });

  it("reads what the backend keeps, writes there, and hears other views' changes", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "shared_state_all" ? { a: "1" } : undefined));
    const { loadSharedStorage, onSharedStorage, sharedStorage } = await fresh();
    await loadSharedStorage();
    expect(sharedStorage.getItem("a")).toBe("1");

    const heard: string[] = [];
    onSharedStorage((key) => heard.push(key));
    sharedStorage.setItem("b", "2");
    expect(mocks.invoke).toHaveBeenCalledWith("shared_state_set", { key: "b", value: "2" });
    expect(localStorage.getItem("b")).toBeNull();

    mocks.handler.current?.({ payload: { key: "a", value: null } });
    expect(sharedStorage.getItem("a")).toBeNull();
    expect(heard).toEqual(["b", "a"]);
  });

  it("moves what was kept here once the store has loaded, when asked before it had", async () => {
    localStorage.setItem("roer:review:x", "mine");
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "shared_state_all" ? {} : undefined));
    const { adoptLocal, loadSharedStorage, sharedStorage } = await fresh();
    // As an extension does: activated on import, before main.tsx loads the store.
    adoptLocal("roer:review:");
    const loaded = loadSharedStorage();
    adoptLocal("roer:review:");
    await loaded;
    expect(sharedStorage.getItem("roer:review:x")).toBe("mine");
    expect(mocks.invoke).toHaveBeenCalledWith("shared_state_set", { key: "roer:review:x", value: "mine" });
    expect(localStorage.getItem("roer:review:x")).toBeNull();
  });

  it("moves what this page kept itself into the shared store, keeping what is there already", async () => {
    localStorage.setItem("roer:review:x", "mine");
    localStorage.setItem("roer:review:a", "stale");
    localStorage.setItem("other", "kept");
    mocks.invoke.mockImplementation(async (cmd: string) =>
      cmd === "shared_state_all" ? { "roer:review:a": "shared" } : undefined,
    );
    const { adoptLocal, loadSharedStorage, sharedStorage } = await fresh();
    await loadSharedStorage();
    adoptLocal("roer:review:");
    expect(sharedStorage.getItem("roer:review:x")).toBe("mine");
    expect(sharedStorage.getItem("roer:review:a")).toBe("shared");
    expect(localStorage.getItem("roer:review:x")).toBeNull();
    expect(localStorage.getItem("other")).toBe("kept");
  });
});
