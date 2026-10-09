import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { defineExtension } from "./extensions/api";
import { useActivateTab } from "./extensions/context";
import { registry } from "./extensions/registry";
import { fileRead, filesSearch } from "./lib/files";
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
import { claudeSetupStatus } from "./lib/claudeSetup";
import { listWorkspaces } from "./lib/workspaces";
import { reportPluginUiReceipt } from "./lib/pluginUi";
import { startBrowserServer } from "./lib/browserServer";

// Shared between the test body and the hoisted module mock below.
const mocks = vi.hoisted(() => ({
  handoffHandlers: [] as Array<(handoff: unknown) => void>,
  // The same, for what a worktree watch reports.
  changedHandlers: [] as Array<(changed: unknown) => void>,
  // The onEvent callback the component handed to spawnPty, so a test can
  // push PTY output through it.
  emit: { current: undefined as undefined | ((event: unknown) => void) },
  // What the menu's "Agent Integrations…" is heard with.
  setupMenu: { current: undefined as undefined | (() => void) },
  // The last terminal made, so a test can see what it was told to look like.
  terminal: {
    current: undefined as undefined | { options: { theme?: { background?: string } }; focus: () => void },
  },
  // What the plugin-UI watcher delivers records to.
  pluginUi: { current: undefined as undefined | ((record: unknown) => void) },
  // The terminal's OSC handlers by number, so a test can play `roer` saying
  // which pane it attached.
  osc: new Map<number, (data: string) => boolean>(),
}));

vi.mock("./lib/pluginUi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/pluginUi")>()),
  onPluginUi: vi.fn(async (handler: (record: unknown) => void) => {
    mocks.pluginUi.current = handler;
    return () => {};
  }),
  reportPluginUiReceipt: vi.fn(async () => undefined),
}));

// xterm.js measures real glyphs, which jsdom cannot do, so the terminal
// itself is stubbed; these tests cover the React shell around it.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { theme?: unknown };
    constructor(options: { theme?: unknown }) {
      this.options = { ...options };
      mocks.terminal.current = this as never;
    }
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onKey = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    parser = {
      registerOscHandler: vi.fn((ident: number, handler: (data: string) => boolean) => {
        mocks.osc.set(ident, handler);
        return { dispose: vi.fn() };
      }),
    };
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock("./lib/browserServer", () => ({
  startBrowserServer: vi.fn().mockResolvedValue(undefined),
  onBrowserServerMenu: vi.fn().mockResolvedValue(() => undefined),
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
  listPastSessions: vi.fn(async () => []),
  listClaudeSessions: vi.fn(async () => []),
  roerStatus: vi.fn(async () => ({
    bin: "roer",
    available: true,
    home: "/Users/test",
  })),
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

// Nothing to ask about unless a test says so.
vi.mock("./lib/claudeSetup", () => ({
  claudeSetupStatus: vi.fn(async () => ({
    claudeCode: true,
    skills: false,
    sharedSkills: false,
    mcp: false,
    shouldPrompt: false,
  })),
  applyClaudeSetup: vi.fn(),
  dismissClaudeSetup: vi.fn(),
  onClaudeSetupMenu: vi.fn(async (handler: () => void) => {
    mocks.setupMenu.current = handler;
    return () => undefined;
  }),
}));

// No Workspaces unless a test gives some: with one, the sidebar selects it
// and filters every session list down to what it covers.
vi.mock("./lib/workspaces", () => ({
  listWorkspaces: vi.fn(async () => []),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  attachProject: vi.fn(),
  detachProject: vi.fn(),
  addWorkspaceItem: vi.fn(),
  removeWorkspaceItem: vi.fn(),
  workspaceAssignments: vi.fn(async () => ({})),
  assignSession: vi.fn(),
  unassignSession: vi.fn(),
}));

vi.mock("./lib/projects", () => ({
  listProjects: vi.fn(async () => []),
  createProject: vi.fn(),
  renameProject: vi.fn(),
  deleteProject: vi.fn(),
}));

// Go to File has tests of its own; here it only has to answer.
vi.mock("./lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/files")>()),
  filesSearch: vi.fn(async () => ({
    root: "/Users/test/project",
    generation: 1,
    indexing: false,
    total: 2,
    matched: 1,
    line: null,
    hits: [{ path: "src/App.tsx", nameAt: 4, score: 10, at: [4, 5, 6] }],
  })),
  fileRead: vi.fn(async () => ({
    text: "export function App() {\n  return null;\n}\n",
    lines: 3,
    truncated: false,
    binary: false,
    bytes: 41,
  })),
  onFilesChanged: vi.fn(async (handler: (changed: unknown) => void) => {
    mocks.changedHandlers.push(handler);
    return () => undefined;
  }),
}));

// The changes view has tests of its own; here it only has to mount without
// reaching for a backend.
vi.mock("./lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/git")>()),
  gitChanges: vi.fn(async () => ({
    root: "/Users/test/project",
    branch: "main",
    files: [],
  })),
  gitDiff: vi.fn(async () => ""),
  gitRoot: vi.fn(async () => null),
}));

const handoff: Handoff = {
  args: ["attach", "%3"],
  cwd: "/Users/test/project",
  label: "roer",
  record: "/Users/test/.roer/handoffs/20260101T000000-1.json",
};

/** What the app holds after claiming a record: the renamed path. */
const claimed = (record: Handoff = handoff) => `${record.record}.claimed`;

/** Deliver a batch the way a worktree watch would. */
async function watchSaw(paths: string[], broad = false) {
  await waitFor(() => expect(mocks.changedHandlers.length).toBeGreaterThan(0));
  await act(async () => {
    for (const handler of mocks.changedHandlers)
      handler({ root: "/Users/test/project", paths, broad });
  });
}

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
  mocks.osc.clear();
  mocks.changedHandlers.length = 0;
  mocks.emit.current = undefined;
  mocks.setupMenu.current = undefined;
  mocks.terminal.current = undefined;
  delete document.documentElement.dataset.theme;
  // The sidebar's collapsed state persists here across renders on purpose;
  // it must not persist across tests too.
  localStorage.clear();
});

describe("App", () => {
  it("asks about agent integrations on a launch with nothing decided, and only then", async () => {
    vi.mocked(claudeSetupStatus).mockResolvedValueOnce({
      claudeCode: true,
      skills: false,
      sharedSkills: false,
      mcp: false,
      shouldPrompt: true,
    });
    const { unmount } = render(<App />);
    expect(await screen.findByRole("dialog", { name: /Agent Integrations/ })).toBeInTheDocument();
    unmount();

    render(<App />);
    await waitFor(() => expect(claudeSetupStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: /Agent Integrations/ })).not.toBeInTheDocument();
  });

  it("opens agent integrations from the menu, showing what is set up", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.setupMenu.current).toBeDefined());
    vi.mocked(claudeSetupStatus).mockResolvedValueOnce({
      claudeCode: true,
      skills: true,
      sharedSkills: true,
      mcp: false,
      shouldPrompt: false,
    });

    act(() => mocks.setupMenu.current?.());

    expect(await screen.findByRole("checkbox", { name: /Claude Code skills/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Roer authoring guidance for Codex/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /MCP server/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("collapses and reopens the sidebar, remembering the choice", async () => {
    render(<App />);

    const toggle = screen.getByRole("button", { name: "Hide sidebar" });
    expect(screen.getByLabelText("Workspaces")).not.toHaveClass("collapsed");

    fireEvent.click(toggle);
    expect(screen.getByLabelText("Workspaces")).toHaveClass("collapsed");
    expect(localStorage.getItem("roer:sidebar-collapsed")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(screen.getByLabelText("Workspaces")).not.toHaveClass("collapsed");
    expect(localStorage.getItem("roer:sidebar-collapsed")).toBe("0");
  });

  it("steps the theme from the title bar, remembering it and repainting the terminal", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
    expect(mocks.terminal.current?.options.theme?.background).toBe("#1e1e1e");

    fireEvent.click(screen.getByRole("button", { name: "Theme: system" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("roer:theme")).toBe("light");
    expect(mocks.terminal.current?.options.theme?.background).toBe("#ffffff");

    fireEvent.click(screen.getByRole("button", { name: "Theme: light" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(mocks.terminal.current?.options.theme?.background).toBe("#1e1e1e");

    // Back to the system, which jsdom cannot ask, so dark.
    fireEvent.click(screen.getByRole("button", { name: "Theme: dark" }));
    expect(screen.getByRole("button", { name: "Theme: system" })).toBeInTheDocument();
    expect(localStorage.getItem("roer:theme")).toBe("system");
  });

  it("turns notifications off and on from the title bar, remembering it", async () => {
    render(<App />);
    const toggle = await screen.findByRole("button", { name: "Notifications" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("roer:notifications")).toBe("off");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("roer:notifications")).toBe("on");
  });

  it("opens the session in a browser from the title bar", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open this session in a browser" }));
    expect(startBrowserServer).toHaveBeenCalled();
  });

  it("opens on the launcher rather than a terminal", async () => {
    render(<App />);

    expect(screen.getByLabelText("Roer session")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /new session/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  });

  it("mode 1: starts a new session through the roer shim", async () => {
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: /new session/i }),
    );

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

  it("puts the keyboard in a session as soon as it opens", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /new session/i }));

    await waitFor(() => expect(mocks.terminal.current?.focus).toHaveBeenCalled());
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
    await waitFor(() =>
      expect(claimHandoff).toHaveBeenCalledWith(handoff.record),
    );
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
    const again = {
      ...handoff,
      record: "/Users/test/.roer/handoffs/20260101T000002-3.json",
    };
    await teleport(again);

    await waitFor(() =>
      expect(ackHandoff).toHaveBeenCalledWith(claimed(again)),
    );
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

  it("shows the session list over the terminal on its own tab", async () => {
    render(<App />);
    await teleport();

    // A session on the stage is what the list was opened to find, so
    // finding one puts the terminal in front of it, not beside it.
    expect(
      screen.queryByRole("navigation", { name: "Workspace" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));

    // Covers the terminal rather than replacing it: nothing about the PTY
    // changes just from looking at the list again.
    expect(
      await screen.findByRole("navigation", { name: "Workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(closePty).not.toHaveBeenCalled();
  });

  it("marks the session on the stage instead of offering it again", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer",
        pane: "%3",
        attached: true,
        cwd: "/Users/test/project",
        command: "claude",
      },
      {
        id: "2",
        session: "other",
        pane: "%9",
        attached: false,
        cwd: "/Users/test/other",
        command: "zsh",
      },
    ]);
    render(<App />);
    await teleport();
    fireEvent.click(await screen.findByRole("tab", { name: "Workspace" }));

    const list = within(await screen.findByRole("navigation", { name: "Workspace" }));
    const rows = await list.findAllByRole("button", { current: false });
    expect(rows.some((row) => row.title.startsWith("other "))).toBe(true);
    const open = await list.findByRole("button", { current: true });
    expect(open).toHaveAttribute("title", expect.stringMatching(/^roer /));
    expect(open).toHaveTextContent("open here");
  });

  it("returns to the launcher when a terminal takes the session back", async () => {
    // The session is still there, now held by the terminal that took it.
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer",
        pane: "%3",
        attached: true,
        cwd: "/Users/test/project",
        command: "claude",
      },
    ]);
    render(<App />);
    await teleport();
    await emit({ kind: "exit", code: 0 });

    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(
      await screen.findByText(/still running with no client/i),
    ).toBeInTheDocument();
  });

  it("finds the pane tmux made for a session started here", async () => {
    // `roer new` names and creates the session itself, so there is nothing to
    // look it up by until it exists — and without its pane the app cannot say
    // which row is live, or which directory the session is in now.
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /new session/i }),
    );

    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "test-1a2b",
        pane: "%7",
        attached: true,
        cwd: "/Users/test",
        command: "zsh",
      },
    ]);
    await emit({ kind: "output", data: "aGk=" });

    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    const list = within(await screen.findByRole("navigation", { name: "Workspace" }));
    const open = await list.findByRole("button", { current: true });
    expect(open).toHaveAttribute("title", expect.stringContaining("test-1a2b"));
    expect(open).toHaveTextContent("open here");
  });

  it("leaves the pane unknown when two sessions appear at once", async () => {
    // The wrong pane is worse than none: every view keyed on it would be
    // about somebody else's session.
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /new session/i }),
    );

    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "test-1a2b",
        pane: "%7",
        attached: true,
        cwd: "/Users/test",
        command: "zsh",
      },
      {
        id: "2",
        session: "other",
        pane: "%8",
        attached: true,
        cwd: "/Users/test/other",
        command: "zsh",
      },
    ]);
    await emit({ kind: "output", data: "aGk=" });

    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { current: true }),
    ).not.toBeInTheDocument();
  });

  describe("answers for every plugin UI message, since a dropped one is silent on screen", () => {
    const record = (pane: string) => ({
      id: `r-${pane}`,
      pane,
      message: { version: "v1.0", deleteSurface: { surfaceId: "s" } },
    });
    const deliver = (pane: string) => act(() => mocks.pluginUi.current?.(record(pane)));
    // From nothing running, so the new session's pane is the one not seen before.
    beforeEach(() => vi.mocked(listSessions).mockResolvedValue([]));
    const newSessionAppears = async (
      sessions: Array<{ pane: string; session: string }>,
      // What roer says in the terminal before attaching, if anything.
      said?: string,
    ) => {
      fireEvent.click(await screen.findByRole("button", { name: /new session/i }));
      if (said) {
        await waitFor(() => expect(mocks.osc.get(7717)).toBeDefined());
        act(() => {
          mocks.osc.get(7717)?.(said);
        });
      }
      vi.mocked(listSessions).mockResolvedValue(
        sessions.map(({ pane, session }, n) => ({
          id: String(n),
          session,
          pane,
          attached: true,
          cwd: "/Users/test",
          command: "zsh",
        })),
      );
      await emit({ kind: "output", data: "aGk=" });
      await waitFor(() => expect(listSessions).toHaveBeenCalled());
    };

    it("with no session on screen", async () => {
      render(<App />);
      await waitFor(() => expect(mocks.pluginUi.current).toBeDefined());
      deliver("%7");
      expect(reportPluginUiReceipt).toHaveBeenCalledWith("r-%7", "nothing-on-screen", undefined);
    });

    it("for the session on screen, and for another one", async () => {
      render(<App />);
      await newSessionAppears([{ pane: "%7", session: "test-1a2b" }]);
      await waitFor(() => {
        deliver("%7");
        expect(reportPluginUiReceipt).toHaveBeenCalledWith("r-%7", "shown", "%7");
      });
      deliver("%9");
      expect(reportPluginUiReceipt).toHaveBeenCalledWith("r-%9", "other-pane", "%7");
    });

    it("for a session started here, by the pane its roer said it attached", async () => {
      // Two sessions appearing at once would leave the guess with nothing to
      // go on; what roer says in the terminal is not a guess.
      render(<App />);
      await newSessionAppears(
        [
          { pane: "%7", session: "test-1a2b" },
          { pane: "%8", session: "other" },
        ],
        "pane=%8",
      );
      deliver("%8");
      expect(reportPluginUiReceipt).toHaveBeenCalledWith("r-%8", "shown", "%8");
    });

    it("when the session on screen never learned its pane", async () => {
      render(<App />);
      await newSessionAppears([
        { pane: "%7", session: "test-1a2b" },
        { pane: "%8", session: "other" },
      ]);
      deliver("%7");
      expect(reportPluginUiReceipt).toHaveBeenCalledWith("r-%7", "pane-unknown", undefined);
    });
  });

  it("falls back to Terminal when a tab asks for one the strip doesn't have", async () => {
    function Asker() {
      const activate = useActivateTab();
      return (
        <button type="button" onClick={() => activate("ext:nowhere/main")}>
          Go nowhere
        </button>
      );
    }
    registry.load(
      "asker",
      defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "Asker", component: Asker, needsSession: false })),
    );
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("tab", { name: "Asker" }));
      fireEvent.click(await screen.findByRole("button", { name: "Go nowhere" }));
      // A typo in the id would otherwise leave nothing on the stage.
      await waitFor(() => expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true"));
    } finally {
      registry.unload("asker");
    }
  });

  it("has no changes to show until a session is staged", async () => {
    render(<App />);

    // Whose changes? The repository comes from the session's own directory.
    expect(await screen.findByRole("tab", { name: "Changes" })).toBeDisabled();
  });

  it("puts the changes view over the terminal without closing it", async () => {
    render(<App />);
    await teleport();
    await emit({ kind: "output", data: "aGk=" });

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    expect(await screen.findByTestId("changes")).toBeInTheDocument();
    // Unmounting the terminal would end Roer's tmux client, which hands the
    // session to whoever asks for it next.
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(closePty).not.toHaveBeenCalled();
  });

  it("leaves the stage alone when a Workspace is picked, its sessions being in the sidebar", async () => {
    vi.mocked(listWorkspaces).mockResolvedValueOnce([
      { id: "w1", name: "Default", projects: [], items: [] },
    ]);
    render(<App />);
    await teleport();
    await emit({ kind: "output", data: "aGk=" });

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await screen.findByTestId("changes");

    fireEvent.click(screen.getByRole("button", { name: "Switch Workspace or Project" }));
    fireEvent.click(await screen.findByRole("button", { name: /Default/ }));

    expect(screen.getByTestId("changes")).toBeVisible();
    expect(screen.getByRole("region", { name: "Running sessions" })).toBeInTheDocument();
  });

  it("keeps the changes view around behind the terminal", async () => {
    render(<App />);
    await teleport();
    await emit({ kind: "output", data: "aGk=" });

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await screen.findByTestId("changes");
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));

    // Still mounted, so the file it was showing is still selected when it
    // comes back — just hidden.
    expect(screen.getByTestId("changes")).not.toBeVisible();
  });

  /** `Cmd+Shift+O`, dispatched at `where` the way macOS delivers it. */
  const goToFile = (where: Element | Window) =>
    fireEvent.keyDown(where, {
      key: "O",
      code: "KeyO",
      metaKey: true,
      shiftKey: true,
    });

  it("opens Go to File on Cmd+Shift+O while the terminal has the keyboard", async () => {
    render(<App />);
    await teleport();

    // Dispatched at the terminal, which is where the keyboard really is: the
    // listener is in the capture phase precisely so it runs before xterm's.
    goToFile(screen.getByTestId("terminal"));

    expect(await screen.findByTestId("go-to-file")).toBeInTheDocument();
    await waitFor(() => expect(filesSearch).toHaveBeenCalled());
    // The popup is an overlay, so the terminal is still mounted behind it and
    // its PTY was never closed.
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(spawnPty).toHaveBeenCalledTimes(1);
    expect(closePty).not.toHaveBeenCalled();
  });

  it("closes Go to File on Escape", async () => {
    render(<App />);
    await teleport();
    goToFile(window);
    await screen.findByTestId("go-to-file");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByTestId("go-to-file")).not.toBeInTheDocument();
  });

  it("searches only sessions without one on the stage", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /new session/i });

    goToFile(window);

    expect(await screen.findByTestId("go-to-file")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Search sessions");
    expect(filesSearch).not.toHaveBeenCalled();
  });

  it("closes Go to File when the session ends under it", async () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    render(<App />);
    await teleport();
    goToFile(window);
    await screen.findByTestId("go-to-file");

    await emit({ kind: "exit", code: 0 });

    expect(screen.queryByTestId("go-to-file")).not.toBeInTheDocument();
  });

  it("starts a new session on Cmd+T while the terminal has the keyboard", async () => {
    render(<App />);
    await teleport();
    vi.mocked(spawnPty).mockClear();

    // Dispatched at the terminal, same reasoning as Go to File: the listener
    // runs in the capture phase precisely so xterm never sees the T.
    fireEvent.keyDown(screen.getByTestId("terminal"), {
      key: "t",
      code: "KeyT",
      metaKey: true,
    });

    await waitFor(() => expect(spawnPty).toHaveBeenCalled());
    expect(vi.mocked(spawnPty).mock.calls[0]?.[0]).toEqual(["new"]);
  });

  /** Open a file through Go to File, as a user would. */
  async function pick(name = "App.tsx") {
    goToFile(window);
    await screen.findByTestId("go-to-file");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: name } });
    await waitFor(() =>
      expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
    );
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    await waitFor(() =>
      expect(screen.queryByTestId("go-to-file")).not.toBeInTheDocument(),
    );
  }

  it("opens the chosen file in a tab of its own", async () => {
    render(<App />);
    await teleport();
    await pick();

    expect(screen.getByRole("tab", { name: "App.tsx" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Beside the permanent two, not instead of them.
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Changes" })).toBeInTheDocument();
  });

  it("shows the file it opened", async () => {
    render(<App />);
    await teleport();
    await pick();

    const view = await screen.findByTestId("file-view");
    expect(view).toHaveTextContent("export function App() {");
    // Numbered, as an editor shows it — on the gutter's attribute, since the
    // number is drawn by CSS rather than held as text a selection could take.
    expect(view.querySelector(".file-no")).toHaveAttribute("data-no", "1");
  });

  it("follows the file when the watch says it changed, and keeps the session", async () => {
    render(<App />);
    await teleport();
    await pick();
    await waitFor(() => expect(fileRead).toHaveBeenCalledTimes(1));

    // One bare word, for the reason FileView's own tests use one: the
    // colourer splits anything richer into several elements, and then no
    // query finds the row by its text.
    vi.mocked(fileRead).mockResolvedValue({
      text: "rewritten\n",
      lines: 1,
      truncated: false,
      binary: false,
      bytes: 10,
    });
    await watchSaw(["src/App.tsx"]);

    expect(await screen.findByText("rewritten")).toBeInTheDocument();
    // Nothing about a file changing under an agent may touch the terminal:
    // unmounting it would close its PTY and release the tmux session.
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(spawnPty).toHaveBeenCalledTimes(1);
    expect(closePty).not.toHaveBeenCalled();
  });

  it("opens a file without disturbing the session behind it", async () => {
    render(<App />);
    await teleport();
    await pick();

    // The whole reason panels are overlays: unmounting the terminal would
    // close its PTY and release the session.
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(spawnPty).toHaveBeenCalledTimes(1);
    expect(closePty).not.toHaveBeenCalled();
  });

  it("goes back to the terminal and returns to the file it had open", async () => {
    render(<App />);
    await teleport();
    await pick();

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByRole("tab", { name: "App.tsx" })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    fireEvent.click(screen.getByRole("tab", { name: "App.tsx" }));
    expect(screen.getByRole("tab", { name: "App.tsx" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("reopening a file activates the tab it already has", async () => {
    render(<App />);
    await teleport();
    await pick();
    await pick();

    expect(screen.getAllByRole("tab", { name: "App.tsx" })).toHaveLength(1);
  });

  it("closes a file tab and falls back to the terminal", async () => {
    render(<App />);
    await teleport();
    await pick();

    fireEvent.click(screen.getByRole("button", { name: "Close App.tsx" }));

    expect(
      screen.queryByRole("tab", { name: "App.tsx" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("offers the files it has open before anything is typed", async () => {
    render(<App />);
    await teleport();
    await pick();

    goToFile(window);
    await screen.findByTestId("go-to-file");

    expect(await screen.findByText("Recent files")).toBeInTheDocument();
    // The row reads name first, then the directory, as the popup shows it.
    expect(screen.getByRole("option")).toHaveTextContent("App.tsxsrc/");
  });

  it("drops the file tabs when the session ends", async () => {
    vi.mocked(listSessions).mockResolvedValue([]);
    render(<App />);
    await teleport();
    await pick();

    await emit({ kind: "exit", code: 0 });

    // The tab was about a directory nobody is in any more.
    expect(
      screen.queryByRole("tab", { name: "App.tsx" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(/session ended/i)).toBeInTheDocument();
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
