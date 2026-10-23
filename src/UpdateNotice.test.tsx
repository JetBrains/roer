import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve());
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("./lib/backend", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

import { UpdateNotice } from "./UpdateNotice";

const update = {
  current: "0.9.2",
  latest: "0.9.3",
  newer: true,
  skipped: false,
  url: "https://github.com/JetBrains/roer/releases/tag/v0.9.3",
  canInstall: false,
};

const progress = (payload: unknown) => act(() => listeners.get("roer://update-progress")?.({ payload }));

describe("the update notice", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(() => Promise.resolve());
  });

  it("opens the release's page to download it", () => {
    const onClose = vi.fn();
    render(<UpdateNotice update={update} onClose={onClose} />);
    expect(screen.getByText("Roer 0.9.3 is available")).toBeInTheDocument();
    expect(screen.queryByText("Update and restart")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Download"));
    expect(invoke).toHaveBeenCalledWith("open_url", { url: update.url });
    expect(onClose).toHaveBeenCalled();
  });

  it("remembers a skipped version, and a later one only closes", () => {
    const onClose = vi.fn();
    render(<UpdateNotice update={update} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Later"));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Skip"));
    expect(invoke).toHaveBeenCalledWith("update_skip", { version: "0.9.3" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("installs in place where it can, and says how far it got", async () => {
    // The app quits once it is installed, so the call never settles.
    invoke.mockImplementation(() => new Promise(() => undefined));
    render(<UpdateNotice update={{ ...update, canInstall: true }} onClose={vi.fn()} />);
    expect(screen.queryByText("Download")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Update and restart"));
    expect(invoke).toHaveBeenCalledWith("update_install", { version: "0.9.3" });
    expect(screen.getByText("Downloading Roer 0.9.3… 0 MB")).toBeInTheDocument();
    await progress({ stage: "download", received: 12_500_000, total: 25_000_000 });
    expect(screen.getByText("Downloading Roer 0.9.3… 50%")).toBeInTheDocument();
    await progress({ stage: "verify", received: 0, total: null });
    expect(screen.getByText("Checking Roer 0.9.3…")).toBeInTheDocument();
    await progress({ stage: "restart", received: 0, total: null });
    expect(screen.getByText("Restarting Roer…")).toBeInTheDocument();
    expect(screen.queryByText("Skip")).not.toBeInTheDocument();
  });

  it("says why an install failed, and offers the download instead", async () => {
    invoke.mockImplementation((command) =>
      command === "update_install" ? Promise.reject("the downloaded setup is not signed by JetBrains") : Promise.resolve(),
    );
    const onClose = vi.fn();
    render(<UpdateNotice update={{ ...update, canInstall: true }} onClose={onClose} />);
    await act(async () => fireEvent.click(screen.getByText("Update and restart")));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not update: the downloaded setup is not signed by JetBrains");
    fireEvent.click(screen.getByText("Download"));
    expect(invoke).toHaveBeenCalledWith("open_url", { url: update.url });
    expect(onClose).toHaveBeenCalled();
  });
});
