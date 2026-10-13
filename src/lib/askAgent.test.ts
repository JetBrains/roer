import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetAskAgent, useAskAgent, type AgentState } from "./askAgent";
import { sendToSession } from "./github";
import { noteTyped } from "./pty";

vi.mock("./github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github")>()),
  sendToSession: vi.fn().mockResolvedValue(undefined),
}));

const asking = (agentState: AgentState, pane = "%1") =>
  renderHook(({ state, at }) => useAskAgent(at, state), { initialProps: { state: agentState, at: pane } });

describe("useAskAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAskAgent();
  });

  it("sends at once to an agent waiting at an empty prompt", async () => {
    const { result } = asking("done");
    await act(async () => expect(await result.current.ask("hi")).toBe("sent"));
    expect(sendToSession).toHaveBeenCalledWith("%1", "hi");
  });

  it("holds requests while the agent works and sends one per turn", async () => {
    const { result, rerender } = asking("working");
    await act(async () => {
      expect(await result.current.ask("one")).toBe("held");
      expect(await result.current.ask("two")).toBe("held");
    });
    expect(result.current.held).toHaveLength(2);

    rerender({ state: "done", at: "%1" });
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(1));
    expect(sendToSession).toHaveBeenLastCalledWith("%1", "one");
    // Still "done" until the agent picks it up: the second must not be typed
    // onto the first.
    rerender({ state: "done", at: "%1" });
    expect(sendToSession).toHaveBeenCalledTimes(1);

    rerender({ state: "working", at: "%1" });
    rerender({ state: "done", at: "%1" });
    await waitFor(() => expect(sendToSession).toHaveBeenLastCalledWith("%1", "two"));
    expect(result.current.held).toHaveLength(0);
  });

  it("holds the same request once, however often it is asked", async () => {
    const { result } = asking("working", "%7");
    await act(async () => {
      await result.current.ask("make it a tab");
      await result.current.ask("make it a tab");
    });
    expect(result.current.held).toHaveLength(1);
  });

  it("waits while the person has a draft in the agent's prompt", async () => {
    const { result, rerender } = asking("working");
    await act(async () => void (await result.current.ask("hi")));
    noteTyped("%1", Date.now() + 1);
    rerender({ state: "done", at: "%1" });
    expect(result.current.ready).toBe(false);
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("keeps a request for its own pane", async () => {
    const { result, rerender } = asking("working", "%5");
    await act(async () => void (await result.current.ask("hi")));
    rerender({ state: "done", at: "%2" });
    expect(sendToSession).not.toHaveBeenCalled();
    rerender({ state: "done", at: "%5" });
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%5", "hi"));
  });
});
