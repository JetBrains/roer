/**
 * Darcula as a TextMate theme.
 *
 * Shiki bundles 68 themes and none of them is Darcula, so the diff's own
 * colours — the four in `index.css` that the regex painter has always used —
 * are restated here as scope rules, extended to the things a grammar can tell
 * us about and a regex cannot: functions, fields and annotations.
 *
 * Deliberately restrained. JetBrains leaves operators, punctuation, classes
 * and local variables the default foreground, and so do we: a diff is read for
 * what changed, and colouring every token competes with the add/remove tints
 * that carry the actual meaning.
 */

import type { ThemeRegistration } from "@shikijs/types";

/** `--ide-text`. Tokens of this colour are left to inherit it from CSS. */
export const DEFAULT_FG = "#d1d3d9";

export const darcula: ThemeRegistration = {
  name: "darcula",
  type: "dark",
  colors: { "editor.foreground": DEFAULT_FG, "editor.background": "#191a1c" },
  settings: [
    { settings: { foreground: DEFAULT_FG, background: "#191a1c" } },

    // The four the painter already knew, unchanged.
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7a7e85", fontStyle: "italic" } },
    { scope: ["string", "constant.other.symbol", "meta.embedded.assembly"], settings: { foreground: "#6aab73" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#2aacb8" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "variable.language"], settings: { foreground: "#cf8e6d" } },

    // What a grammar adds over a keyword list.
    { scope: ["entity.name.function", "support.function", "meta.function-call.generic"], settings: { foreground: "#56a8f5" } },
    { scope: ["variable.other.property", "variable.other.member", "entity.name.variable.field", "support.variable.property"], settings: { foreground: "#c77dbb" } },
    { scope: ["meta.annotation", "meta.attribute", "entity.name.function.decorator", "storage.type.annotation", "punctuation.definition.annotation"], settings: { foreground: "#b3ae60" } },
    { scope: ["constant.character.escape"], settings: { foreground: "#cf8e6d" } },
    { scope: ["entity.name.tag"], settings: { foreground: "#e8bf6a" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#bababa" } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: "#f57e84" } },

    // Markdown reads as prose, not code: headings and links, nothing else.
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#56a8f5" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#6aab73" } },
    { scope: ["markup.underline.link", "string.other.link"], settings: { foreground: "#548af7" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  ],
};
