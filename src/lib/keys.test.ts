import { afterEach, describe, expect, it } from "vitest";

import { isGoToFile, isNewSession, isNextCommit, isPrevCommit, shortcutLabel } from "./keys";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

const onPlatform = (platform: string) =>
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });

describe("shortcuts", () => {
  afterEach(() => onPlatform("MacIntel"));

  it("use Cmd on macOS", () => {
    expect(isNewSession(key({ code: "KeyT", metaKey: true }))).toBe(true);
    expect(isGoToFile(key({ code: "KeyO", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isPrevCommit(key({ code: "ArrowLeft", metaKey: true }))).toBe(true);
    expect(isNewSession(key({ code: "KeyT", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(shortcutLabel.newSession()).toBe("⌘T");
  });

  it("use Ctrl+Shift and Alt on Linux", () => {
    onPlatform("Linux x86_64");
    expect(isNewSession(key({ code: "KeyT", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isGoToFile(key({ code: "KeyO", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPrevCommit(key({ code: "ArrowLeft", altKey: true }))).toBe(true);
    expect(isNextCommit(key({ code: "ArrowRight", altKey: true }))).toBe(true);
    expect(shortcutLabel.newSession()).toBe("Ctrl+Shift+T");
  });

  it("leave the terminal's own Ctrl keys alone on Linux", () => {
    onPlatform("Linux x86_64");
    // Readline's transpose-chars and forward-word, and Cmd, which Linux
    // delivers as Super to the window manager rather than to the app.
    expect(isNewSession(key({ code: "KeyT", ctrlKey: true }))).toBe(false);
    expect(isNextCommit(key({ code: "ArrowRight", ctrlKey: true }))).toBe(false);
    expect(isNewSession(key({ code: "KeyT", metaKey: true }))).toBe(false);
  });
});
