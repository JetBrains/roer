/**
 * The editor's syntax colours as a TextMate theme — Darcula in the dark
 * theme, IntelliJ Light in the light one.
 *
 * Every colour here is a CSS variable, not a hex value: the tokens a grammar
 * produces carry their colour as a string, and a `var()` in that string lets
 * `index.css` repaint every highlighted line when the theme flips, without
 * tokenising anything again. The values themselves live beside the rest of
 * each palette there.
 *
 * Deliberately restrained. JetBrains leaves operators, punctuation, classes
 * and local variables the default foreground, and so do we: a diff is read for
 * what changed, and colouring every token competes with the add/remove tints
 * that carry the actual meaning.
 */

import type { ThemeRegistration } from "@shikijs/types";

/** `--ide-text`. Tokens of this colour are left to inherit it from CSS. */
export const DEFAULT_FG = "var(--ide-text)";

export const THEME_NAME = "roer";

export const syntax: ThemeRegistration = {
  name: THEME_NAME,
  type: "dark",
  colors: { "editor.foreground": DEFAULT_FG, "editor.background": "var(--ide-editor)" },
  settings: [
    { settings: { foreground: DEFAULT_FG, background: "var(--ide-editor)" } },

    // The four the regex painter also knows.
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--t-comment)", fontStyle: "italic" } },
    { scope: ["string", "constant.other.symbol", "meta.embedded.assembly"], settings: { foreground: "var(--t-string)" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "var(--t-number)" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "variable.language"], settings: { foreground: "var(--t-keyword)" } },

    // What a grammar adds over a keyword list.
    { scope: ["entity.name.function", "support.function", "meta.function-call.generic"], settings: { foreground: "var(--t-function)" } },
    { scope: ["variable.other.property", "variable.other.member", "entity.name.variable.field", "support.variable.property"], settings: { foreground: "var(--t-field)" } },
    { scope: ["meta.annotation", "meta.attribute", "entity.name.function.decorator", "storage.type.annotation", "punctuation.definition.annotation"], settings: { foreground: "var(--t-annotation)" } },
    { scope: ["constant.character.escape"], settings: { foreground: "var(--t-escape)" } },
    { scope: ["entity.name.tag"], settings: { foreground: "var(--t-tag)" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--t-attribute)" } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: "var(--t-invalid)" } },

    // Markdown reads as prose, not code: headings and links, nothing else.
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "var(--t-heading)" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "var(--t-string)" } },
    { scope: ["markup.underline.link", "string.other.link"], settings: { foreground: "var(--t-link)" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  ],
};
