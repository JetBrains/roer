/** Application-wide keyboard shortcuts. */
import { useEffect } from "react";

/**
 * Runs `handler` for every keydown `match` accepts, anywhere in the window.
 *
 * Registered in the capture phase, which is the whole reason a shortcut works
 * while you are typing in the terminal: xterm.js listens on its own textarea
 * deep inside the stage, and capture on `window` runs before any listener on a
 * descendant. The handler stops the event there, so the key never reaches the
 * PTY.
 */
export function useHotkey(match: (event: KeyboardEvent) => boolean, handler: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!match(event)) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [match, handler]);
}

/**
 * Whether shortcuts follow macOS, where the app owns `Cmd`. Asked on every
 * keystroke rather than once, so a test can switch platform.
 *
 * Elsewhere `Ctrl` is the app's modifier, but `Ctrl` alone belongs to the
 * terminal — `Ctrl+T` and `Ctrl+Left` mean something to a shell and to Claude
 * Code — so the app takes `Ctrl+Shift`, the way a Linux terminal emulator
 * does for its own tabs, and `Alt` plus an arrow for back and forward, the
 * way a Linux browser does.
 */
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);

/** Exactly `Cmd` on macOS, exactly `Ctrl+Shift` elsewhere. */
const appChord = (event: KeyboardEvent, shift: boolean): boolean =>
  isMac()
    ? event.metaKey && event.shiftKey === shift && !event.ctrlKey && !event.altKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;

/** Exactly `Cmd` on macOS, exactly `Alt` elsewhere. */
const navChord = (event: KeyboardEvent): boolean =>
  isMac()
    ? event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey
    : event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;

/** How each shortcut is written on this platform, for titles and hints. */
export const shortcutLabel = {
  newSession: () => (isMac() ? "⌘T" : "Ctrl+Shift+T"),
  prevCommit: () => (isMac() ? "⌘←" : "Alt+←"),
  nextCommit: () => (isMac() ? "⌘→" : "Alt+→"),
};

/**
 * IntelliJ's Go to File: `Cmd+Shift+O` (`Ctrl+Shift+O` off macOS).
 *
 * Matched on `code` — the physical key — rather than `key`, which under
 * Cmd+Shift is not `"O"` on every keyboard layout. `key` is accepted as a
 * fallback for anything that reports no `code`, which is how jsdom and some
 * remote-desktop layers behave.
 */
export const isGoToFile = (event: KeyboardEvent): boolean =>
  appChord(event, true) &&
  (event.code === "KeyO" || (!event.code && event.key.toLowerCase() === "o"));

/**
 * New session: `Cmd+T`, the same key a browser uses for a new tab — this
 * app's sessions are the closest thing it has to tabs. `Ctrl+Shift+T` off
 * macOS, a Linux terminal's new tab.
 */
export const isNewSession = (event: KeyboardEvent): boolean =>
  appChord(event, false) &&
  (event.code === "KeyT" || (!event.code && event.key.toLowerCase() === "t"));

/**
 * Step to the previous commit in a branch diff: `Cmd+Left`, the same key a
 * browser binds to "back" — moving through a list of commits is the same
 * kind of move. `Alt+Left` off macOS, for the same reason.
 */
export const isPrevCommit = (event: KeyboardEvent): boolean =>
  navChord(event) &&
  (event.code === "ArrowLeft" || (!event.code && event.key === "ArrowLeft"));

/** The next commit in a branch diff: `Cmd+Right` (`Alt+Right`), "forward". */
export const isNextCommit = (event: KeyboardEvent): boolean =>
  navChord(event) &&
  (event.code === "ArrowRight" || (!event.code && event.key === "ArrowRight"));
