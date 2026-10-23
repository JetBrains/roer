import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fontStep,
  isCloseTab,
  isGoToFile,
  isNewSession,
  isNewWorktree,
  isNextCommit,
  isNextWaiting,
  isPreviousSession,
  isPrevCommit,
  isShortcuts,
  refusal,
  setCustomChords,
  setRecording,
  shortcutLabel,
  tabNumber,
  useHotkey,
  type Chord,
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

  it("open the new session picker on Cmd+Shift+N, and Ctrl+Shift+N off macOS", () => {
    expect(isNewWorktree(key({ code: "KeyN", metaKey: true, shiftKey: true }))).toBe(true);
    // Without the shift it is no new place, and the other modifiers are not it.
    expect(isNewWorktree(key({ code: "KeyN", metaKey: true }))).toBe(false);
    expect(isNewWorktree(key({ code: "KeyN", metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isNewWorktree(key({ code: "KeyN", metaKey: true, shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isNewWorktree(key({ code: "KeyN", ctrlKey: true, shiftKey: true }))).toBe(false);
    // A layout that reports no code still has the letter.
    expect(isNewWorktree(key({ key: "N", metaKey: true, shiftKey: true }))).toBe(true);
    expect(shortcutLabel.newWorktree()).toBe("⇧⌘N");

    onPlatform("Linux x86_64");
    expect(isNewWorktree(key({ code: "KeyN", ctrlKey: true, shiftKey: true }))).toBe(true);
    // Ctrl+N alone is the shell's, and Cmd is not this platform's modifier.
    expect(isNewWorktree(key({ code: "KeyN", ctrlKey: true }))).toBe(false);
    expect(isNewWorktree(key({ code: "KeyN", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isNewWorktree(key({ code: "KeyN", ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(shortcutLabel.newWorktree()).toBe("Ctrl+Shift+N");
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

  it("close a tab with Cmd+W, Ctrl+Shift+W off macOS", () => {
    expect(isCloseTab(key({ code: "KeyW", key: "w", metaKey: true }))).toBe(true);
    // Cmd+Shift+W is the window's.
    expect(isCloseTab(key({ code: "KeyW", key: "W", metaKey: true, shiftKey: true }))).toBe(false);
    onPlatform("Linux x86_64");
    // Ctrl+W deletes a word in the shell.
    expect(isCloseTab(key({ code: "KeyW", key: "w", ctrlKey: true }))).toBe(false);
    expect(isCloseTab(key({ code: "KeyW", key: "W", ctrlKey: true, shiftKey: true }))).toBe(true);
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

describe("the person's own keys", () => {
  const cmd = (code: string, more: Partial<Chord> = {}): Chord => ({ meta: true, ctrl: false, alt: false, shift: false, code, ...more });
  afterEach(() => {
    setCustomChords({});
    setRecording(false);
    onPlatform("MacIntel");
  });

  it("move an action to its new key, label and all, and off the old one", () => {
    setCustomChords({ newSession: cmd("KeyK") });
    expect(isNewSession(key({ code: "KeyK", metaKey: true }))).toBe(true);
    expect(isNewSession(key({ code: "KeyT", metaKey: true }))).toBe(false);
    expect(shortcutLabel.newSession()).toBe("⌘K");
    // An action the app does not have is left out.
    setCustomChords({ nonsense: cmd("KeyZ") });
    expect(shortcutLabel.newSession()).toBe("⌘T");
  });

  it("are refused where they would be typed, taken from the system or a tab, or already another's", () => {
    expect(refusal("newSession", { ...cmd("KeyK"), meta: false })).toMatch(/so typing never sets it off/);
    expect(refusal("newSession", cmd("KeyQ"))).toMatch(/macOS keeps/);
    expect(refusal("newSession", cmd("KeyW", { shift: true }))).toMatch(/closes the window/);
    expect(refusal("newSession", cmd("Digit3"))).toMatch(/tab 3/);
    expect(refusal("newSession", cmd("KeyO", { shift: true }))).toBe("Search sessions and files is on it already.");
    expect(refusal("newSession", cmd("KeyK"))).toBeNull();
    // Its own key is not someone else's.
    expect(refusal("newSession", cmd("KeyT"))).toBeNull();
    onPlatform("Linux x86_64");
    expect(refusal("newSession", { meta: false, ctrl: true, alt: false, shift: true, code: "Digit2" })).toMatch(/tab 2/);
  });

  it("are not set off while one is being recorded", () => {
    const handler = vi.fn();
    renderHook(() => useHotkey(isNewSession, handler));
    setRecording(true);
    window.dispatchEvent(key({ code: "KeyT", metaKey: true }));
    expect(handler).not.toHaveBeenCalled();
    setRecording(false);
    window.dispatchEvent(key({ code: "KeyT", metaKey: true }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("step the text size with a browser's zoom keys", () => {
    expect(fontStep(key({ code: "Equal", metaKey: true }))).toBe(1);
    expect(fontStep(key({ code: "Equal", metaKey: true, shiftKey: true }))).toBe(1);
    expect(fontStep(key({ code: "Minus", metaKey: true }))).toBe(-1);
    expect(fontStep(key({ code: "Digit0", metaKey: true }))).toBe(0);
    expect(fontStep(key({ key: "=", metaKey: true }))).toBe(1);
    expect(fontStep(key({ code: "Minus", metaKey: true, shiftKey: true }))).toBeNull();
    expect(fontStep(key({ code: "Digit1", metaKey: true }))).toBeNull();
    expect(refusal("newSession", cmd("Minus"))).toMatch(/text size/);
    onPlatform("Linux x86_64");
    // Ctrl+- alone is the shell's undo.
    expect(fontStep(key({ code: "Minus", ctrlKey: true }))).toBeNull();
    expect(fontStep(key({ code: "Minus", ctrlKey: true, shiftKey: true }))).toBe(-1);
    expect(fontStep(key({ code: "Equal", ctrlKey: true, shiftKey: true }))).toBe(1);
  });
});
