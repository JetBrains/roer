import { describe, expect, it } from "vitest";

import { withoutFolder } from "./pty";

describe("withoutFolder", () => {
  it("drops the folder Codex appends to its title", () => {
    expect(withoutFolder("Research widgets | myProject", "/Users/me/myProject")).toBe("Research widgets");
    expect(withoutFolder("Research widgets | myProject", "/Users/me/myProject/src")).toBe("Research widgets");
    expect(withoutFolder("Research widgets | myProject", "C:\\work\\myProject")).toBe("Research widgets");
  });

  it("keeps a bar that is part of the title", () => {
    expect(withoutFolder("Pipe a | b", "/Users/me/myProject")).toBe("Pipe a | b");
    expect(withoutFolder("✳ Claude Code", "/Users/me/roer")).toBe("✳ Claude Code");
    expect(withoutFolder(undefined, "/Users/me/roer")).toBeUndefined();
  });
});
