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
 * IntelliJ's Go to File: `Cmd+Shift+O`.
 *
 * Matched on `code` — the physical key — rather than `key`, which under
 * Cmd+Shift is not `"O"` on every keyboard layout. `key` is accepted as a
 * fallback for anything that reports no `code`, which is how jsdom and some
 * remote-desktop layers behave.
 */
export const isGoToFile = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey &&
  (event.code === "KeyO" || (!event.code && event.key.toLowerCase() === "o"));

/**
 * New session: `Cmd+T`, the same key a browser uses for a new tab — this
 * app's sessions are the closest thing it has to tabs.
 */
export const isNewSession = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  !event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey &&
  (event.code === "KeyT" || (!event.code && event.key.toLowerCase() === "t"));

/**
 * Step to the previous commit in a branch diff: `Cmd+Left`, the same key a
 * browser binds to "back" — moving through a list of commits is the same
 * kind of move.
 */
export const isPrevCommit = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  !event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey &&
  (event.code === "ArrowLeft" || (!event.code && event.key === "ArrowLeft"));

/** The next commit in a branch diff: `Cmd+Right`, a browser's "forward". */
export const isNextCommit = (event: KeyboardEvent): boolean =>
  event.metaKey &&
  !event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey &&
  (event.code === "ArrowRight" || (!event.code && event.key === "ArrowRight"));
