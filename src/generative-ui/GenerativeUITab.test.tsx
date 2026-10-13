import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyAll } from "./apply";
import { GenerativeUITab, NUDGE, keepTabPrompt } from "./GenerativeUITab";
import { defineExtension } from "../extensions/api";
import { registry } from "../extensions/registry";
import { sendToSession } from "../lib/github";
import { resetAskAgent } from "../lib/askAgent";
import { noteTyped } from "../lib/pty";
import { noteShown } from "./returns";
import { A2UI_VERSION, type A2uiMessage } from "./schema";
import {
  listPluginUiBundles,
  readPluginUiBundle,
  reportPluginUiAction,
  writePluginUiBundle,
} from "../lib/pluginUi";

vi.mock("../lib/pluginUi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/pluginUi")>()),
  listPluginUiBundles: vi.fn(),
  readPluginUiBundle: vi.fn(),
  writePluginUiBundle: vi.fn(),
  reportPluginUiAction: vi.fn(),
}));

vi.mock("../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/github")>()),
  sendToSession: vi.fn().mockResolvedValue(undefined),
}));

const messages: A2uiMessage[] = [
  {
    version: A2UI_VERSION,
    createSurface: {
      surfaceId: "demo",
      catalogId: "roer:catalog/1",
      components: [{ id: "root", component: "Text", text: "hi" }],
    },
  },
];

function renderTab(overrides: Partial<React.ComponentProps<typeof GenerativeUITab>> = {}) {
  const onChange = vi.fn();
  const onLoadBundle = vi.fn();
  render(
    <GenerativeUITab
      state={applyAll(messages)}
      surfaceId="demo"
      onChange={onChange}
      log={messages}
      live
      cwd="/work/roer"
      onLoadBundle={onLoadBundle}
      {...overrides}
    />,
  );
  return { onChange, onLoadBundle };
}

describe("GenerativeUITab saved bundles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPluginUiBundles).mockResolvedValue([]);
    resetAskAgent();
    localStorage.clear();
  });

  it("hides the saved-bundles section without a cwd", () => {
    renderTab({ cwd: undefined });
    expect(screen.queryByRole("button", { name: "Save…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open…" })).not.toBeInTheDocument();
  });

  it("lists saved bundles for the session's project", async () => {
    vi.mocked(listPluginUiBundles).mockResolvedValue([
      { name: "test-runner", prompt: "Add a test runner" },
    ]);
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open…" }));

    expect(await screen.findByText("test-runner")).toBeInTheDocument();
    expect(screen.getByText(/Add a test runner/)).toBeInTheDocument();
    expect(listPluginUiBundles).toHaveBeenCalledWith("/work/roer");
  });

  it("saves the current surface under the typed name", async () => {
    vi.mocked(writePluginUiBundle).mockResolvedValue(undefined);
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    fireEvent.change(screen.getByPlaceholderText("save as…"), {
      target: { value: "test-runner" },
    });
    fireEvent.change(screen.getAllByPlaceholderText(/what it shows/)[0], {
      target: { value: "Add a test runner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(writePluginUiBundle).toHaveBeenCalledWith("/work/roer", "test-runner", {
        prompt: "Add a test runner",
        surface: {
          version: "v1.0",
          createSurface: {
            surfaceId: "demo",
            catalogId: "roer:catalog/1",
            components: [{ id: "root", component: "Text", text: "hi" }],
          },
        },
      }),
    );
    expect(await screen.findByText(/Saved as "test-runner"/)).toBeInTheDocument();
  });

  it("disables Save until a name is typed", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("opens Save in a dialog that Escape closes, and shows the raw messages in another", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save this view" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(screen.getByRole("dialog", { name: /Raw A2UI v1.0 messages/ })).toBeInTheDocument();
  });

  it("lists extensions' tabs beside the saved views, and opens one", async () => {
    vi.mocked(listPluginUiBundles).mockResolvedValue([{ name: "board", prompt: "my issues" }]);
    registry.load("trip", defineExtension((roer) => void roer.stage.registerTab({ id: "main", title: "Trip", component: () => null })));
    registry.load("changes", defineExtension((roer) => void roer.stage.registerTab({ id: "changes", title: "Changes", component: () => null })), { bundled: true });
    const onOpenTab = vi.fn();
    try {
      renderTab({ onOpenTab });
      fireEvent.click(screen.getByRole("button", { name: "Open…" }));
      expect(await screen.findByRole("button", { name: "board" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Trip" }));
      expect(onOpenTab).toHaveBeenCalledWith("ext:trip/main");
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      registry.unload("trip");
      registry.unload("changes");
    }
  });

  it("keeps a view as a tab, showing each step from waiting for the agent to the tab being ready", async () => {
    vi.mocked(writePluginUiBundle).mockResolvedValue(undefined);
    const onOpenTab = vi.fn();
    const tab = (agentState: "working" | "done") => (
      <GenerativeUITab state={applyAll(messages)} surfaceId="demo" onChange={vi.fn()} log={messages} live cwd="/work/roer" pane="%7" onLoadBundle={vi.fn()} agentState={agentState} onOpenTab={onOpenTab} />
    );
    const { rerender } = render(tab("working"));
    fireEvent.click(await screen.findByRole("button", { name: "Keep as tab…" }));
    expect(screen.getByText(/The agent is busy, so this waits/)).toBeInTheDocument();
    fireEvent.change(screen.getAllByPlaceholderText(/what it shows/)[0]!, { target: { value: "open issues" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and ask when it is ready" }));
    // The dialog goes at once; the panel says what happens next.
    expect(screen.queryByRole("dialog")).toBeNull();

    expect(await screen.findByText(/Waiting for the agent to finish, then asking it to make “demo” a tab/)).toBeInTheDocument();
    expect(writePluginUiBundle).toHaveBeenCalledWith("/work/roer", "demo", expect.objectContaining({ prompt: "open issues" }));
    expect(sendToSession).not.toHaveBeenCalled();

    rerender(tab("done"));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%7", keepTabPrompt("demo", "open issues")));
    expect(sendToSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Asked the agent to make “demo” a tab/)).toBeInTheDocument();
    rerender(tab("working"));
    expect(screen.getByText(/The agent is making “demo” a tab/)).toBeInTheDocument();

    // The tab the agent made shows up in the strip.
    registry.load(
      "demo-tab",
      defineExtension((roer) => {
        roer.stage.registerTab({ id: "main", title: "Demo", component: () => null });
      }),
    );
    try {
      expect(await screen.findByText(/“Demo” is ready in the strip/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open tab" }));
      expect(onOpenTab).toHaveBeenCalledWith("ext:demo-tab/main");
    } finally {
      registry.unload("demo-tab");
    }
    expect(keepTabPrompt("demo", "open issues")).toContain(".roer/plugin-ui/bundles/demo/surface.json, which shows open issues");
  });

  it("sends a held request now, or drops it, when the person says so", async () => {
    vi.mocked(writePluginUiBundle).mockResolvedValue(undefined);
    renderTab({ pane: "%7", agentState: "working" });
    fireEvent.click(await screen.findByRole("button", { name: "Keep as tab…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and ask when it is ready" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%7", keepTabPrompt("demo", "")));
    expect(await screen.findByText(/The agent is making “demo” a tab/)).toBeInTheDocument();
  });

  it("drops a held request on Cancel", async () => {
    vi.mocked(writePluginUiBundle).mockResolvedValue(undefined);
    renderTab({ pane: "%7", agentState: "working" });
    fireEvent.click(await screen.findByRole("button", { name: "Keep as tab…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and ask when it is ready" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Keep as tab…" })).toBeInTheDocument();
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("asks at once while the agent waits at an empty prompt", async () => {
    vi.mocked(writePluginUiBundle).mockResolvedValue(undefined);
    renderTab({ pane: "%7", agentState: "done" });
    fireEvent.click(await screen.findByRole("button", { name: "Keep as tab…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and ask the agent" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%7", keepTabPrompt("demo", "")));
    expect(vi.mocked(writePluginUiBundle).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sendToSession).mock.invocationCallOrder[0]!);
    expect(await screen.findByText(/Asked the agent to make “demo” a tab/)).toBeInTheDocument();
  });

  it("cannot ask for a tab with no agent to ask", async () => {
    renderTab({ pane: "%7" });
    fireEvent.click(await screen.findByRole("button", { name: "Keep as tab…" }));
    expect(screen.getByRole("button", { name: "Save and ask the agent" })).toBeDisabled();
    expect(screen.getByText(/No agent here to ask/)).toBeInTheDocument();
  });

  it("offers a view the person keeps coming back to as a tab, until they say not now", async () => {
    const hour = 60 * 60 * 1000;
    noteShown("/work/roer", "demo", Date.now() - 3 * hour);
    noteShown("/work/roer", "demo", Date.now() - 2 * hour);
    const { unmount } = render(
      <GenerativeUITab state={applyAll(messages)} surfaceId="demo" onChange={vi.fn()} log={messages} live cwd="/work/roer" pane="%7" onLoadBundle={vi.fn()} agentState="done" />,
    );
    expect(await screen.findByText(/You keep coming back to this view/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/You keep coming back/)).toBeNull();
    expect(screen.getByRole("button", { name: "Keep as tab…" })).toBeInTheDocument();
    unmount();

    renderTab({ pane: "%7", log: [...messages] });
    await screen.findByRole("button", { name: "Keep as tab…" });
    expect(screen.queryByText(/You keep coming back/)).toBeNull();
  });

  it("does not offer a tab for a view seen only once", async () => {
    renderTab({ pane: "%7" });
    await screen.findByRole("button", { name: "Keep as tab…" });
    expect(screen.queryByText(/You keep coming back/)).toBeNull();
  });

  it("points to a new tab before any view arrives", () => {
    const onNewTab = vi.fn();
    renderTab({ live: false, onNewTab });
    fireEvent.click(screen.getByRole("button", { name: "New tab…" }));
    expect(onNewTab).toHaveBeenCalled();
  });

  it("says when keeping a view as a tab replaces a saved one of that name", async () => {
    vi.mocked(listPluginUiBundles).mockResolvedValue([{ name: "demo", prompt: "older" }]);
    render(
      <GenerativeUITab state={applyAll(messages)} surfaceId="demo" onChange={vi.fn()} log={messages} live cwd="/work/roer" pane="%7" onLoadBundle={vi.fn()} agentState="done" />,
    );
    await waitFor(() => expect(listPluginUiBundles).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Keep as tab…" }));
    expect(await screen.findByText(/Replaces the saved view “demo”/)).toBeInTheDocument();
  });

  it("loads a saved bundle as its one createSurface", async () => {
    vi.mocked(listPluginUiBundles).mockResolvedValue([{ name: "test-runner", prompt: "" }]);
    const surface: A2uiMessage & { createSurface: unknown } = {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId: "test-runner",
        components: [{ id: "root", component: "Text", text: "loaded" }],
      },
    };
    vi.mocked(readPluginUiBundle).mockResolvedValue({ prompt: "Add a test runner", surface });
    const { onLoadBundle } = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    fireEvent.click(await screen.findByRole("button", { name: "test-runner" }));

    await waitFor(() => expect(onLoadBundle).toHaveBeenCalledWith("test-runner", [surface]));
    expect(writePluginUiBundle).not.toHaveBeenCalled();
  });

  it("upgrades a bundle saved before v1.0 and writes it back once", async () => {
    vi.mocked(listPluginUiBundles).mockResolvedValue([{ name: "old", prompt: "" }]);
    vi.mocked(readPluginUiBundle).mockResolvedValue({
      prompt: "An old one",
      legacy: {
        surfaceUpdate: {
          kind: "surfaceUpdate",
          surfaceId: "old",
          root: "card",
          components: [{ id: "card", type: "Text", text: "loaded" }],
        },
      },
    });
    vi.mocked(writePluginUiBundle).mockResolvedValue(undefined);
    const { onLoadBundle } = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    fireEvent.click(await screen.findByRole("button", { name: "old" }));

    const upgraded = {
      version: "v1.0",
      createSurface: {
        surfaceId: "old",
        catalogId: "roer:catalog/1",
        sendDataModel: true,
        components: [{ id: "root", component: "Text", text: "loaded" }],
      },
    };
    await waitFor(() => expect(onLoadBundle).toHaveBeenCalledWith("old", [upgraded]));
    expect(writePluginUiBundle).toHaveBeenCalledWith("/work/roer", "old", { prompt: "An old one", surface: upgraded });
  });
});

describe("GenerativeUITab and an idle agent", () => {
  const button: A2uiMessage[] = [
    {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId: "demo",
        components: [
          { id: "root", component: "Button", child: "l", action: { event: { name: "go" } } },
          { id: "l", component: "Text", text: "Go" },
        ],
      },
    },
  ];
  const props = (agentState?: "working" | "waiting" | "done" | "") => ({
    state: applyAll(button),
    surfaceId: "demo",
    onChange: vi.fn(),
    log: button,
    live: true,
    pane: "%3",
    onLoadBundle: vi.fn(),
    agentState,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reportPluginUiAction).mockResolvedValue(undefined);
  });

  it("asks an agent sitting at its prompt to look, once the click is on file, and only once until it moves", async () => {
    const { rerender } = render(<GenerativeUITab {...props("done")} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%3", NUDGE));
    expect(vi.mocked(reportPluginUiAction).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendToSession).mock.invocationCallOrder[0],
    );
    expect(screen.getByText(/Asked the agent to look/)).toBeInTheDocument();

    // A second click before its turn starts would queue a second prompt.
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(reportPluginUiAction).toHaveBeenCalledTimes(2));
    expect(sendToSession).toHaveBeenCalledTimes(1);

    // Its turn ran and ended: the next click nudges again.
    rerender(<GenerativeUITab {...props("working")} />);
    rerender(<GenerativeUITab {...props("done")} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(2));
  });

  it("does not type onto what the person has started typing since the agent's turn began", async () => {
    const pane = "%7";
    const { rerender } = render(<GenerativeUITab {...props("working")} pane={pane} />);
    rerender(<GenerativeUITab {...props("done")} pane={pane} />);
    noteTyped(pane, Date.now() + 1);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(reportPluginUiAction).toHaveBeenCalledTimes(1));
    expect(sendToSession).not.toHaveBeenCalled();
    expect(screen.getByText(/sees it with your next message/)).toBeInTheDocument();
  });

  it("asks again on the next click when asking failed", async () => {
    vi.mocked(sendToSession).mockRejectedValueOnce(new Error("no such pane"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<GenerativeUITab {...props("done")} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(screen.getByText(/sees it with your next message/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(2));
  });

  it("says so and asks nothing when the click could not be put on file", async () => {
    vi.mocked(reportPluginUiAction).mockRejectedValueOnce(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<GenerativeUITab {...props("done")} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("Could not send “go” to the agent.")).toBeInTheDocument();
    expect(sendToSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(1));
  });

  it("leaves a working or waiting agent alone, and says when it will see the click", async () => {
    const { rerender } = render(<GenerativeUITab {...props("working")} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByText(/sees it at its next step/)).toBeInTheDocument();

    rerender(<GenerativeUITab {...props("waiting")} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByText(/waiting for you in the terminal/)).toBeInTheDocument();

    rerender(<GenerativeUITab {...props(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(reportPluginUiAction).toHaveBeenCalledTimes(3));
    expect(sendToSession).not.toHaveBeenCalled();
  });
});
