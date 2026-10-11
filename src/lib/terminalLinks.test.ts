import { describe, expect, it } from "vitest";

import { insideRoot, isOpenGesture, linkTarget } from "./terminalLinks";

describe("terminal links", () => {
  it("opens on Cmd+click on macOS, never on a plain click", () => {
    expect(isOpenGesture({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isOpenGesture({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(isOpenGesture({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("sends web links to the browser, and files to Roer", () => {
    expect(linkTarget("https://github.com/JetBrains/roer")).toEqual({ kind: "web", url: "https://github.com/JetBrains/roer" });
    expect(linkTarget("http://localhost:3000")).toEqual({ kind: "web", url: "http://localhost:3000/" });
    expect(linkTarget("file:///Users/a/My%20Project/src/app.ts")).toEqual({ kind: "file", path: "/Users/a/My Project/src/app.ts" });
    expect(linkTarget("file://mac.local/Users/a/x.ts#L12")).toEqual({ kind: "file", path: "/Users/a/x.ts", line: 12 });
    expect(linkTarget("file:///C:/work/x.ts")).toEqual({ kind: "file", path: "C:/work/x.ts" });
  });

  it("opens nothing else", () => {
    for (const uri of ["javascript:alert(1)", "mailto:a@b.c", "vscode://file/x", "data:text/html,x", "not a url", "/Users/a/x.ts"]) {
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
