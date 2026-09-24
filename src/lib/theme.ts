/**
 * Light or dark, and whether to follow the system.
 *
 * The palette itself lives in `index.css` as two token sets, keyed off
 * `data-theme` on `<html>`; this module only decides which one is on and
 * tells the few things CSS cannot reach — the terminal and the native
 * window — when that changes.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ITheme } from "@xterm/xterm";
import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "roer:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function storedChoice(): ThemeChoice {
  const value = localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function systemTheme(): Theme {
  // jsdom has no matchMedia; the app has always been dark, so that stays the
  // answer wherever the question cannot be asked.
  if (typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolve(choice: ThemeChoice): Theme {
  return choice === "system" ? systemTheme() : choice;
}

/** The theme on screen right now, for code that draws outside CSS. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

const listeners = new Set<(theme: Theme) => void>();

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Puts a choice on screen. Also run once before React mounts, so the first
 * paint is already in the right theme rather than flashing dark.
 */
export function applyTheme(choice: ThemeChoice) {
  const theme = resolve(choice);
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  // The traffic lights, native menus and dialogs follow the window's own
  // appearance, not the page's; `null` hands it back to the system.
  // Outside Tauri (tests, a plain browser) there is no window to theme, and
  // asking for one throws rather than rejects.
  try {
    void getCurrentWindow()
      .setTheme(choice === "system" ? null : choice)
      .catch(() => {});
  } catch {
    /* no window */
  }
  if (changed) listeners.forEach((listener) => listener(theme));
}

/** The user's choice, persisted, and kept applied while the system flips. */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState(storedChoice);

  useEffect(() => {
    localStorage.setItem(KEY, choice);
    applyTheme(choice);
    if (choice !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => applyTheme("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [choice]);

  return [choice, setChoice];
}

/** The order the title bar's button steps through. */
export function nextChoice(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "light" : choice === "light" ? "dark" : "system";
}

/**
 * xterm paints to a canvas, so its colours cannot come from CSS. Dark is the
 * terminal's long-standing look with xterm's own ANSI palette; light is
 * IntelliJ's console, where the default palette's yellow and white would
 * vanish into the background.
 */
export function terminalTheme(theme: Theme): ITheme {
  if (theme === "dark") return { background: "#1e1e1e", foreground: "#d4d4d4" };
  return {
    background: "#ffffff",
    foreground: "#000000",
    cursor: "#000000",
    cursorAccent: "#ffffff",
    selectionBackground: "#bcd3ff",
    black: "#1e1f22",
    red: "#c62d42",
    green: "#208a3c",
    yellow: "#a76e00",
    blue: "#3574f0",
    magenta: "#a23ab4",
    cyan: "#0b7c85",
    white: "#818594",
    brightBlack: "#6c707e",
    brightRed: "#e04b5b",
    brightGreen: "#2fa54a",
    brightYellow: "#c28e00",
    brightBlue: "#5c8ff5",
    brightMagenta: "#c057d4",
    brightCyan: "#1aa0ab",
    brightWhite: "#a8adbd",
  };
}
