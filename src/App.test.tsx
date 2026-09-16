import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  ackHandoff,
  claimHandoff,
  closePty,
  failHandoff,
  listSessions,
  pendingHandoffs,
  spawnPty,
} from "./lib/pty";
import type { Handoff, PtyEvent } from "./lib/pty";

// Shared between the test body and the hoisted module mock below.
const mocks = vi.hoisted(() => ({
  handoffHandlers: [] as Array<(handoff: unknown) => void>,
  // The onEvent callback the component handed to spawnPty, so a test can
  // push PTY output through it.
  emit: { current: undefined as undefined | ((event: unknown) => void) },
}));

// xterm.js measures real glyphs, which jsdom cannot do, so the terminal
// itself is stubbed; these tests cover the React shell around it.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock("./lib/pty", () => ({
  spawnPty: vi.fn(
    async (
      _args: readonly string[],
      _cwd: string | undefined,
      _size: unknown,
      onEvent: (event: unknown) => void,
    ) => {
      mocks.emit.current = onEvent;
      return "pty-1";
    },
  ),
  writePty: vi.fn(async () => undefined),
  resizePty: vi.fn(async () => undefined),
  closePty: vi.fn(async () => undefined),
  decodeOutput: vi.fn(() => new Uint8Array([0x68, 0x69])),
  listSessions: vi.fn(async () => []),
  roerStatus: vi.fn(async () => ({ bin: "roer", available: true, home: "/Users/test" })),
  pendingHandoffs: vi.fn(async () => []),
  // The backend renames the record; the frontend only passes the new path on.
  claimHandoff: vi.fn(async (record: string) => `${record}.claimed`),
  ackHandoff: vi.fn(async () => undefined),
  failHandoff: vi.fn(async () => undefined),
  onHandoff: vi.fn(async (handler: (handoff: unknown) => void) => {
    mocks.handoffHandlers.push(handler);
    return () => undefined;
  }),
}));

const handoff: Handoff = {
  args: ["attach", "%3"],
  cwd: "/Users/test/project",
  label: "roer",
  record: "/Users/test/.roer/handoffs/20260101T000000-1.json",
};

/** What the app holds after claiming a record: the renamed path. */
const claimed = (record: Handoff = handoff) => `${record.record}.claimed`;

/** Deliver a handoff the way the backend watcher would. */
async function teleport(record: Handoff = handoff) {
  await waitFor(() => expect(mocks.handoffHandlers.length).toBeGreaterThan(0));
  await act(async () => {
    for (const handler of mocks.handoffHandlers) handler(record);
  });
}

/** Push one PTY event to the mounted terminal. */
async function emit(event: PtyEvent) {
  await waitFor(() => expect(mocks.emit.current).toBeDefined());
  await act(async () => {
    mocks.emit.current?.(event);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handoffHandlers.length = 0;
  mocks.emit.current = undefined;
});

describe("App", () => {
  it("opens on the launcher rather than a terminal", async () => {
    render(<App />);

    expect(screen.getByLabelText("Roer session")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /new session/i })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  });

  it("mode 1: starts a new session through the roer shim", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));

    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    await waitFor(() => expect(spawnPty).toHaveBeenCalled());
    const [args, cwd] = vi.mocked(spawnPty).mock.calls[0] ?? [];
    // `new`, not `shell`: `shell` reuses the session for a directory, so the
    // launcher would hand back the session from the last click.
    expect(args).toEqual(["new"]);
    // The app's own working directory is an accident of how it was launched,
    // so a new session starts at home rather than there.
    expect(cwd).toBe("/Users/test");
  });

  it("gives each new session its own terminal", async () => {
    render(<App />);
    const button = await screen.findByRole("button", { name: /new session/i });

    fireEvent.click(button);
    await waitFor(() => expect(spawnPty).toHaveBeenCalledTimes(1));
    // Same args and same directory as the first click, so nothing but the
    // request's own identity can tell the stage that this is another session.
    fireEvent.click(button);
    await waitFor(() => expect(spawnPty).toHaveBeenCalledTimes(2));

    // The first terminal is gone rather than left running behind the second.
    expect(closePty).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("terminal")).toHaveLength(1);
  });

  it("mode 2: a teleported session runs the args the shim supplied", async () => {
    render(<App />);
    await teleport();

    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    await waitFor(() => expect(spawnPty).toHaveBeenCalled());
    const [args, cwd] = vi.mocked(spawnPty).mock.calls[0] ?? [];
    expect(args).toEqual(["attach", "%3"]);
    expect(cwd).toBe("/Users/test/project");
  });

  it("opens a resume handoff without knowing what resume means", async () => {
    render(<App />);
    await teleport({
      args: ["resume", "3f389702-8e8a-4248-a30c-57552ff208a1"],
      cwd: "/Users/test/project",
      label: "resume 3f389702",
      record: "/Users/test/.roer/handoffs/20260101T000001-2.json",
    });

    await waitFor(() => expect(spawnPty).toHaveBeenCalled());
    expect(vi.mocked(spawnPty).mock.calls[0]?.[0]).toEqual([
      "resume",
      "3f389702-8e8a-4248-a30c-57552ff208a1",
    ]);
  });

  it("releases the waiting terminal only once the session renders", async () => {
    render(<App />);
    await teleport();

    // Nothing has been acked on spawn alone, so the terminal is still
    // holding the session.
    await waitFor(() => expect(spawnPty).toHaveBeenCalled());
    expect(ackHandoff).not.toHaveBeenCalled();

    await emit({ kind: "output", data: "aGk=" });
    await waitFor(() => expect(ackHandoff).toHaveBeenCalledWith(claimed()));
  });

  it("claims a handoff before attaching anything", async () => {
    render(<App />);
    await teleport();

    // The claim is what makes the two sides agree: the shim cancels by
    // renaming the same path, so attaching before claiming could evict a
    // terminal that had already been told nothing moved.
    await waitFor(() => expect(claimHandoff).toHaveBeenCalledWith(handoff.record));
    expect(vi.mocked(claimHandoff).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawnPty).mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("ignores a handoff the waiting terminal has given up on", async () => {
    vi.mocked(claimHandoff).mockRejectedValueOnce(new Error("no such file"));
    render(<App />);
    await teleport();

    // The shim timed out and renamed the record away, so it still holds the
    // session. Attaching now would take a session off a terminal that has
    // been told it kept it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawnPty).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  });

  it("keeps the terminal holding the session when the attach dies on arrival", async () => {
    render(<App />);
    await teleport();

    // A failed attach prints its error and exits. Acking on that output would
    // detach the terminal from a session nothing is holding, and the ack
    // cannot be taken back — so the record goes back instead, which tells the
    // shim at once that nothing moved.
    await emit({ kind: "output", data: "aGk=" });
    await emit({ kind: "exit", code: 1 });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ackHandoff).not.toHaveBeenCalled();
    expect(failHandoff).toHaveBeenCalledWith(claimed());
  });

  it("picks up a handoff that arrived while it was starting", async () => {
    // The ordinary cold start: the shim writes the record, runs `open -a
    // Roer` and waits. Nothing was listening when the watcher saw it.
    vi.mocked(pendingHandoffs).mockResolvedValueOnce([handoff]);
    render(<App />);

    await waitFor(() => expect(spawnPty).toHaveBeenCalled());
    expect(vi.mocked(spawnPty).mock.calls[0]?.[0]).toEqual(["attach", "%3"]);
  });

  it("makes a second handoff wait until the first has been answered", async () => {
    render(<App />);
    await teleport();

    // Another terminal hands over while the first is still waiting to hear
    // that its session is on screen. Showing this one now would evict that
    // session and leave its terminal reporting that nothing moved.
    const second: Handoff = {
      args: ["attach", "%7"],
      cwd: "/Users/test/other",
      label: "other",
      record: "/Users/test/.roer/handoffs/20260101T000003-4.json",
    };
    await teleport(second);
    expect(vi.mocked(spawnPty).mock.calls).toHaveLength(1);

    // The first session proves itself, its terminal is released, and the
    // queued handoff takes the stage.
    await emit({ kind: "output", data: "aGk=" });
    await waitFor(() => expect(ackHandoff).toHaveBeenCalledWith(claimed()));
    await waitFor(() => expect(spawnPty).toHaveBeenCalledTimes(2));
    expect(vi.mocked(spawnPty).mock.calls[1]?.[0]).toEqual(["attach", "%7"]);
  });

  it("answers a handoff for the session already on the stage", async () => {
    render(<App />);
    await teleport();
    await emit({ kind: "output", data: "aGk=" });
    await waitFor(() => expect(ackHandoff).toHaveBeenCalledWith(claimed()));

    // `roer` in a terminal for the session Roer is already showing. The stage
    // does not change, so no terminal remounts and no output arrives — and
    // waiting for output that will never come leaves the terminal blocked
    // until it times out and reports that nothing moved.
    const again = { ...handoff, record: "/Users/test/.roer/handoffs/20260101T000002-3.json" };
    await teleport(again);

    await waitFor(() => expect(ackHandoff).toHaveBeenCalledWith(claimed(again)));
    // Acked without tearing down the session that was already running.
    expect(spawnPty).toHaveBeenCalledTimes(1);
    expect(closePty).not.toHaveBeenCalled();
  });

  it("acks a record once, however much output arrives", async () => {
    render(<App />);
    await teleport();
    await emit({ kind: "output", data: "aGk=" });
    await emit({ kind: "output", data: "aGk=" });

    await waitFor(() => expect(ackHandoff).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ackHandoff).toHaveBeenCalledTimes(1);
  });

  it("keeps the session list beside the terminal", async () => {
    render(<App />);
    await teleport();

    // The list is navigation, not a screen you leave: both are on screen.
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /sessions/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /new session/i })).toBeInTheDocument();
  });

  it("marks the session on the stage instead of offering it again", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { session: "roer", pane: "%3", attached: true, cwd: "/Users/test/project", command: "claude" },
      { session: "other", pane: "%9", attached: false, cwd: "/Users/test/other", command: "zsh" },
    ]);
    render(<App />);
    await teleport();

    const rows = await screen.findAllByRole("button", { current: false });
    expect(rows.some((row) => row.textContent?.includes("other"))).toBe(true);
    const open = await screen.findByRole("button", { current: true });
    expect(open).toHaveTextContent("roer");
    expect(open).toHaveTextContent("open here");
  });

  it("returns to the launcher when a terminal takes the session back", async () => {
    // The session is still there, now held by the terminal that took it.
    vi.mocked(listSessions).mockResolvedValue([
      { session: "roer", pane: "%3", attached: true, cwd: "/Users/test/project", command: "claude" },
    ]);
    render(<App />);
    await teleport();
    await emit({ kind: "exit", code: 0 });

    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(await screen.findByText(/still running with no client/i)).toBeInTheDocument();
  });

  it("does not offer to take back a session that has ended", async () => {
    // The shell exited, so the session went with it. Saying `roer` would
    // bring it back would send someone to a terminal to find nothing.
    vi.mocked(listSessions).mockResolvedValue([]);
    render(<App />);
    await teleport();
    await emit({ kind: "exit", code: 0 });

    expect(await screen.findByText(/session ended/i)).toBeInTheDocument();
  });
});
