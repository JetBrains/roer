import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyTheme,
  currentTheme,
  hostColors,
  nextChoice,
  onThemeChange,
  storedChoice,
  terminalTheme,
  useThemeChoice,
} from "./theme";

const mocks = vi.hoisted(() => ({ setTheme: vi.fn(async () => undefined) }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: mocks.setTheme }),
}));

/** A `prefers-color-scheme` the test can flip, as macOS would. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia;
  return {
    listeners,
    flip(next: boolean) {
      dark = next;
      listeners.forEach((listener) => listener());
    },
  };
}

beforeEach(() => {
  mocks.setTheme.mockClear();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  // jsdom has none of its own; leave it that way for other suites.
  delete (window as Partial<Window>).matchMedia;
});

describe("storedChoice", () => {
  it("defaults to following the system", () => {
    expect(storedChoice()).toBe("system");
  });

  it("reads back light and dark, and nothing else", () => {
    localStorage.setItem("roer:theme", "light");
    expect(storedChoice()).toBe("light");
    localStorage.setItem("roer:theme", "dark");
    expect(storedChoice()).toBe("dark");
    localStorage.setItem("roer:theme", "sepia");
    expect(storedChoice()).toBe("system");
  });
});

describe("applyTheme", () => {
  it("puts an explicit choice on the page and on the native window", () => {
    fakeSystem(true);
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(currentTheme()).toBe("light");
    expect(mocks.setTheme).toHaveBeenLastCalledWith("light");
  });

  it("resolves system from the media query, and hands the window back to it", () => {
    fakeSystem(false);
    applyTheme("system");
    expect(currentTheme()).toBe("light");
    expect(mocks.setTheme).toHaveBeenLastCalledWith(null);
  });

  it("stays dark where the system cannot be asked", () => {
    applyTheme("system");
    expect(currentTheme()).toBe("dark");
  });

  it("tells listeners only when the theme on screen changes", () => {
    const listener = vi.fn();
    const stop = onThemeChange(listener);
    applyTheme("dark");
    applyTheme("dark");
    applyTheme("light");
    stop();
    applyTheme("dark");
    expect(listener.mock.calls).toEqual([["dark"], ["light"]]);
  });
});

describe("useThemeChoice", () => {
  it("persists the choice and applies it", () => {
    const { result } = renderHook(() => useThemeChoice());
    expect(result.current[0]).toBe("system");

    act(() => result.current[1]("light"));
    expect(result.current[0]).toBe("light");
    expect(localStorage.getItem("roer:theme")).toBe("light");
    expect(currentTheme()).toBe("light");
  });

  it("follows the system while on system, and stops once a theme is picked", () => {
    const system = fakeSystem(true);
    const { result } = renderHook(() => useThemeChoice());
    expect(currentTheme()).toBe("dark");

    act(() => system.flip(false));
    expect(currentTheme()).toBe("light");
    act(() => system.flip(true));
    expect(currentTheme()).toBe("dark");

    act(() => result.current[1]("light"));
    expect(system.listeners.size).toBe(0);
    act(() => system.flip(true));
    expect(currentTheme()).toBe("light");
  });
});

describe("nextChoice", () => {
  it("steps system, light, dark, and round again", () => {
    expect(nextChoice("system")).toBe("light");
    expect(nextChoice("light")).toBe("dark");
    expect(nextChoice("dark")).toBe("system");
  });
});

describe("terminalTheme", () => {
  it("keeps the dark terminal as it was and gives light its own palette", () => {
    expect(terminalTheme("dark")).toEqual({ background: "#1e1e1e", foreground: "#d4d4d4" });
    expect(terminalTheme("light")).toMatchObject({ background: "#ffffff", foreground: "#000000" });
    expect(terminalTheme("light").yellow).toBeDefined();
  });
});

describe("hostColors", () => {
  it("names every colour the terminal draws with, in psmux's form", () => {
    expect(hostColors("light")).toBe(
      "fg=000000,bg=ffffff,0=1e1f22,1=c62d42,2=208a3c,3=a76e00,4=3574f0,5=a23ab4,6=0b7c85,7=818594," +
        "8=6c707e,9=e04b5b,10=2fa54a,11=c28e00,12=5c8ff5,13=c057d4,14=1aa0ab,15=a8adbd,dark=0",
    );
    expect(hostColors("dark")).toBe(
      "fg=d4d4d4,bg=1e1e1e,0=2e3436,1=cc0000,2=4e9a06,3=c4a000,4=3465a4,5=75507b,6=06989a,7=d3d7cf," +
        "8=555753,9=ef2929,10=8ae234,11=fce94f,12=729fcf,13=ad7fa8,14=34e2e2,15=eeeeec,dark=1",
    );
  });
});
