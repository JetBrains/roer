/**
 * Syntax colouring for the code inside a diff, two ways.
 *
 * `highlight` is the real one: a TextMate grammar per language, the same
 * machinery an editor uses, which is the only way to know that `#` opens a
 * comment in Python and an attribute in Rust. Grammars are fetched on demand
 * (see `./lang`), so the first paint of a file happens before one has loaded.
 *
 * `paint` is what fills that gap, and what answers for the languages we carry
 * no grammar for: regex classing of comments, strings, numbers and a union of
 * keywords. It is wrong often enough to be worth replacing, and right often
 * enough to be worth keeping as the thing that renders instantly.
 *
 * Both produce `Span[]`, so the renderer has one path.
 */

import { createHighlighterCore, splitTokens } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { HighlighterCore, ThemedToken } from "@shikijs/types";

import type { DiffLine, Hunk } from "./diff";
import { LOADERS, type Lang } from "./lang";
import { darcula, DEFAULT_FG } from "./theme-darcula";

export type TokenKind = "plain" | "keyword" | "string" | "number" | "comment";

/** A run of characters sharing a colour, and whether it is part of an edit. */
export interface Span {
  text: string;
  /** Set by `paint`, which colours through a CSS class. */
  kind?: TokenKind;
  /** Set by `highlight`, which colours from the theme directly. */
  color?: string;
  italic?: boolean;
  bold?: boolean;
  /** Inside the run that differs from the line this one is paired with. */
  marked: boolean;
}

/** Keywords across the languages a repository like this one actually holds. */
const KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "crate",
  "declare",
  "default",
  "def",
  "delete",
  "do",
  "dyn",
  "elif",
  "else",
  "enum",
  "except",
  "export",
  "extends",
  "extern",
  "false",
  "final",
  "finally",
  "fn",
  "for",
  "from",
  "fun",
  "function",
  "if",
  "impl",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "is",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "new",
  "nil",
  "none",
  "null",
  "object",
  "override",
  "package",
  "pass",
  "priv",
  "private",
  "protected",
  "pub",
  "public",
  "raise",
  "readonly",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "union",
  "unsafe",
  "use",
  "val",
  "var",
  "void",
  "when",
  "where",
  "while",
  "with",
  "yield",
]);

/** Comment, then string, then number, then bare word — in that order. */
const TOKEN =
  /(\/\/.*|#.*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

interface Piece {
  from: number;
  to: number;
  kind: TokenKind;
}

function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const from = match.index;
    if (from > last) out.push({ from: last, to: from, kind: "plain" });
    const kind: TokenKind = match[1]
      ? "comment"
      : match[2]
        ? "string"
        : match[3]
          ? "number"
          : KEYWORDS.has(match[4])
            ? "keyword"
            : "plain";
    last = from + match[0].length;
    out.push({ from, to: last, kind });
  }
  if (last < text.length) out.push({ from: last, to: text.length, kind: "plain" });
  return out;
}

/**
 * One line of code as coloured spans. `change` is the half-open range that
 * differs from the paired line; a token straddling its edge is cut, so the
 * emphasis follows the edit rather than the token.
 */
export function paint(text: string, change?: { from: number; to: number }): Span[] {
  const cuts = change ? [change.from, change.to] : [];
  const spans: Span[] = [];

  for (const piece of pieces(text)) {
    let at = piece.from;
    for (const edge of [...cuts.filter((cut) => cut > piece.from && cut < piece.to), piece.to]) {
      if (edge > at) {
        spans.push({
          text: text.slice(at, edge),
          kind: piece.kind,
          marked: change !== undefined && at >= change.from && edge <= change.to,
        });
      }
      at = edge;
    }
  }
  return spans;
}

/* ── Grammars ─────────────────────────────────────────────────────────── */

/** `fontStyle` arrives as a bitmask; these are the two bits we render. */
const ITALIC = 1;
const BOLD = 2;

let engine: Promise<HighlighterCore> | undefined;
/** The same highlighter once it exists, for the synchronous render path. */
let core: HighlighterCore | undefined;
const loaded = new Set<Lang>();
const arriving = new Map<Lang, Promise<void>>();

/**
 * One highlighter for the life of the app, holding every grammar loaded so
 * far. Building it is the expensive part, so it is never rebuilt, and the
 * promise is the lock: two files opened at once must not each make one.
 */
function highlighter(): Promise<HighlighterCore> {
  engine ??= createHighlighterCore({
    themes: [darcula],
    langs: [],
    // Oniguruma compiled to WebAssembly is the other option, and half a
    // megabyte of it. Native RegExp covers every grammar we carry.
    engine: createJavaScriptRegexEngine(),
  }).then((made) => (core = made));
  return engine;
}

/** Whether `highlight` can answer for a language yet. */
export function ready(lang: Lang): boolean {
  return loaded.has(lang);
}

/** Fetch a grammar, at most once per language however often this is called. */
export function loadLang(lang: Lang): Promise<void> {
  const already = arriving.get(lang);
  if (already) return already;

  const work = highlighter()
    .then(async (core) => {
      await core.loadLanguage(LOADERS[lang]);
      loaded.add(lang);
    })
    .catch(() => {
      // A grammar that will not load is not worth a broken view: the file
      // stays on `paint`, which is what an unknown extension gets anyway.
      arriving.delete(lang);
    });

  arriving.set(lang, work);
  return work;
}

/**
 * A hunk's lines tokenised once per side, because each side is a slice of a
 * different file. A removal appears in `old`, an addition in `new`, and a
 * context line — which is in both files — in both.
 */
export interface Colouring {
  old: Map<DiffLine, ThemedToken[]>;
  new: Map<DiffLine, ThemedToken[]>;
}

/**
 * Every line of every hunk, tokenised, once per side.
 *
 * The unit handed to the grammar is one side of one hunk — not one line, and
 * not the hunk itself. A hunk's lines interleave removals with the additions
 * that replaced them, which is not a document; context-plus-removals and
 * context-plus-additions each are, being contiguous slices of a real file,
 * where a string or a comment spanning several lines still reads as one.
 *
 * Between hunks the grammar starts over. A diff skips whatever lies between
 * them, so there is no state to carry across, and git's few lines of context
 * mean a hunk usually opens somewhere a grammar can find its feet.
 */
export function highlight(hunks: Hunk[], lang: Lang): Colouring {
  const sides: Colouring = { old: new Map(), new: new Map() };
  // A loaded grammar implies a built highlighter, so this reads as an
  // assertion rather than a check — but it is what keeps `highlight`
  // synchronous, and callable straight from render.
  if (!core || !loaded.has(lang)) return sides;

  for (const hunk of hunks) {
    for (const side of ["old", "new"] as const) {
      // A context line belongs to both sides and is one object in both, so it
      // is tokenised twice and kept under both. The two answers differ only
      // where the lines around it left the grammar in different states — a
      // removal that opened a string its replacement closes — and then each
      // column wants its own, which one shared map could not hold.
      const absent = side === "old" ? "add" : "del";
      const lines = hunk.lines.filter((line) => line.kind !== absent && line.kind !== "meta");
      if (!lines.length) continue;

      const { tokens } = core.codeToTokens(lines.map((line) => line.text).join("\n"), {
        lang,
        theme: "darcula",
      });

      let at = 0;
      lines.forEach((line, i) => {
        // Offsets index the whole side; a line is cut against its own text.
        sides[side].set(
          line,
          (tokens[i] ?? []).map((token) => ({ ...token, offset: token.offset - at })),
        );
        at += line.text.length + 1;
      });
    }
  }
  return sides;
}

/**
 * One line's tokens as spans, cut at the edges of `change` exactly as `paint`
 * cuts its own, so the emphasis follows the edit rather than the token.
 */
export function toSpans(tokens: ThemedToken[], change?: { from: number; to: number }): Span[] {
  const cuts = change ? [change.from, change.to] : [];

  return splitTokens([tokens], cuts)[0].map((token) => {
    const style = token.fontStyle ?? 0;
    return {
      text: token.content,
      // Default-coloured text carries no style at all, and inherits the
      // editor foreground from CSS like every other piece of chrome.
      color: token.color && token.color.toLowerCase() !== DEFAULT_FG ? token.color : undefined,
      italic: (style & ITALIC) !== 0,
      bold: (style & BOLD) !== 0,
      marked:
        change !== undefined &&
        token.offset >= change.from &&
        token.offset + token.content.length <= change.to,
    };
  });
}
