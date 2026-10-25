import { describe, expect, it } from "vitest";

import { byteSize, decodeText, imageUrl, isImage, isRemote, resolvePath } from "./blob";

describe("blob", () => {
  it("knows a picture by its name", () => {
    expect(isImage("docs/shot.PNG")).toBe(true);
    expect(isImage("icon.svg")).toBe(true);
    expect(isImage("README.md")).toBe(false);
    expect(isImage(".png")).toBe(false);
    expect(imageUrl("a.svg", "PHN2Zz4=")).toBe("data:image/svg+xml;base64,PHN2Zz4=");
  });

  it("decodes UTF-8 and sizes the bytes", () => {
    expect(decodeText(btoa(String.fromCharCode(0xe2, 0x86, 0x92)))).toBe("→");
    expect(byteSize(btoa("abcd"))).toBe("4 B");
  });

  it("finds a picture relative to the Markdown file, or to the repository from /", () => {
    expect(resolvePath("docs/guide.md", "shots/a.png")).toBe("docs/shots/a.png");
    expect(resolvePath("docs/guide.md", "./a%20b.png?raw=1#x")).toBe("docs/a b.png");
    expect(resolvePath("docs/guide.md", "../src/icon.png")).toBe("src/icon.png");
    expect(resolvePath("docs/guide.md", "/src/icon.png")).toBe("src/icon.png");
    expect(resolvePath("README.md", "../../etc/passwd")).toBeNull();
    expect(resolvePath("README.md", "https://example.com/a.png")).toBeNull();
    expect(isRemote("//cdn.example.com/a.png")).toBe(true);
  });
});
