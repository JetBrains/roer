import { describe, expect, it } from "vitest";

import { definitions, diffBlocks, splitBlocks } from "./mdDiff";

describe("splitBlocks", () => {
  it("cuts at blank lines, but not inside a fenced block", () => {
    const text = "# Title\n\nOne\ntwo\n\n```js\na();\n\nb();\n```\n\n- item\n";
    expect(splitBlocks(text)).toEqual(["# Title", "One\ntwo", "```js\na();\n\nb();\n```", "- item"]);
  });

  it("closes a fence only on the same character, at least as long", () => {
    expect(splitBlocks("````\n```\n\n````\n\nafter")).toEqual(["````\n```\n\n````", "after"]);
  });
});

describe("diffBlocks", () => {
  it("marks what was kept, added and taken out, an edit as the old block then the new", () => {
    const before = "# Title\n\nOld paragraph.\n\nKept.\n\nGone.";
    const after = "# Title\n\nNew paragraph.\n\nKept.\n\nAdded.";
    expect(diffBlocks(before, after)).toEqual([
      { kind: "same", text: "# Title" },
      { kind: "del", text: "Old paragraph." },
      { kind: "add", text: "New paragraph." },
      { kind: "same", text: "Kept." },
      { kind: "del", text: "Gone." },
      { kind: "add", text: "Added." },
    ]);
  });

  it("is all added for a new file", () => {
    expect(diffBlocks("", "a\n\nb")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
  });
});

describe("definitions", () => {
  it("keeps the reference definitions a block drawn alone needs", () => {
    expect(definitions("See [docs][d].\n\n[d]: https://example.com\n  [x]: ./x.md")).toBe(
      "[d]: https://example.com\n  [x]: ./x.md",
    );
  });
});
