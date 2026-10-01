import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { notify } from "./notify";

beforeEach(() => {
  localStorage.clear();
  invoke.mockClear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

it("shows nothing, and asks nothing, while notifications are off", async () => {
  localStorage.setItem("roer:notifications", "off");
  await notify("fixing tests", "claude is waiting for you");
  expect(invoke).not.toHaveBeenCalled();
});

it("shows a notification while they are on", async () => {
  await notify("fixing tests", "claude is waiting for you");
  expect(invoke).toHaveBeenCalledWith("plugin:notification|notify", {
    options: { title: "fixing tests", body: "claude is waiting for you" },
  });
});
