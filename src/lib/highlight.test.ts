import { describe, expect, it } from "vitest";

import { paint, type Span } from "./highlight";

/** Which colour each run got, as `kind:text` pairs. */
const kinds = (spans: Span[]) => spans.map((span) => `${span.kind}:${span.text}`);

describe("paint", () => {
  it("tells keywords, strings, numbers and comments apart", () => {
    expect(kinds(paint(`const n = 42; // why`))).toEqual([
      "keyword:const",
      "plain: ",
      "plain:n",
      "plain: = ",
      "number:42",
      "plain:; ",
      "comment:// why",
    ]);
  });

  it("colours a string whole, punctuation and all", () => {
    // A word and the punctuation after it are separate runs; only the colour
    // matters, so adjacent plain runs are left unmerged.
    expect(kinds(paint(`say("a = 1")`))).toEqual([
      "plain:say",
      "plain:(",
      'string:"a = 1"',
      "plain:)",
    ]);
  });

  it("leaves an ordinary identifier alone", () => {
    expect(paint("gitChanges").every((span) => span.kind === "plain")).toBe(true);
  });

  it("keeps every character, in order", () => {
    const line = "  let x = f(1, 'two'); /* three */";
    expect(paint(line).reduce((all, span) => all + span.text, "")).toBe(line);
  });

  it("marks only the changed run, cutting the token it starts inside", () => {
    // `renamed` replaced `named`: the edit begins in the middle of the word.
    const spans = paint("const renamed = 1;", { from: 6, to: 13 });
    expect(spans.filter((span) => span.marked).map((span) => span.text)).toEqual(["renamed"]);
    expect(kinds(spans)).toEqual([
      "keyword:const",
      "plain: ",
      "plain:renamed",
      "plain: = ",
      "number:1",
      "plain:;",
    ]);
  });

  it("marks nothing when there is no change to mark", () => {
    expect(paint("plain line").some((span) => span.marked)).toBe(false);
  });
});
