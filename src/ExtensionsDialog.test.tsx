import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExtensionsDialog } from "./ExtensionsDialog";
import { listDisabled, listExtensions, setExtensionEnabled, type ExtensionInfo } from "./extensions/loader";

vi.mock("./extensions/loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extensions/loader")>()),
  listExtensions: vi.fn(),
  listDisabled: vi.fn(),
  setExtensionEnabled: vi.fn(),
}));

vi.mock("./lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/backend")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const info = (over: Partial<ExtensionInfo>): ExtensionInfo => ({
  id: "weather",
  name: "Weather",
  description: "The forecast",
  scope: "user",
  dir: "/home/.roer/extensions/weather",
  hash: "h",
  ok: true,
  hasApp: true,
  errors: [],
  builtAt: 1,
  ...over,
});

beforeEach(() => {
  vi.mocked(listExtensions).mockResolvedValue([
    info({}),
    info({ id: "central", name: "Central", scope: "session", ok: false, errors: ["app.tsx:3: Unexpected token"] }),
    info({ id: "dog-walk", name: "Dog Walk", disabled: true }),
  ]);
  vi.mocked(listDisabled).mockResolvedValue(["dog-walk"]);
  vi.mocked(setExtensionEnabled).mockReset().mockResolvedValue(undefined);
});

describe("ExtensionsDialog", () => {
  it("lists built-in extensions and yours, with what is wrong with each", async () => {
    render(<ExtensionsDialog onClose={vi.fn()} />);
    expect(await screen.findByText("Weather")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Weather enabled" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Dog Walk enabled" })).not.toBeChecked();
    expect(screen.getByText("Build failed")).toBeInTheDocument();
    expect(screen.getByText("app.tsx:3: Unexpected token")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
  });

  it("switches an extension off and on, built-in ones too", async () => {
    render(<ExtensionsDialog onClose={vi.fn()} />);
    await screen.findByText("Weather");
    fireEvent.click(screen.getByRole("switch", { name: "Weather enabled" }));
    expect(setExtensionEnabled).toHaveBeenCalledWith("weather", false);
    expect(screen.getByRole("switch", { name: "Weather enabled" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("switch", { name: "Dog Walk enabled" }));
    expect(setExtensionEnabled).toHaveBeenCalledWith("dog-walk", true);

    fireEvent.click(screen.getByRole("switch", { name: "Review enabled" }));
    expect(setExtensionEnabled).toHaveBeenCalledWith("code-review", false);
  });

  it("puts a switch back when the backend refuses it", async () => {
    vi.mocked(setExtensionEnabled).mockRejectedValue("permission denied");
    render(<ExtensionsDialog onClose={vi.fn()} />);
    await screen.findByText("Weather");
    fireEvent.click(screen.getByRole("switch", { name: "Weather enabled" }));
    expect(await screen.findByText("permission denied")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Weather enabled" })).toBeChecked());
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ExtensionsDialog onClose={onClose} />);
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "Extensions" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
