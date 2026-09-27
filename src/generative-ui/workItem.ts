/**
 * What a work item's detail view is made of, and how each piece is read off
 * the wire.
 *
 * An agent sends these as data, so every reader here keeps what is shaped
 * right and drops the rest, one element at a time: a typo in one finding
 * costs that finding, not the whole view.
 */
import type { DiffNote } from "../lib/diff";

export interface Requirement {
  id: string;
  text: string;
  met: boolean;
}

export type SourceKind = "ticket" | "slack" | "doc" | "file";

export interface SourceRef {
  kind: SourceKind;
  label: string;
  /** Opened in the browser; https only. */
  url?: string;
  /** Project-relative; opened in Roer's own file viewer. */
  path?: string;
}

export interface ChangeRef {
  id: string;
  title: string;
  /** A whole `git diff`, drawn with `DiffView`. */
  patch: string;
  notes?: DiffNote[];
}

export type Severity = "info" | "warn" | "error";
export type FindingState = "open" | "resolved" | "dismissed";

export interface Finding {
  id: string;
  severity: Severity;
  text: string;
  /** A line in one of the item's changes, where the finding is also drawn
   * as a note. */
  at?: { changeId: string; path: string; line: number; side?: "old" | "new" };
  state: FindingState;
}

export interface Comment {
  id: string;
  author: string;
  text: string;
  /** When it was posted, shown as sent — a timestamp or "2h ago". */
  at?: string;
}

export interface Decision {
  id: string;
  question: string;
  options: { label: string; value: string }[];
  /** An option's `value`, or the user's own words. */
  answer?: string;
}

type Wire = Record<string, unknown>;

const isWire = (v: unknown): v is Wire => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const each = <T>(v: unknown, read: (w: Wire) => T | undefined): T[] =>
  Array.isArray(v) ? v.flatMap((w) => (isWire(w) ? (read(w) ?? []) : [])) : [];

export const readRequirements = (v: unknown): Requirement[] =>
  each(v, (w) => {
    const id = str(w.id);
    const text = str(w.text);
    return id && text ? { id, text, met: w.met === true } : undefined;
  });

const SOURCE_KINDS: readonly SourceKind[] = ["ticket", "slack", "doc", "file"];

export const readSources = (v: unknown): SourceRef[] =>
  each(v, (w) => {
    const label = str(w.label);
    if (!label) return undefined;
    const kind = SOURCE_KINDS.find((k) => k === w.kind) ?? (str(w.path) ? "file" : "doc");
    const url = str(w.url);
    const path = str(w.path);
    return { kind, label, ...(url ? { url } : {}), ...(path ? { path } : {}) };
  });

export const readComments = (v: unknown): Comment[] =>
  each(v, (w) => {
    const id = str(w.id);
    const author = str(w.author);
    const text = str(w.text);
    if (!id || !author || !text) return undefined;
    const at = str(w.at);
    return { id, author, text, ...(at ? { at } : {}) };
  });

export const readNotes = (v: unknown): DiffNote[] =>
  each(v, (w) => {
    const path = str(w.path);
    const text = str(w.text);
    if (!path || !text) return undefined;
    return {
      path,
      text,
      ...(typeof w.line === "number" ? { line: w.line } : {}),
      ...(w.side === "old" ? { side: "old" as const } : {}),
    };
  });

export const readChanges = (v: unknown): ChangeRef[] =>
  each(v, (w) => {
    const id = str(w.id);
    const patch = str(w.patch);
    if (!id || patch === undefined) return undefined;
    const notes = readNotes(w.notes);
    return { id, title: str(w.title) ?? id, patch, ...(notes.length > 0 ? { notes } : {}) };
  });

const SEVERITIES: readonly Severity[] = ["info", "warn", "error"];
const FINDING_STATES: readonly FindingState[] = ["open", "resolved", "dismissed"];

export const readFindings = (v: unknown): Finding[] =>
  each(v, (w) => {
    const id = str(w.id);
    const text = str(w.text);
    if (!id || !text) return undefined;
    const at = isWire(w.at) ? w.at : undefined;
    const changeId = str(at?.changeId);
    const path = str(at?.path);
    const line = at?.line;
    return {
      id,
      text,
      severity: SEVERITIES.find((s) => s === w.severity) ?? "info",
      state: FINDING_STATES.find((s) => s === w.state) ?? "open",
      ...(changeId && path && typeof line === "number"
        ? { at: { changeId, path, line, ...(at?.side === "old" ? { side: "old" as const } : {}) } }
        : {}),
    };
  });

export const readDecisions = (v: unknown): Decision[] =>
  each(v, (w) => {
    const id = str(w.id);
    const question = str(w.question);
    if (!id || !question) return undefined;
    const options = each(w.options, (o) => {
      const value = str(o.value);
      return value === undefined ? undefined : { value, label: str(o.label) ?? value };
    });
    const answer = str(w.answer);
    return { id, question, options, ...(answer ? { answer } : {}) };
  });
