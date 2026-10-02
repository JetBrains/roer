import { afterEach, describe, expect, it } from "vitest";

import {
  isGoToFile,
  isNewSession,
  isNextCommit,
  isNextWaiting,
  isPreviousSession,
  isPrevCommit,
  isShortcuts,
  shortcutLabel,
  tabNumber,
} from "./keys";

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

  it("number the fixed tabs, by the physical digit key", () => {
    expect(tabNumber(key({ code: "Digit3", key: "3", metaKey: true }))).toBe(3);
    expect(tabNumber(key({ code: "Digit9", key: "9", metaKey: true }))).toBe(9);
    expect(tabNumber(key({ code: "Digit0", key: "0", metaKey: true }))).toBeNull();
    expect(tabNumber(key({ code: "Digit1", key: "1" }))).toBeNull();
    expect(isShortcuts(key({ code: "Slash", key: "/", metaKey: true }))).toBe(true);
    onPlatform("Linux x86_64");
    // Shift turns the digit into its symbol; the code is still the digit.
    expect(tabNumber(key({ code: "Digit2", key: "@", ctrlKey: true, shiftKey: true }))).toBe(2);
    expect(tabNumber(key({ code: "Digit2", key: "2", ctrlKey: true }))).toBeNull();
    expect(isShortcuts(key({ code: "Slash", key: "?", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shortcutLabel.tab(2)).toBe("Ctrl+Shift+2");
  });

  it("jump to the next waiting session and back to the previous one", () => {
    expect(isNextWaiting(key({ code: "KeyJ", key: "J", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isNextWaiting(key({ code: "KeyJ", key: "j", metaKey: true }))).toBe(false);
    expect(isPreviousSession(key({ code: "Tab", key: "Tab", ctrlKey: true }))).toBe(true);
    expect(isPreviousSession(key({ code: "Tab", key: "Tab" }))).toBe(false);
    onPlatform("Linux x86_64");
    expect(isNextWaiting(key({ code: "KeyJ", key: "J", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPreviousSession(key({ code: "Tab", key: "Tab", ctrlKey: true }))).toBe(true);
    expect(shortcutLabel.nextWaiting()).toBe("Ctrl+Shift+J");
  });
});
