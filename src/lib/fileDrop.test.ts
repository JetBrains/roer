import { describe, expect, it } from "vitest";

import { isOver, pathsAsTyped } from "./fileDrop";

describe("dropped files", () => {
  it("types each path as a POSIX shell reads it, a space after the last", () => {
    expect(pathsAsTyped(["/Users/a/shot.png"], false)).toBe("/Users/a/shot.png ");
    expect(pathsAsTyped(["/Users/a/Снимок экрана 2026-10-11 в 17.42.png"], false)).toBe(
      "/Users/a/Снимок\\ экрана\\ 2026-10-11\\ в\\ 17.42.png ",
    );
    expect(pathsAsTyped(["/tmp/it's (1) & $HOME.png"], false)).toBe("/tmp/it\\'s\\ \\(1\\)\\ \\&\\ \\$HOME.png ");
    expect(pathsAsTyped(["/a/one.png", "/a/two.png"], false)).toBe("/a/one.png /a/two.png ");
    // A backslash before a newline would join lines: $'…' instead.
    expect(pathsAsTyped(["/a/two\nlines's.png"], false)).toBe("$'/a/two\\nlines\\'s.png' ");
  });

  it("quotes a Windows path with a space in it", () => {
    expect(pathsAsTyped(["C:\\Users\\a\\shot.png"], true)).toBe("C:\\Users\\a\\shot.png ");
    expect(pathsAsTyped(["C:\\Users\\a\\My Pictures\\shot.png", "D:\\x.png"], true)).toBe(
      '"C:\\Users\\a\\My Pictures\\shot.png" D:\\x.png ',
    );
  });

  it("knows whether a point is over an element", () => {
    const element = { getBoundingClientRect: () => ({ left: 10, right: 110, top: 20, bottom: 70 }) } as Element;
    expect(isOver(element, 50, 40)).toBe(true);
    expect(isOver(element, 5, 40)).toBe(false);
    expect(isOver(element, 50, 80)).toBe(false);
  });

  it("isn't over an element covered by something else, such as a dialog", () => {
    const terminal = document.createElement("div");
    const inside = document.createElement("span");
    terminal.append(inside);
    const dialog = document.createElement("div");
    document.body.append(terminal, dialog);
    terminal.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
    const original = document.elementFromPoint;
    try {
      document.elementFromPoint = () => inside;
      expect(isOver(terminal, 50, 50)).toBe(true);
      document.elementFromPoint = () => dialog;
      expect(isOver(terminal, 50, 50)).toBe(false);
    } finally {
      document.elementFromPoint = original;
      terminal.remove();
      dialog.remove();
    }
  });
});
