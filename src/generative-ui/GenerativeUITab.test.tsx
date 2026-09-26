import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyAll } from "./apply";
import { GenerativeUITab } from "./GenerativeUITab";
import { A2UI_VERSION, type A2uiMessage } from "./schema";
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
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
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

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
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
