/** Application-wide keyboard shortcuts. */
import { useEffect, useSyncExternalStore } from "react";

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
      // While a shortcut is being recorded, its keys are the recording's.
      if (recording || !match(event)) return;
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

/** Windows, where paths and shells quote differently. */
export const isWindows = (): boolean => /Win/.test(navigator.platform);

/** Exactly `Cmd` on macOS, exactly `Ctrl+Shift` elsewhere. */
const appChord = (event: KeyboardEvent, shift: boolean): boolean =>
  isMac()
    ? event.metaKey && event.shiftKey === shift && !event.ctrlKey && !event.altKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;

/** A key and exactly the modifiers held with it. `code` is the physical
 * key, as `KeyboardEvent.code` names it: under Shift or Option `key` is not
 * the same character on every layout. */
export interface Chord {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

/** The app's actions that a key is bound to, and the person may move. */
export type ActionId =
  | "newSession"
  | "pickAgent"
  | "newWorktree"
  | "goToFile"
  | "nextWaiting"
  | "previousSession"
  | "closeTab"
  | "agents"
  | "prevCommit"
  | "nextCommit"
  | "shortcuts";

const chord = (code: string, mods: Partial<Omit<Chord, "code">> = {}): Chord => ({
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
  code,
});

/** `Cmd` on macOS; `Ctrl+Shift` elsewhere, where `Ctrl` alone is the terminal's. */
const app = (code: string, shift = false): Chord =>
  isMac() ? chord(code, { meta: true, shift }) : chord(code, { ctrl: true, shift: true });

/** `Cmd` on macOS, `Alt` elsewhere: a browser's back and forward. */
const nav = (code: string): Chord => (isMac() ? chord(code, { meta: true }) : chord(code, { alt: true }));

/**
 * Each action's key out of the box, and why it is that key:
 * - New session, `Cmd+T`: a browser's new tab; this app's sessions are the
 *   nearest thing it has to tabs. `Ctrl+Shift+T` off macOS, a Linux
 *   terminal's.
 * - Another agent, `Cmd+Option+T`: the same, with Option for "the other kind".
 * - New worktree, `Cmd+Shift+N`: new as in a new place to work.
 * - Search, `Cmd+Shift+O`: IntelliJ's Go to File.
 * - Next waiting, `Cmd+Shift+J`. Not `U`, for "unread": `Ctrl+Shift+U` is how
 *   GTK types a character by its code point, and the input method takes it.
 * - Previous session, `Ctrl+Tab` everywhere: "the other one" in every tabbed
 *   app, and a shell has no use for it.
 * - Close, `Cmd+W`: a browser's and a terminal's close tab. The window is on
 *   `Cmd+Shift+W`.
 * - Agents, `Cmd+,`: where every Mac app keeps its settings.
 * - Commits, `Cmd+Left` and `Right` (`Alt` off macOS): back and forward.
 * - The sheet, `Cmd+/`.
 */
const defaults = (): Record<ActionId, Chord> => ({
  newSession: app("KeyT"),
  pickAgent: isMac() ? chord("KeyT", { meta: true, alt: true }) : chord("KeyT", { ctrl: true, alt: true, shift: true }),
  newWorktree: app("KeyN", true),
  goToFile: app("KeyO", true),
  nextWaiting: app("KeyJ", true),
  previousSession: chord("Tab", { ctrl: true }),
  closeTab: app("KeyW"),
  agents: isMac() ? chord("Comma", { meta: true }) : chord("Comma", { ctrl: true }),
  prevCommit: nav("ArrowLeft"),
  nextCommit: nav("ArrowRight"),
  shortcuts: app("Slash"),
});

/** Each action as the shortcut sheet names it, in the sheet's order. */
export const ACTIONS: ReadonlyArray<[ActionId, string]> = [
  ["newSession", "New session"],
  ["pickAgent", "New session with another agent"],
  ["newWorktree", "New session somewhere else, or in a new worktree"],
  ["goToFile", "Search sessions and files"],
  ["nextWaiting", "Next waiting session"],
  ["previousSession", "Previous session"],
  ["closeTab", "Close file tab, or release the session from Terminal"],
  ["agents", "Agents"],
  ["prevCommit", "Previous commit"],
  ["nextCommit", "Next commit"],
  ["shortcuts", "Keyboard shortcuts"],
];

// The person's own keys, by action, over the defaults; and who to tell when
// they change, so every title and hint says the key that works.
let overrides: Partial<Record<ActionId, Chord>> = {};
let version = 0;
const listeners = new Set<() => void>();
let recording = false;

/** The key `action` is on out of the box. */
export const defaultChordOf = (action: ActionId): Chord => defaults()[action];

/** The key `action` is on now. */
export const chordOf = (action: ActionId): Chord => overrides[action] ?? defaults()[action];

/** Whether `action` is off its default. */
export const isCustom = (action: ActionId): boolean => overrides[action] !== undefined;

/** The person's own keys, as they are kept. */
export const customChords = (): Partial<Record<ActionId, Chord>> => ({ ...overrides });

/** Takes the person's own keys, replacing the last; an unknown action is left out. */
export function setCustomChords(next: Partial<Record<string, Chord>>): void {
  const known = new Set(ACTIONS.map(([id]) => id));
  overrides = Object.fromEntries(Object.entries(next).filter(([id, one]) => known.has(id as ActionId) && one)) as Partial<
    Record<ActionId, Chord>
  >;
  version += 1;
  for (const listener of listeners) listener();
}

/** Re-renders with every change of the keys, for what shows them. */
export const useKeymap = (): number =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );

/** Holds every shortcut off while one is being recorded. */
export const setRecording = (on: boolean): void => {
  recording = on;
};

/** The key a `code` types, for an event that reports no `code`: jsdom, and
 * some remote-desktop layers. */
const keyOf = (code: string): string =>
  code.startsWith("Key") || code.startsWith("Digit")
    ? code.slice(code.startsWith("Key") ? 3 : 5).toLowerCase()
    : ({ Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", Space: " " } as Record<string, string>)[code] ?? code;

/** Whether `event` is exactly `chord`: its key, and no other modifier held. */
export const matchesChord = (chord: Chord, event: KeyboardEvent): boolean =>
  event.metaKey === chord.meta &&
  event.ctrlKey === chord.ctrl &&
  event.altKey === chord.alt &&
  event.shiftKey === chord.shift &&
  (event.code === chord.code || (!event.code && event.key.toLowerCase() === keyOf(chord.code).toLowerCase()));

/** The chord a keydown makes, or null for a modifier pressed alone. */
export function chordFrom(event: KeyboardEvent): Chord | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key) || !event.code) return null;
  return { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, code: event.code };
}

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** How a chord is written on this platform: `⌥⌘T`, `Ctrl+Alt+Shift+T`. */
export function chordLabel(chord: Chord): string {
  const key = chord.code.startsWith("Key")
    ? chord.code.slice(3)
    : chord.code.startsWith("Digit")
      ? chord.code.slice(5)
      : (KEY_NAMES[chord.code] ?? chord.code);
  if (isMac()) return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}${key}`;
  return [chord.ctrl && "Ctrl", chord.alt && "Alt", chord.shift && "Shift", chord.meta && "Meta", key].filter(Boolean).join("+");
}

const label = (action: ActionId) => () => chordLabel(chordOf(action));

/** How each shortcut is written on this platform, for titles and hints. */
export const shortcutLabel = {
  newSession: label("newSession"),
  pickAgent: label("pickAgent"),
  newWorktree: label("newWorktree"),
  agents: label("agents"),
  goToFile: label("goToFile"),
  tab: (n: number) => (isMac() ? `⌘${n}` : `Ctrl+Shift+${n}`),
  closeTab: label("closeTab"),
  shortcuts: label("shortcuts"),
  nextWaiting: label("nextWaiting"),
  previousSession: label("previousSession"),
  prevCommit: label("prevCommit"),
  nextCommit: label("nextCommit"),
};

/** Why `chord` cannot be `action`'s key, or null when it can: a key needs
 * Cmd, Ctrl or Alt with it, lest typing trigger it; and one the system, a
 * tab number or another action has is not taken from them. */
export function refusal(action: ActionId, chord: Chord): string | null {
  if (!chord.meta && !chord.ctrl && !chord.alt) {
    return `Hold ${isMac() ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} with it, so typing never sets it off.`;
  }
  const plain = !chord.ctrl && !chord.alt;
  if (isMac() && chord.meta && plain && !chord.shift && ["KeyQ", "KeyH", "KeyM"].includes(chord.code)) {
    return "macOS keeps that one.";
  }
  if (isMac() && chord.meta && plain && chord.shift && chord.code === "KeyW") return "That closes the window.";
  const tabMods = isMac() ? chord.meta && plain && !chord.shift : chord.ctrl && chord.shift && !chord.alt && !chord.meta;
  if (tabMods && /^Digit[1-9]$/.test(chord.code)) return `That brings up tab ${chord.code.slice(5)}.`;
  if (tabMods && ["Equal", "Minus", "Digit0"].includes(chord.code)) return "That sets the text size.";
  const taken = ACTIONS.find(([other]) => other !== action && sameChord(chordOf(other), chord));
  return taken ? `${taken[1]} is on it already.` : null;
}

export const sameChord = (a: Chord, b: Chord): boolean =>
  a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.code === b.code;

/** The strip's tabs before any extension adds its own. */
const DEFAULT_TABS = ["Workspace", "Terminal", "Changes"];

/** Every shortcut, in the words the shortcut sheet lists them in. `tabs` are
 * the strip's, in order: the first nine have a number. */
export const allShortcuts = (tabs: readonly string[] = DEFAULT_TABS): Array<[string, string]> => {
  const of = (id: ActionId): [string, string] => [ACTIONS.find(([one]) => one === id)![1], chordLabel(chordOf(id))];
  return [
    ...(["newSession", "pickAgent", "newWorktree", "goToFile", "nextWaiting", "previousSession"] as const).map(of),
    ...tabs.slice(0, 9).map((tab, i): [string, string] => [tab, shortcutLabel.tab(i + 1)]),
    ...(["closeTab", "agents", "prevCommit", "nextCommit", "shortcuts"] as const).map(of),
    ...fontSizeShortcuts(),
  ];
};

// Each action's matcher, on whichever key it is on now: see `defaults` for
// why each is where it is out of the box. Asked on every keystroke, so a key
// the person moves works at once, with nothing to re-register.
export const isGoToFile = (event: KeyboardEvent): boolean => matchesChord(chordOf("goToFile"), event);
export const isNewSession = (event: KeyboardEvent): boolean => matchesChord(chordOf("newSession"), event);
export const isPickAgent = (event: KeyboardEvent): boolean => matchesChord(chordOf("pickAgent"), event);
export const isNewWorktree = (event: KeyboardEvent): boolean => matchesChord(chordOf("newWorktree"), event);
/** On macOS the menu's Agents… item has the key too, moved with it. */
export const isManageAgents = (event: KeyboardEvent): boolean => matchesChord(chordOf("agents"), event);
export const isPrevCommit = (event: KeyboardEvent): boolean => matchesChord(chordOf("prevCommit"), event);
export const isNextCommit = (event: KeyboardEvent): boolean => matchesChord(chordOf("nextCommit"), event);
export const isCloseTab = (event: KeyboardEvent): boolean => matchesChord(chordOf("closeTab"), event);
export const isShortcuts = (event: KeyboardEvent): boolean => matchesChord(chordOf("shortcuts"), event);
export const isNextWaiting = (event: KeyboardEvent): boolean => matchesChord(chordOf("nextWaiting"), event);
export const isPreviousSession = (event: KeyboardEvent): boolean => matchesChord(chordOf("previousSession"), event);

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

/**
 * Text size, for whatever is in front: `Cmd+=` bigger (`Cmd+Shift+=` too,
 * which is `Cmd++`), `Cmd+-` smaller, `Cmd+0` back to the default; a
 * browser's zoom keys. `Ctrl+Shift` and the same keys off macOS, a Linux
 * terminal's, since `Ctrl+-` alone is the shell's undo. `null` for anything
 * else.
 */
export const fontStep = (event: KeyboardEvent): 1 | -1 | 0 | null => {
  const code = event.code || ({ "=": "Equal", "+": "Equal", "-": "Minus", _: "Minus", "0": "Digit0", ")": "Digit0" } as Record<string, string>)[event.key];
  if (!appChord(event, false) && !(isMac() && code === "Equal" && appChord(event, true))) return null;
  return code === "Equal" ? 1 : code === "Minus" ? -1 : code === "Digit0" ? 0 : null;
};

export const isFontStep = (event: KeyboardEvent): boolean => fontStep(event) !== null;

/** How the text size keys are written on this platform, for the sheet. */
export const fontSizeShortcuts = (): Array<[string, string]> => [
  ["Bigger text", chordLabel(app("Equal"))],
  ["Smaller text", chordLabel(app("Minus"))],
  ["Text back to its default size", chordLabel(app("Digit0"))],
];

/** Escape, anywhere in the window: for a dialog that cannot count on holding
 * the keyboard, such as one that opens while the terminals are still
 * starting and taking focus. */
export const isEscape = (event: KeyboardEvent): boolean => event.key === "Escape";

