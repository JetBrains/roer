import { describe, expect, it } from "vitest";

import { insideRoot, isOpenGesture, linkTarget } from "./terminalLinks";

describe("terminal links", () => {
  it("opens on a plain click or Cmd+click on macOS, and leaves xterm's own clicks alone", () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isOpenGesture(click)).toBe(true);
    expect(isOpenGesture({ ...click, metaKey: true })).toBe(true);
    // Ctrl+click on macOS is a right-click; Shift and Option change the selection.
    expect(isOpenGesture({ ...click, ctrlKey: true })).toBe(false);
    expect(isOpenGesture({ ...click, shiftKey: true })).toBe(false);
    expect(isOpenGesture({ ...click, altKey: true })).toBe(false);
    expect(isOpenGesture({ ...click, metaKey: true, shiftKey: true })).toBe(false);
    expect(isOpenGesture({ ...click, button: 1 })).toBe(false);
  });

  it("sends web links to the browser, and files to Roer", () => {
    expect(linkTarget("https://github.com/JetBrains/roer")).toEqual({ kind: "web", url: "https://github.com/JetBrains/roer" });
    expect(linkTarget("http://localhost:3000")).toEqual({ kind: "web", url: "http://localhost:3000/" });
    expect(linkTarget("http://127.0.0.1:8080/x")).toEqual({ kind: "web", url: "http://127.0.0.1:8080/x" });
    expect(linkTarget("file:///Users/a/My%20Project/src/app.ts")).toEqual({ kind: "file", path: "/Users/a/My Project/src/app.ts" });
    expect(linkTarget("file://mac.local/Users/a/x.ts#L12")).toEqual({ kind: "file", path: "/Users/a/x.ts", line: 12 });
    expect(linkTarget("file:///C:/work/x.ts")).toEqual({ kind: "file", path: "C:/work/x.ts" });
  });

  it("opens nothing else", () => {
    for (const uri of ["http://example.com/", "http://localhost.evil.com/", "javascript:alert(1)", "mailto:a@b.c", "vscode://file/x", "data:text/html,x", "not a url", "/Users/a/x.ts"]) {
      expect(linkTarget(uri), uri).toBeNull();
    }
  });

  it("names a file relative to its repository, and only inside it", () => {
    expect(insideRoot("/Users/a/roer", "/Users/a/roer/src/App.tsx")).toBe("src/App.tsx");
    expect(insideRoot("/Users/a/roer/", "/Users/a/roer/README.md")).toBe("README.md");
    expect(insideRoot("/Users/a/roer", "/Users/a/roer-pi/x.ts")).toBeNull();
    expect(insideRoot("/Users/a/roer", "/Users/a/roer/../etc/passwd")).toBeNull();
    expect(insideRoot("/Users/a/roer", "/Users/a/roer")).toBeNull();
    expect(insideRoot("C:\\work\\roer", "C:/work/roer/src/x.ts")).toBe("src/x.ts");
  });
});
