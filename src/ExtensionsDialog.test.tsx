import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExtensionsDialog } from "./ExtensionsDialog";
import { listDisabled, listExtensions, setExtensionEnabled, type ExtensionInfo } from "./extensions/loader";
import { connectOtherApp, otherApps, type OtherApp } from "./lib/otherApps";

vi.mock("./extensions/loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extensions/loader")>()),
  listExtensions: vi.fn(),
  listDisabled: vi.fn(),
  setExtensionEnabled: vi.fn(),
}));

vi.mock("./lib/otherApps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/otherApps")>()),
  otherApps: vi.fn(),
  connectOtherApp: vi.fn(),
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
  vi.mocked(otherApps).mockResolvedValue(APPS);
  vi.mocked(connectOtherApp).mockReset();
});

const APPS: OtherApp[] = [
  { id: "claude-desktop", name: "Claude app", state: "off", config: "/home/Claude/claude_desktop_config.json" },
  { id: "codex", name: "Codex", state: "theirs", command: "/mine/roer", config: "/home/.codex/config.toml" },
];

describe("ExtensionsDialog", () => {
  it("lists built-in extensions and yours, with what is wrong with each", async () => {
    render(<ExtensionsDialog onClose={vi.fn()} />);
    expect(await screen.findByText("Weather")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("switch", { name: "Changes enabled" }));
    expect(setExtensionEnabled).toHaveBeenCalledWith("changes", false);
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

describe("ExtensionsDialog with none of your own", () => {
  it("points to a new tab", async () => {
    vi.mocked(listExtensions).mockResolvedValue([]);
    vi.mocked(listDisabled).mockResolvedValue([]);
    const onNewTab = vi.fn();
    render(<ExtensionsDialog onClose={vi.fn()} onNewTab={onNewTab} />);
    expect(await screen.findByText("No extensions of your own yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New extension…" }));
    expect(onNewTab).toHaveBeenCalled();
  });

  it("marks the extensions that open in other apps", async () => {
    vi.mocked(listExtensions).mockResolvedValue([info({ hosts: ["mcp-app"] }), info({ id: "central", name: "Central" })]);
    render(<ExtensionsDialog onClose={vi.fn()} />);
    await screen.findByText("Weather");
    const central = screen.getByText("Central").closest("li")!;
    expect(central.textContent).not.toContain("Other apps");
    expect(screen.getByText("Weather").closest("li")!.textContent).toContain("Other apps");
  });

  it("connects an app, and leaves one the person set up alone", async () => {
    vi.mocked(connectOtherApp).mockResolvedValue([{ ...APPS[0], state: "connected", command: "/app/roer" }, APPS[1]]);
    render(<ExtensionsDialog onClose={vi.fn()} />);
    const claude = (await screen.findByText("Claude app")).closest("li")!;
    const codex = screen.getByText("Codex").closest("li")!;
    expect(codex.querySelector("button")).toBeNull();
    expect(codex.textContent).toContain("you set up yourself");
    fireEvent.click(claude.querySelector("button")!);
    expect(connectOtherApp).toHaveBeenCalledWith("claude-desktop", true);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("says what went wrong connecting without hiding the extensions' own errors", async () => {
    vi.mocked(connectOtherApp).mockRejectedValue("codex not found");
    render(<ExtensionsDialog onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("codex not found")).toBeInTheDocument();
  });
});
