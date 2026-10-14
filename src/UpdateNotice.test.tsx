import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("./lib/backend", () => ({ invoke: (...args: unknown[]) => invoke(...args), listen: vi.fn() }));

import { UpdateNotice } from "./UpdateNotice";

const update = {
  current: "0.9.2",
  latest: "0.9.3",
  newer: true,
  skipped: false,
  url: "https://github.com/JetBrains/roer/releases/tag/v0.9.3",
};

describe("the update notice", () => {
  beforeEach(() => invoke.mockClear());

  it("opens the release's page to download it", () => {
    const onClose = vi.fn();
    render(<UpdateNotice update={update} onClose={onClose} />);
    expect(screen.getByText("Roer 0.9.3 is available")).toBeInTheDocument();
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
});
