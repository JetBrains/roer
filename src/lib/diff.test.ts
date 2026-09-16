import { describe, expect, it } from "vitest";

import { changedRange, pairRows, parseDiff } from "./diff";

const diff = [
  "diff --git a/src/App.tsx b/src/App.tsx",
  "index 1111111..2222222 100644",
  "--- a/src/App.tsx",
  "+++ b/src/App.tsx",
  "@@ -10,4 +10,5 @@ export function App() {",
  " const before = 1;",
  "-const gone = 2;",
  "+const added = 2;",
  "+const also = 3;",
  " const after = 4;",
  "@@ -40,2 +41,2 @@ function tail() {",
  "-old tail",
  "+new tail",
  "",
].join("\n");

describe("parseDiff", () => {
  it("splits a diff into its hunks", () => {
    const parsed = parseDiff(diff);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].header).toContain("@@ -10,4 +10,5 @@");
    expect(parsed.binary).toBe(false);
  });

  it("numbers lines on the side they exist on", () => {
    const [hunk] = parseDiff(diff).hunks;
    expect(hunk.lines[0]).toEqual({
      kind: "context",
      text: "const before = 1;",
      oldNo: 10,
      newNo: 10,
    });
    expect(hunk.lines[1]).toEqual({
      kind: "del",
      text: "const gone = 2;",
      oldNo: 11,
    });
    expect(hunk.lines[2]).toEqual({
      kind: "add",
      text: "const added = 2;",
      newNo: 11,
    });
    // The removed line advanced only the left side, the added ones only the
    // right, so the trailing context lands on 12 and 13.
    expect(hunk.lines[4]).toEqual({
      kind: "context",
      text: "const after = 4;",
      oldNo: 12,
      newNo: 13,
    });
  });

  it("counts what each hunk changes", () => {
    const [first, second] = parseDiff(diff).hunks;
    expect([first.added, first.deleted]).toEqual([2, 1]);
    expect([second.added, second.deleted]).toEqual([1, 1]);
  });

  it("does not turn the trailing newline into a line", () => {
    const last = parseDiff(diff).hunks[1];
    expect(last.lines.map((line) => line.kind)).toEqual(["del", "add"]);
  });

  it("keeps the no-newline marker out of both sides", () => {
    const [hunk] = parseDiff("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n").hunks;
    expect(hunk.lines.at(-1)).toEqual({
      kind: "meta",
      text: "No newline at end of file",
    });
  });

  it("reports a binary file rather than an empty diff", () => {
    const parsed = parseDiff(
      "diff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ\n",
    );
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toEqual([]);
  });

  it("notices a diff the backend cut short", () => {
    const parsed = parseDiff(`${diff}roer: diff truncated — the rest is too large to show.\n`);
    expect(parsed.truncated).toBe(true);
  });

  it("has nothing to show for an empty diff", () => {
    expect(parseDiff("")).toEqual({
      hunks: [],
      binary: false,
      truncated: false,
    });
  });
});

describe("pairRows", () => {
  const rows = (text: string) => pairRows(parseDiff(text).hunks[0]);

  it("puts a removal beside the addition that replaced it", () => {
    const [row] = rows("@@ -1 +1 @@\n-old\n+new\n");
    expect(row.kind).toBe("change");
    expect([row.left?.text, row.right?.text]).toEqual(["old", "new"]);
  });

  it("repeats a context line on both sides", () => {
    const [row] = rows("@@ -1,1 +1,1 @@\n same\n");
    expect(row).toEqual({
      kind: "context",
      left: { kind: "context", text: "same", oldNo: 1, newNo: 1 },
      right: { kind: "context", text: "same", oldNo: 1, newNo: 1 },
    });
  });

  it("leaves a gap where one side has nothing", () => {
    const paired = rows("@@ -1,2 +1,3 @@\n-gone\n+one\n+two\n+three\n");
    expect(paired.map((row) => row.kind)).toEqual(["change", "add", "add"]);
    expect(paired[1].left).toBeUndefined();
    expect(paired[1].right?.text).toBe("two");
  });

  it("does not pair across a context line", () => {
    // Two separate edits, not one four-line replacement.
    const paired = rows("@@ -1,4 +1,4 @@\n-a\n+A\n keep\n-b\n+B\n");
    expect(paired.map((row) => row.kind)).toEqual(["change", "context", "change"]);
  });
});

describe("changedRange", () => {
  it("narrows a change to the part that differs", () => {
    const line = "const added = 2;";
    const range = changedRange(line, "const gone = 2;");
    expect(range).toEqual({ from: 6, to: 11 });
    expect(line.slice(range?.from, range?.to)).toBe("added");
  });

  it("has no range when the two share nothing", () => {
    expect(changedRange("abc", "xyz")).toBeUndefined();
  });

  it("does not let the ends overlap on a pure insertion", () => {
    const range = changedRange("aXb", "ab");
    expect(range).toEqual({ from: 1, to: 2 });
    // The other side gained nothing, so its range is empty but still placed.
    expect(changedRange("ab", "aXb")).toEqual({ from: 1, to: 1 });
  });
});
