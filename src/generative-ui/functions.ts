/**
 * The functions of `roer:catalog/1`: a closed, pure set a `{ call }` can
 * name, so a surface can count, compare, compute and word things from its
 * own data model without a turn of the agent's. A slider bound to `/tip`
 * and a `Text` that divides by it is a working calculator.
 *
 * There is no expression language and no way to reach outside the data
 * model: a function the catalog does not know resolves to nothing, and so
 * does a sum over something that is not a number, a division by zero, or a
 * result that is not finite. Nothing here ever shows NaN or Infinity; a
 * surface asks `isSet` and says what is missing instead.
 *
 * This file is shared, byte for byte, with the roer-ui Claude Code plugin
 * (claude-plugin/roer-ui/hooks/functions.ts), which ships on its own; keep it
 * free of imports. functions.test.ts checks that the two copies agree.
 */

/** How a function reads what it was given: `value` resolves one of its
 * Dynamic args, `read` a JSON Pointer from the data model (absolute, or
 * relative to the current template item). */
export interface FunctionScope {
  value(arg: unknown): unknown;
  read(pointer: string): unknown;
}

type Args = Record<string, unknown>;
type CatalogFunction = (args: Args, scope: FunctionScope) => unknown;

/** A number, or undefined for anything that only looks like one: blank
 * text, booleans, `null`, NaN and the infinities. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const finite = (n: number): number | undefined => (Number.isFinite(n) ? n : undefined);

/** Each of `values`, resolved, as a number; undefined if any one is not. */
function numbers(args: Args, scope: FunctionScope): number[] | undefined {
  const list = args.values;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out: number[] = [];
  for (const item of list) {
    const n = toNumber(scope.value(item));
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

/** `a` and `b`, resolved, as numbers; undefined unless both are. */
function pair(args: Args, scope: FunctionScope): [number, number] | undefined {
  const a = toNumber(scope.value(args.a));
  const b = toNumber(scope.value(args.b));
  return a === undefined || b === undefined ? undefined : [a, b];
}

const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const shown = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** How many decimals a format asks for: a whole number from 0 to 20. */
function decimals(arg: unknown): number | undefined {
  const n = toNumber(arg);
  return n === undefined ? undefined : Math.min(20, Math.max(0, Math.round(n)));
}

const FUNCTIONS: Record<string, CatalogFunction> = {
  /** `value` with each `${…}` filled in: `${/path}` or `${path}` from the
   * data model, `${name}` from the call's own arg of that name. */
  formatString: (args, scope) => {
    const template = scope.value(args.value);
    if (typeof template !== "string") return undefined;
    return template.replace(/\$\{([^}]*)\}/g, (_, ref: string) => {
      const name = ref.trim();
      if (name !== "value" && Object.prototype.hasOwnProperty.call(args, name)) return shown(scope.value(args[name]));
      return shown(scope.read(name));
    });
  },
  pluralize: (args, scope) => {
    const count = toNumber(scope.value(args.count));
    if (count === undefined) return undefined;
    const zero = args.zero === undefined ? undefined : scope.value(args.zero);
    const word = count === 0 && zero !== undefined ? zero : count === 1 ? scope.value(args.one) : scope.value(args.other);
    return typeof word === "string" ? word : undefined;
  },
  and: (args, scope) => Array.isArray(args.values) && args.values.every((v) => scope.value(v) === true),
  or: (args, scope) => Array.isArray(args.values) && args.values.some((v) => scope.value(v) === true),
  not: (args, scope) => scope.value(args.value) !== true,
  if: (args, scope) => (scope.value(args.condition) === true ? scope.value(args.then) : scope.value(args.else)),
  eq: (args, scope) => {
    const a = scope.value(args.a);
    const b = scope.value(args.b);
    return isScalar(a) && isScalar(b) && a === b;
  },
  gt: (args, scope) => {
    const p = pair(args, scope);
    return p === undefined ? undefined : p[0] > p[1];
  },
  lt: (args, scope) => {
    const p = pair(args, scope);
    return p === undefined ? undefined : p[0] < p[1];
  },
  length: (args, scope) => {
    const v = scope.value(args.value);
    return typeof v === "string" || Array.isArray(v) ? v.length : undefined;
  },
  isSet: (args, scope) => {
    const v = scope.value(args.value);
    return v !== undefined && v !== null && v !== "";
  },
  isNumber: (args, scope) => toNumber(scope.value(args.value)) !== undefined,
  add: (args, scope) => {
    const ns = numbers(args, scope);
    return ns === undefined ? undefined : finite(ns.reduce((sum, n) => sum + n, 0));
  },
  multiply: (args, scope) => {
    const ns = numbers(args, scope);
    return ns === undefined ? undefined : finite(ns.reduce((product, n) => product * n, 1));
  },
  subtract: (args, scope) => {
    const p = pair(args, scope);
    return p === undefined ? undefined : finite(p[0] - p[1]);
  },
  divide: (args, scope) => {
    const p = pair(args, scope);
    return p === undefined || p[1] === 0 ? undefined : finite(p[0] / p[1]);
  },
  min: (args, scope) => {
    const ns = numbers(args, scope);
    return ns === undefined ? undefined : Math.min(...ns);
  },
  max: (args, scope) => {
    const ns = numbers(args, scope);
    return ns === undefined ? undefined : Math.max(...ns);
  },
  round: (args, scope) => {
    const n = toNumber(scope.value(args.value));
    if (n === undefined) return undefined;
    const places = args.decimals === undefined ? 0 : decimals(scope.value(args.decimals));
    if (places === undefined) return undefined;
    const factor = 10 ** places;
    return finite(Math.round(n * factor) / factor);
  },
  /** In the reader's own locale: grouping on unless `grouping` is false,
   * exactly `decimals` places when given, up to 3 otherwise. */
  formatNumber: (args, scope) => {
    const n = toNumber(scope.value(args.value));
    if (n === undefined) return undefined;
    const places = args.decimals === undefined ? undefined : decimals(scope.value(args.decimals));
    if (args.decimals !== undefined && places === undefined) return undefined;
    return new Intl.NumberFormat(undefined, {
      useGrouping: scope.value(args.grouping) !== false,
      ...(places === undefined ? {} : { minimumFractionDigits: places, maximumFractionDigits: places }),
    }).format(n);
  },
};

/** The names a `{ call }` can use, `@index` aside: it needs the template
 * item, so each renderer resolves it itself. */
export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);

/** The value of `{ call: name, args }`, or undefined for a function the
 * catalog does not have. */
export function callFunction(name: string, args: unknown, scope: FunctionScope): unknown {
  if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) return undefined;
  const fn = FUNCTIONS[name];
  const given = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Args) : {};
  return fn === undefined ? undefined : fn(given, scope);
}
