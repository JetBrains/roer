import { describe, expect, it } from "vitest";

import { parseDiff } from "./diff";
import { lineMarks, noMarks, rowsOf } from "./lineMarks";

const marks = (patch: string) => {
  const found = lineMarks(parseDiff(patch));
  return { added: [...found.added], removed: Object.fromEntries(found.removed) };
};

describe("lineMarks", () => {
  it("marks added lines", () => {
    expect(marks("@@ -1,2 +1,4 @@\n a\n+b\n+c\n d\n")).toEqual({ added: [2, 3], removed: {} });
  });

  it("puts a replaced line's old text above its new one", () => {
    expect(marks("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")).toEqual({ added: [2], removed: { 2: ["b"] } });
  });

  it("puts removed lines above the line that follows them", () => {
    expect(marks("@@ -1,3 +1,2 @@\n a\n-b\n c\n")).toEqual({ added: [], removed: { 2: ["b"] } });
  });

  it("places a hunk that only removes by its header", () => {
    expect(marks("@@ -6,2 +5,0 @@\n-x\n-y\n")).toEqual({ added: [], removed: { 6: ["x", "y"] } });
  });

  it("marks every line of a new file as added", () => {
    expect(marks("@@ -0,0 +1,2 @@\n+a\n+b\n")).toEqual({ added: [1, 2], removed: {} });
  });
});

describe("rowsOf", () => {
  it("is the file's lines alone when nothing changed", () => {
    expect(rowsOf(["a", "b"], noMarks)).toEqual({
      rows: [
        { kind: "line", no: 1, text: "a", added: false },
        { kind: "line", no: 2, text: "b", added: false },
      ],
      changes: [],
    });
  });

  it("puts removed lines back in and starts a change at each run of them and the added ones", () => {
    const { rows, changes } = rowsOf(["a", "B", "c", "d"], lineMarks(parseDiff("@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-x\n d\n")));
    expect(rows.map((row) => (row.kind === "removed" ? `-${row.text}` : row.added ? `+${row.text}` : row.text))).toEqual([
      "a",
      "-b",
      "+B",
      "c",
      "-x",
      "d",
    ]);
    expect(changes).toEqual([1, 4]);
  });

  it("puts lines taken off the end after the last one", () => {
    const { rows } = rowsOf(["a"], lineMarks(parseDiff("@@ -1,2 +1,1 @@\n a\n-b\n")));
    expect(rows.at(-1)).toEqual({ kind: "removed", text: "b" });
  });
});
