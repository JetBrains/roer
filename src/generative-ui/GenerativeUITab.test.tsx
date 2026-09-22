import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyAll } from "./apply";
import { GenerativeUITab } from "./GenerativeUITab";
import type { A2uiMessage } from "./schema";
import {
  listPluginUiBundles,
  readPluginUiBundle,
  writePluginUiBundle,
} from "../lib/pluginUi";

vi.mock("../lib/pluginUi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/pluginUi")>()),
  listPluginUiBundles: vi.fn(),
  readPluginUiBundle: vi.fn(),
  writePluginUiBundle: vi.fn(),
  reportPluginUiAction: vi.fn(),
}));

const messages: A2uiMessage[] = [
  {
    kind: "surfaceUpdate",
    surfaceId: "demo",
    root: "card",
    components: [{ id: "card", type: "Text", text: "hi" }],
  },
  { kind: "beginRendering", surfaceId: "demo" },
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
    vi.mocked(listPluginUiBundles).mockResolvedValue([]);
  });

  it("hides the saved-bundles section without a cwd", () => {
    renderTab({ cwd: undefined });
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  });

  it("lists saved bundles for the session's project", async () => {
    vi.mocked(listPluginUiBundles).mockResolvedValue([
      { name: "test-runner", prompt: "Add a test runner" },
    ]);
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByText("test-runner")).toBeInTheDocument();
    expect(screen.getByText(/Add a test runner/)).toBeInTheDocument();
    expect(listPluginUiBundles).toHaveBeenCalledWith("/work/roer");
  });

  it("saves the current surface under the typed name", async () => {
    vi.mocked(writePluginUiBundle).mockResolvedValue(undefined);
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByPlaceholderText("save as…"), {
      target: { value: "test-runner" },
    });
    fireEvent.change(screen.getByPlaceholderText(/prompt that built this/), {
      target: { value: "Add a test runner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(writePluginUiBundle).toHaveBeenCalledWith("/work/roer", "test-runner", {
        prompt: "Add a test runner",
        surfaceUpdate: {
          kind: "surfaceUpdate",
          surfaceId: "demo",
          root: "card",
          components: [{ id: "card", type: "Text", text: "hi" }],
        },
        dataModelUpdate: undefined,
      }),
    );
    expect(await screen.findByText(/Saved as "test-runner"/)).toBeInTheDocument();
  });

  it("disables Save until a name is typed", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("loads a saved bundle by replaying it as surfaceUpdate/beginRendering", async () => {
    vi.mocked(listPluginUiBundles).mockResolvedValue([
      { name: "test-runner", prompt: "" },
    ]);
    vi.mocked(readPluginUiBundle).mockResolvedValue({
      prompt: "Add a test runner",
      surfaceUpdate: {
        kind: "surfaceUpdate",
        surfaceId: "test-runner",
        root: "card",
        components: [{ id: "card", type: "Text", text: "loaded" }],
      },
    });
    const { onLoadBundle } = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "test-runner" }));

    await waitFor(() =>
      expect(onLoadBundle).toHaveBeenCalledWith("test-runner", [
        {
          kind: "surfaceUpdate",
          surfaceId: "test-runner",
          root: "card",
          components: [{ id: "card", type: "Text", text: "loaded" }],
        },
        { kind: "beginRendering", surfaceId: "test-runner" },
      ]),
    );
  });
});
