/**
 * Which TextMate grammar to colour a file with.
 *
 * A curated set rather than all 361 Shiki ships: every grammar is a chunk in
 * the bundle the app embeds, and the four JavaScript-family ones alone are
 * 670 KB of near-duplicates. An extension not listed here is not a failure —
 * `paint` in `./highlight` still colours it.
 */

import type { LanguageInput } from "@shikijs/types";

/** The grammars we carry. */
export type Lang =
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "markdown"
  | "python"
  | "rust"
  | "shellscript"
  | "toml"
  | "tsx"
  | "typescript"
  | "yaml";

/**
 * Extension → grammar. `.jsx` is read as TSX, whose grammar is a superset and
 * saves carrying a fourth copy of the JavaScript one.
 */
const BY_EXTENSION: Record<string, Lang> = {
  bash: "shellscript",
  css: "css",
  cjs: "javascript",
  cts: "typescript",
  go: "go",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "tsx",
  kt: "kotlin",
  kts: "kotlin",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  pyi: "python",
  rs: "rust",
  sh: "shellscript",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
};

/**
 * The grammar for a repository-relative path, or `undefined` when we carry
 * none and the regex painter should answer instead.
 */
export function langFor(path: string): Lang | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/**
 * Loaders, one static specifier each: the bundler can only split a chunk per
 * grammar if it can see the import at build time.
 */
export const LOADERS: Record<Lang, LanguageInput> = {
  css: () => import("@shikijs/langs/css"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
};
