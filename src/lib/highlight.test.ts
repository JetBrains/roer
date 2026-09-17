import { beforeAll, describe, expect, it } from "vitest";

import { parseDiff } from "./diff";
import { highlight, loadLang, paint, ready, toSpans, type Span } from "./highlight";
import { langFor } from "./lang";

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

describe("langFor", () => {
  it("reads the grammar off the extension", () => {
    expect(langFor("src/lib/git.ts")).toBe("typescript");
    expect(langFor("src-tauri/src/pty.rs")).toBe("rust");
    expect(langFor("README.md")).toBe("markdown");
  });

  it("reads .jsx as TSX, whose grammar covers it", () => {
    expect(langFor("app/Button.jsx")).toBe("tsx");
  });

  it("answers for nothing it carries no grammar for", () => {
    // A dotfile is a name, not an extension.
    expect(langFor(".gitignore")).toBeUndefined();
    expect(langFor("Makefile")).toBeUndefined();
    expect(langFor("script.pl")).toBeUndefined();
  });
});

describe("highlight", () => {
  beforeAll(async () => {
    await loadLang("typescript");
  });

  /** The tokens of one line of a one-hunk diff. */
  const line = (diff: string, at = 0) => {
    const { hunks } = parseDiff(diff);
    const coloured = highlight(hunks, "typescript");
    const found = coloured.old.get(hunks[0].lines[at]);
    if (!found) throw new Error("that line was not coloured");
    return found;
  };

  it("is ready once its grammar has loaded", () => {
    expect(ready("typescript")).toBe(true);
    expect(ready("kotlin")).toBe(false);
  });

  it("colours what a keyword list cannot", () => {
    // `parse` is a call, not a keyword, and no regex classing finds it.
    const spans = toSpans(line("@@ -1 +1 @@\n-const n = parse(x);\n+const n = 2;\n"));
    const call = spans.find((span) => span.text === "parse");
    expect(call?.color).toBeDefined();
    expect(call?.color).not.toBe(spans.find((span) => span.text === "const")?.color);
  });

  it("leaves default-coloured text to inherit its colour from CSS", () => {
    const spans = toSpans(line("@@ -1 +1 @@\n-let x = 1;\n+let x = 2;\n"));
    expect(spans.find((span) => span.text === "x")?.color).toBeUndefined();
  });

  it("keeps every character, in order", () => {
    const text = "  const s = f(1, 'two'); /* three */";
    const spans = toSpans(line(`@@ -1 +1 @@\n-${text}\n+${text}!\n`));
    expect(spans.reduce((all, span) => all + span.text, "")).toBe(text);
  });

  it("marks only the changed run, cutting the token it starts inside", () => {
    const spans = toSpans(line("@@ -1 +1 @@\n-const renamed = 1;\n+const named = 1;\n"), {
      from: 6,
      to: 13,
    });
    expect(spans.filter((span) => span.marked).map((span) => span.text)).toEqual(["renamed"]);
    expect(spans.reduce((all, span) => all + span.text, "")).toBe("const renamed = 1;");
  });

  it("reads a hunk as a file, so a string spanning lines stays one string", () => {
    // The second line is inside the template literal the first one opens; a
    // line-at-a-time tokenizer has no way to know that.
    const diff = "@@ -1,3 +1,3 @@\n-const s = `one\n-two`;\n-const n = 1;\n+const n = 2;\n";
    const { hunks } = parseDiff(diff);
    const coloured = highlight(hunks, "typescript");
    const opens = toSpans(coloured.old.get(hunks[0].lines[0]) ?? []);
    const inside = toSpans(coloured.old.get(hunks[0].lines[1]) ?? []);
    // The run that closes the literal is the same colour as the run that
    // opened it, a line earlier.
    const string = opens.find((span) => span.text === "`one")?.color;
    expect(string).toBeDefined();
    expect(inside.find((span) => span.text === "two`")?.color).toBe(string);
    expect(inside.reduce((all, span) => all + span.text, "")).toBe("two`;");
  });

  it("gives a context line the grammar state of each side, not one of them", () => {
    // The removal opens a template literal its replacement closes, so `tail;`
    // is inside a string in the old file and ordinary code in the new one.
    // Both columns show the same object, and it is right in each.
    const diff = '@@ -1,2 +1,2 @@\n-const s = `open\n+const s = "closed";\n tail;\n';
    const { hunks } = parseDiff(diff);
    const coloured = highlight(hunks, "typescript");
    const tail = hunks[0].lines[2];
    expect(tail.kind).toBe("context");

    const inString = toSpans(coloured.old.get(tail) ?? []);
    const asCode = toSpans(coloured.new.get(tail) ?? []);
    expect(inString.map((span) => span.text)).toEqual(["tail;"]);
    expect(inString[0].color).toBeDefined();
    expect(asCode.find((span) => span.text.startsWith("tail"))?.color).not.toBe(
      inString[0].color,
    );
  });

  it("answers nothing for a grammar that has not loaded", () => {
    const { hunks } = parseDiff("@@ -1 +1 @@\n-a\n+b\n");
    expect(highlight(hunks, "kotlin").old.size).toBe(0);
  });
});

describe("highlight, per language", () => {
  beforeAll(async () => {
    await loadLang("rust");
  });

  /** The spans of the one changed line of a one-line-per-side diff. */
  const spans = (text: string) => {
    const { hunks } = parseDiff(`@@ -1 +1 @@\n-${text}\n+x\n`);
    return toSpans(highlight(hunks, "rust").old.get(hunks[0].lines[0]) ?? []);
  };

  it("knows a Rust attribute is not a comment", () => {
    // `#` opens a comment in Python and shell; a keyword list that colours it
    // grey greys out every derive in the file.
    const attribute = spans("#[derive(Debug)] // note");
    const comment = attribute.find((span) => span.text === "// note");
    const hash = attribute.find((span) => span.text.startsWith("#"));
    expect(comment?.color).toBeDefined();
    expect(hash?.color).not.toBe(comment?.color);
  });

  it("leaves a `#` inside a string alone", () => {
    // The `#` neither opens a comment nor breaks the literal in two.
    const quoted = spans('let s = "a # b";');
    const literal = quoted.find((span) => span.text.includes("#"));
    expect(literal?.text).toBe('"a # b"');
    expect(literal?.color).toBeDefined();
  });
});
