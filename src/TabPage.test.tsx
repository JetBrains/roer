import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabPage, tabOfPage } from "./TabPage";
import { defineExtension } from "./extensions/api";
import { useActivateTab, useOpenFile, useStartSession } from "./extensions/context";
import { registry } from "./extensions/registry";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "extensions_list" || cmd === "extensions_disabled") return [];
    if (cmd === "file_read") return { text: "fn main() {}\n", truncated: false };
    return undefined;
  }),
  reach: vi.fn(async () => "up" as const),
}));

vi.mock("./lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/backend")>()),
  invoke: mocks.invoke,
  listen: vi.fn(async () => () => undefined),
  reachServer: mocks.reach,
}));

function Board() {
  const openFile = useOpenFile();
  const activateTab = useActivateTab();
  const startSession = useStartSession();
  return (
    <div>
      <button type="button" onClick={() => openFile("/repo", "src/main.rs", 1)}>
        open file
      </button>
      <button type="button" onClick={() => activateTab("terminal")}>
        to terminal
      </button>
      <button type="button" onClick={() => void startSession?.("/repo", "review this")}>
        start
      </button>
    </div>
  );
}

const load = () =>
  registry.load(
    "board",
    defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "Board", component: Board, needsSession: false })),
  );

describe("a stage tab as a browser page", () => {
  afterEach(() => {
    registry.unload("board");
    mocks.invoke.mockClear();
    mocks.reach.mockClear();
  });

  it("is asked for by the page's query", () => {
    expect(tabOfPage("?tab=ext%3Aboard%2Fmain")).toBe("ext:board/main");
    expect(tabOfPage("")).toBeNull();
  });

  it("opens a file beside the tab, in the page itself", async () => {
    load();
    render(<TabPage tabId="ext:board/main" />);
    fireEvent.click(screen.getByRole("button", { name: "open file" }));
    expect(await screen.findByText("main.rs")).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("stage_action", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("main.rs")).not.toBeInTheDocument();
  });

  it("hands everything else to the Roer window and says so", async () => {
    load();
    render(<TabPage tabId="ext:board/main" />);
    fireEvent.click(screen.getByRole("button", { name: "to terminal" }));
    expect(await screen.findByText("Shown in Roer")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("stage_action", { action: { kind: "activateTab", tabId: "terminal" } });

    fireEvent.click(screen.getByRole("button", { name: "start" }));
    expect(await screen.findByText("Started in Roer")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("stage_action", {
      action: { kind: "startSession", cwd: "/repo", prompt: "review this", pickAgent: undefined },
    });
  });

  it("says when Roer can no longer be reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.reach.mockResolvedValue("down" as never);
      load();
      render(<TabPage tabId="ext:board/main" />);
      await act(async () => void vi.advanceTimersByTime(3500));
      await waitFor(() => expect(screen.getByText(/Roer can't be reached/)).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
      mocks.reach.mockResolvedValue("up" as never);
    }
  });

  it("does not draw a tab that needs a session", () => {
    registry.load(
      "board",
      defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "Board", component: Board, needsSession: true })),
    );
    render(<TabPage tabId="ext:board/main" />);
    expect(screen.getByText(/needs a session/)).toBeInTheDocument();
  });
});
