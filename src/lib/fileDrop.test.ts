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
});
