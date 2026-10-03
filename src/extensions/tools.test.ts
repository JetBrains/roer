import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke, listen } from "../lib/backend";
import { defineExtension } from "./api";
import { Registry } from "./registry";
import { answer, serveTools, type ExtensionCall } from "./tools";

vi.mock("../lib/backend", () => ({ invoke: vi.fn(), listen: vi.fn() }));

const call = (over: Partial<ExtensionCall> = {}): ExtensionCall => ({
  id: "20261003T120000-1-0",
  extension: "todos",
  tool: "add",
  args: { text: "milk" },
  pane: "%3",
  cwd: "/repo",
  ...over,
});

function withTool(run: (args: Record<string, unknown>, context: unknown) => unknown): Registry {
  const registry = new Registry();
  registry.load(
    "todos",
    defineExtension((roer) => void roer.tools.register({ name: "add", description: "Adds one.", run })),
  );
  return registry;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => (command === "extension_call_claim" ? true : undefined));
  vi.mocked(listen).mockResolvedValue(() => undefined);
});

describe("extension tools", () => {
  it("runs a claimed call and answers with what the tool returned", async () => {
    const run = vi.fn(async () => "Added milk.");
    await answer(call(), withTool(run));
    expect(run).toHaveBeenCalledWith({ text: "milk" }, { pane: "%3", cwd: "/repo" });
    expect(invoke).toHaveBeenLastCalledWith("extension_call_reply", { id: call().id, result: "Added milk.", error: null });
  });

  it("answers with the error a tool threw, or with there being no such tool", async () => {
    await answer(call(), withTool(() => {
      throw new Error("no list here");
    }));
    expect(invoke).toHaveBeenLastCalledWith("extension_call_reply", { id: call().id, result: null, error: "no list here" });

    await answer(call({ tool: "remove" }), withTool(() => "x"));
    expect(invoke).toHaveBeenLastCalledWith("extension_call_reply", {
      id: call().id,
      result: null,
      error: "todos has no tool remove loaded in Roer",
    });
  });

  it("leaves a call another window claimed", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const run = vi.fn();
    await answer(call(), withTool(run));
    expect(run).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("publishes again after a publish failed", async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "extension_tools_publish" && fail) throw new Error("bridge down");
    });
    const registry = withTool(() => "x");
    const stop = serveTools(registry);
    await Promise.resolve();
    await Promise.resolve();
    fail = false;
    vi.mocked(invoke).mockClear();
    // Any change to the registry, even one that leaves the tools as they were.
    registry.load("other", defineExtension(() => undefined));
    expect(invoke).toHaveBeenCalledWith("extension_tools_publish", expect.objectContaining({ tools: expect.any(Array) }));
    stop();
  });

  it("publishes the tools without their handlers, again when they change", () => {
    const registry = withTool(() => "x");
    const stop = serveTools(registry);
    expect(invoke).toHaveBeenCalledWith("extension_tools_publish", {
      tools: [{ extension: "todos", name: "add", description: "Adds one.", inputSchema: { type: "object", properties: {} } }],
    });
    registry.unload("todos");
    expect(invoke).toHaveBeenLastCalledWith("extension_tools_publish", { tools: [] });
    stop();
  });
});
