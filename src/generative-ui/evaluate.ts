/**
 * Resolving a `Dynamic` value — a literal, a `{path}` into the data model, or
 * a `{call}` — against the data model and the template item it sits in.
 *
 * `@index` is resolved here, since it needs the template item; every other
 * call is one of the catalog's functions (functions.ts), and a name the
 * catalog does not have resolves to `undefined` rather than guessing.
 */
import { callFunction } from "./functions";
import { readPointer, resolvePointer, type DataModel, type JsonPointer } from "./schema";

/** Where a component is being evaluated: the pointer to its template item,
 * and that item's index, when it sits inside a templated list. */
export interface Scope {
  item?: JsonPointer;
  index?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isBinding = (value: unknown): value is { path: JsonPointer } =>
  isRecord(value) && typeof value.path === "string";

export const isCall = (value: unknown): value is { call: string; args?: Record<string, unknown> } =>
  isRecord(value) && typeof value.call === "string";

export function evaluate(value: unknown, model: DataModel, scope: Scope): unknown {
  if (isBinding(value)) return readPointer(model, resolvePointer(value.path, scope.item));
  if (isCall(value)) {
    if (value.call === "@index") {
      // Only meaningful inside a template; anywhere else v1.0 makes it an
      // evaluation error, which here is simply "no value".
      if (scope.index === undefined) return undefined;
      const offset = Number(evaluate(value.args?.offset, model, scope) ?? 0);
      return scope.index + (Number.isFinite(offset) ? offset : 0);
    }
    return callFunction(value.call, value.args, {
      value: (arg) => evaluate(arg, model, scope),
      read: (pointer) => readPointer(model, resolvePointer(pointer, scope.item)),
    });
  }
  return value;
}

/** The absolute pointer a two-way input writes back to, or `undefined` when
 * its value is a literal and there is nothing to write. */
export const boundPointer = (value: unknown, scope: Scope): JsonPointer | undefined =>
  isBinding(value) ? resolvePointer(value.path, scope.item) : undefined;

export const asString = (value: unknown): string =>
  value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
