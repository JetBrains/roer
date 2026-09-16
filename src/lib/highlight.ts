/**
 * Heuristic syntax colouring for the code inside a diff.
 *
 * Not a per-language tokenizer: one diff can touch Rust, TypeScript, shell and
 * JSON, and a parser for each is a library we would rather not carry. Regex
 * classing of comments, strings, numbers and keywords is enough for keywords
 * and literals to read as distinct from everything else, which is what a diff
 * needs.
 */

export type TokenKind = "plain" | "keyword" | "string" | "number" | "comment";

/** A run of characters sharing a colour, and whether it is part of an edit. */
export interface Span {
  text: string;
  kind: TokenKind;
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
