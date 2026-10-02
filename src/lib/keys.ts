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
export function useHotkey(
  match: (event: KeyboardEvent) => boolean,
  handler: (event: KeyboardEvent) => void,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!match(event)) return;
      event.preventDefault();
      event.stopPropagation();
      handler(event);
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
  pickAgent: () => (isMac() ? "⌥⌘T" : "Ctrl+Alt+Shift+T"),
  agents: () => (isMac() ? "⌘," : "Ctrl+,"),
  goToFile: () => (isMac() ? "⌘⇧O" : "Ctrl+Shift+O"),
  tab: (n: number) => (isMac() ? `⌘${n}` : `Ctrl+Shift+${n}`),
  shortcuts: () => (isMac() ? "⌘/" : "Ctrl+Shift+/"),
  nextWaiting: () => (isMac() ? "⌘⇧J" : "Ctrl+Shift+J"),
  previousSession: () => (isMac() ? "⌃Tab" : "Ctrl+Tab"),
  prevCommit: () => (isMac() ? "⌘←" : "Alt+←"),
  nextCommit: () => (isMac() ? "⌘→" : "Alt+→"),
};

/** The strip's tabs before any extension adds its own. */
const DEFAULT_TABS = ["Sessions", "Terminal", "Changes", "Pull Request"];

/** Every shortcut, in the words the shortcut sheet lists them in. `tabs` are
 * the strip's, in order: the first nine have a number. */
export const allShortcuts = (tabs: readonly string[] = DEFAULT_TABS): Array<[string, string]> => [
  ["New session", shortcutLabel.newSession()],
  ["New session with another agent", shortcutLabel.pickAgent()],
  ["Search sessions and files", shortcutLabel.goToFile()],
  ["Next waiting session", shortcutLabel.nextWaiting()],
  ["Previous session", shortcutLabel.previousSession()],
  ...tabs.slice(0, 9).map((tab, i): [string, string] => [tab, shortcutLabel.tab(i + 1)]),
  ["Agents", shortcutLabel.agents()],
  ["Previous commit", shortcutLabel.prevCommit()],
  ["Next commit", shortcutLabel.nextCommit()],
  ["Keyboard shortcuts", shortcutLabel.shortcuts()],
];

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
 * Start a session with an agent other than the default: `Cmd+Option+T`, the
 * new-session key with Option for "the other kind".
 */
export const isPickAgent = (event: KeyboardEvent): boolean =>
  (isMac()
    ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey) &&
  (event.code === "KeyT" || (!event.code && event.key.toLowerCase() === "t"));

/**
 * Manage agents: `Cmd+,`, where every Mac app keeps its settings. The menu
 * item carries the key on macOS; this is for the other platforms, which have
 * no menu, and for a browser tab.
 */
export const isManageAgents = (event: KeyboardEvent): boolean =>
  (isMac()
    ? event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) &&
  (event.code === "Comma" || (!event.code && event.key === ","));

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

/**
 * Which of the strip's tabs to bring up: `Cmd+1` to `Cmd+9`, the keys a
 * browser and a terminal use for their tabs (`Ctrl+Shift` and a digit off
 * macOS). Matched on `code`, since `key` under Shift is the digit's symbol.
 * `null` for anything else.
 */
export const tabNumber = (event: KeyboardEvent): number | null => {
  if (!appChord(event, false)) return null;
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1] ?? (!event.code && /^[1-9]$/.test(event.key) ? event.key : null);
  return digit ? Number(digit) : null;
};

export const isTabNumber = (event: KeyboardEvent): boolean => tabNumber(event) !== null;

/** The shortcut sheet: `Cmd+/` (`Ctrl+Shift+/`). */
export const isShortcuts = (event: KeyboardEvent): boolean =>
  appChord(event, false) && (event.code === "Slash" || (!event.code && event.key === "/"));

/**
 * Jump to the next session waiting for you: `Cmd+Shift+J` (`Ctrl+Shift+J`).
 * Not `U`, for "unread": `Ctrl+Shift+U` is how GTK types a character by its
 * code point, and the input method takes it before the window sees it.
 */
export const isNextWaiting = (event: KeyboardEvent): boolean =>
  appChord(event, true) && (event.code === "KeyJ" || (!event.code && event.key.toLowerCase() === "j"));

/** Back to the session that was on the stage before this one: `Ctrl+Tab`,
 * everywhere — a shell has no use for it, and it is the key for "the other
 * one" in every tabbed app. */
export const isPreviousSession = (event: KeyboardEvent): boolean =>
  event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.code === "Tab" || event.key === "Tab");
