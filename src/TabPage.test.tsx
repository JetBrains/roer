import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabPage, pinnedOfPage, tabOfPage } from "./TabPage";
import { defineExtension } from "./extensions/api";
import { useActivateTab, useOpenFile, useSession, useStartSession } from "./extensions/context";
import { registry } from "./extensions/registry";

const live = (pane: string, id: string, cwd: string) => ({
  id,
  session: id,
  pane,
  attached: false,
  cwd,
  command: "claude",
  agent: "claude",
});

const mocks = vi.hoisted(() => ({
  sessions: [] as unknown[],
  stage: null as unknown,
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "extensions_list" || cmd === "extensions_disabled") return [];
    if (cmd === "file_read") return { text: "fn main() {}\n", truncated: false };
    if (cmd === "roer_sessions") return mocks.sessions;
    if (cmd === "stage_current") return mocks.stage;
    if (cmd === "git_root") return (_args?.cwd as string) ?? null;
    if (cmd === "git_current_branch") return "main";
    return undefined;
  }),
  reach: vi.fn(async () => "up" as const),
}));

vi.mock("./lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/backend")>()),
  invoke: mocks.invoke,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const set = mocks.listeners.get(event) ?? new Set();
    set.add(handler);
    mocks.listeners.set(event, set);
    return () => set.delete(handler);
  }),
  reachServer: mocks.reach,
}));

/** The server tells the page `event`. */
const tell = (event: string, payload: unknown) =>
  act(() => mocks.listeners.get(event)?.forEach((handler) => handler({ payload })));

function Board() {
  const session = useSession();
  const openFile = useOpenFile();
  const activateTab = useActivateTab();
  const startSession = useStartSession();
  return (
    <div>
      <p data-testid="on">{session ? `on ${session.pane} in ${session.root}` : "no session"}</p>
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

const load = (needsSession = false) =>
  registry.load(
    "board",
    defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "Board", component: Board, needsSession })),
  );

describe("a stage tab as a browser page", () => {
  afterEach(() => {
    registry.unload("board");
    mocks.invoke.mockClear();
    mocks.reach.mockClear();
    mocks.sessions = [];
    mocks.stage = null;
    mocks.listeners.clear();
  });

  it("is asked for by the page's query", () => {
    expect(tabOfPage("?tab=ext%3Aboard%2Fmain")).toBe("ext:board/main");
    expect(tabOfPage("")).toBeNull();
    expect(pinnedOfPage("?tab=changes&pane=%253&id=s3&cwd=%2Frepo")).toEqual({ pane: "%3", id: "s3", cwd: "/repo" });
    expect(pinnedOfPage("?tab=changes")).toBeNull();
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
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("stage_action", expect.objectContaining({ action: expect.objectContaining({ kind: "startSession" }) })));
    const sent = mocks.invoke.mock.calls.find(([cmd, args]) => cmd === "stage_action" && (args as { action: { kind: string } }).action.kind === "startSession")?.[1] as { action: { request: string } };
    tell("roer://stage-action-done", { request: sent.action.request, ok: true });
    expect(await screen.findByText("Started in Roer")).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("stage_action", {
      action: expect.objectContaining({ kind: "startSession", cwd: "/repo", prompt: "review this" }),
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

  it("does not draw a tab that needs a session without one", () => {
    load(true);
    render(<TabPage tabId="ext:board/main" />);
    expect(screen.getByText(/needs a session/)).toBeInTheDocument();
  });

  describe("pinned to a session", () => {
    const pinned = { pane: "%3", id: "s3", cwd: "/work/api" };

    it("gives the tab that session, and names it above", async () => {
      mocks.sessions = [live("%3", "s3", "/work/api")];
      load(true);
      render(<TabPage tabId="ext:board/main" pinned={pinned} />);
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %3 in /work/api"));
      expect(screen.getByText("api · main · claude")).toBeInTheDocument();
    });

    it("says when the session ended, and offers the live ones", async () => {
      mocks.sessions = [live("%4", "s4", "/work/web")];
      load(true);
      render(<TabPage tabId="ext:board/main" pinned={pinned} />);
      expect(await screen.findByText("This session ended.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /claude · web/ }));
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %4 in /work/web"));
    });

    it("is not fooled by a later session reusing the pane number", async () => {
      mocks.sessions = [live("%3", "other", "/work/web")];
      load(true);
      render(<TabPage tabId="ext:board/main" pinned={pinned} />);
      expect(await screen.findByText("This session ended.")).toBeInTheDocument();
    });

    it("follows Roer's stage once asked, and stays where it was when asked to stop", async () => {
      mocks.sessions = [live("%3", "s3", "/work/api"), live("%4", "s4", "/work/web"), live("%5", "s5", "/work/docs")];
      mocks.stage = { pane: "%4", id: "s4", cwd: "/work/web" };
      load(true);
      render(<TabPage tabId="ext:board/main" pinned={pinned} />);
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %3"));

      fireEvent.click(screen.getByRole("button", { name: "Follow Roer" }));
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %4"));
      tell("roer://stage", { pane: "%5", id: "s5", cwd: "/work/docs" });
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %5"));

      fireEvent.click(screen.getByRole("button", { name: "Follow Roer" }));
      expect(screen.getByRole("button", { name: "Follow Roer" })).toHaveAttribute("aria-pressed", "false");
      tell("roer://stage", { pane: "%3", id: "s3", cwd: "/work/api" });
      expect(screen.getByTestId("on")).toHaveTextContent("on %5");
    });

    it("stays on its session when it starts another, and offers the switch", async () => {
      mocks.sessions = [live("%3", "s3", "/work/api"), live("%6", "s6", "/repo")];
      load(true);
      render(<TabPage tabId="ext:board/main" pinned={pinned} />);
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %3"));
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith("stage_action", {
          action: expect.objectContaining({ kind: "startSession", request: expect.any(String) }),
        }),
      );
      const sent = mocks.invoke.mock.calls.find(([cmd]) => cmd === "stage_action")?.[1] as { action: { request: string } };
      tell("roer://stage-action-done", { request: sent.action.request, ok: true });
      expect(await screen.findByText("Started in Roer")).toBeInTheDocument();

      tell("roer://stage", { pane: "%6", id: "s6", cwd: "/repo" });
      expect(screen.getByTestId("on")).toHaveTextContent("on %3");
      fireEvent.click(await screen.findByRole("button", { name: "Switch to the new session" }));
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %6"));
    });

    it("says so when Roer did not start one", async () => {
      mocks.sessions = [live("%3", "s3", "/work/api")];
      load(true);
      render(<TabPage tabId="ext:board/main" pinned={pinned} />);
      await waitFor(() => expect(screen.getByTestId("on")).toHaveTextContent("on %3"));
      fireEvent.click(screen.getByRole("button", { name: "start" }));
      await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("stage_action", expect.anything()));
      const sent = mocks.invoke.mock.calls.find(([cmd]) => cmd === "stage_action")?.[1] as { action: { request: string } };
      tell("roer://stage-action-done", { request: sent.action.request, ok: false });
      expect(await screen.findByText("Roer did not start a session")).toBeInTheDocument();
    });
  });
});
