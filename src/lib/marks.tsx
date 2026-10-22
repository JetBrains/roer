import type { ReactNode } from "react";

/** `text` with each occurrence of any of `terms`, in any case, marked: what
 * a search matched, in the words around it. */
export function marked(text: string, terms: readonly string[]): ReactNode[] {
  const escaped = terms.filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return [text];
  return text
    .split(new RegExp(`(${escaped.join("|")})`, "gi"))
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}
