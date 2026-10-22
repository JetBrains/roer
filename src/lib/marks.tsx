import type { ReactNode } from "react";

/** Any of `terms`, in any case, captured so `split` keeps what matched;
 * `null` with nothing to look for. */
export function termPattern(terms: readonly string[]): RegExp | null {
  const escaped = terms.filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escaped.length ? new RegExp(`(${escaped.join("|")})`, "gi") : null;
}

/** `text` with each occurrence of any of `terms`, in any case, marked: what
 * a search matched, in the words around it. */
export function marked(text: string, terms: readonly string[]): ReactNode[] {
  const pattern = termPattern(terms);
  if (!pattern) return [text];
  return text.split(pattern).map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}
