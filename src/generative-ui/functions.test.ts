import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluate } from "./evaluate";
import { FUNCTION_NAMES } from "./functions";

const call = (name: string, args?: Record<string, unknown>) => ({ call: name, args });
const at = (path: string) => ({ path });
const model = { total: 120, people: "4", tip: 0.15, blank: "", flags: [true, false], name: "Ada" };
const run = (value: unknown, scope = {}) => evaluate(value, model, scope);

describe("catalog functions", () => {
  it("compute from bound numbers, text that holds one included", () => {
    expect(run(call("divide", { a: at("/total"), b: at("/people") }))).toBe(30);
    expect(run(call("add", { values: [1, at("/tip"), "2"] }))).toBeCloseTo(3.15);
    expect(run(call("multiply", { values: [at("/total"), call("add", { values: [1, at("/tip")] })] }))).toBeCloseTo(138);
    expect(run(call("subtract", { a: 5, b: 7 }))).toBe(-2);
    expect(run(call("min", { values: [3, 1, 2] }))).toBe(1);
    expect(run(call("max", { values: [3, 1, 2] }))).toBe(3);
    expect(run(call("round", { value: 2.345, decimals: 2 }))).toBe(2.35);
    expect(run(call("round", { value: 2.5 }))).toBe(3);
  });

  it("give nothing rather than NaN or Infinity", () => {
    expect(run(call("divide", { a: 1, b: 0 }))).toBeUndefined();
    expect(run(call("add", { values: [1, at("/blank")] }))).toBeUndefined();
    expect(run(call("add", { values: [1, at("/missing")] }))).toBeUndefined();
    expect(run(call("add", { values: [1, true] }))).toBeUndefined();
    expect(run(call("add", { values: [] }))).toBeUndefined();
    expect(run(call("multiply", { values: [1e308, 10] }))).toBeUndefined();
    expect(run(call("subtract", { a: "abc", b: 1 }))).toBeUndefined();
    expect(run(call("formatNumber", { value: call("divide", { a: 1, b: 0 }) }))).toBeUndefined();
  });

  it("compare, test and combine", () => {
    expect(run(call("gt", { a: at("/total"), b: 100 }))).toBe(true);
    expect(run(call("lt", { a: at("/total"), b: 100 }))).toBe(false);
    expect(run(call("gt", { a: at("/blank"), b: 0 }))).toBeUndefined();
    expect(run(call("eq", { a: at("/name"), b: "Ada" }))).toBe(true);
    expect(run(call("eq", { a: at("/flags"), b: at("/flags") }))).toBe(false);
    expect(run(call("isSet", { value: at("/blank") }))).toBe(false);
    expect(run(call("isSet", { value: at("/name") }))).toBe(true);
    expect(run(call("isNumber", { value: at("/people") }))).toBe(true);
    expect(run(call("isNumber", { value: at("/blank") }))).toBe(false);
    expect(run(call("length", { value: at("/flags") }))).toBe(2);
    expect(run(call("and", { values: [at("/flags/0"), true] }))).toBe(true);
    expect(run(call("and", { values: [at("/flags/0"), at("/flags/1")] }))).toBe(false);
    expect(run(call("or", { values: [at("/flags/1"), at("/flags/0")] }))).toBe(true);
    expect(run(call("not", { value: at("/flags/1") }))).toBe(true);
    expect(run(call("if", { condition: at("/flags/0"), then: "yes", else: "no" }))).toBe("yes");
    expect(run(call("if", { condition: at("/missing"), then: "yes", else: "no" }))).toBe("no");
  });

  it("word things: templates, plurals and numbers", () => {
    const share = call("formatNumber", { value: call("divide", { a: at("/total"), b: at("/people") }), decimals: 2 });
    expect(run(call("formatString", { value: "${/name} pays ${share}", share }))).toBe(
      `Ada pays ${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(30)}`,
    );
    expect(run(call("formatString", { value: "${name}" }), { item: "/rows/0" })).toBe("");
    expect(evaluate(call("formatString", { value: "${name}!" }), { rows: [{ name: "b" }] }, { item: "/rows/0" })).toBe("b!");
    expect(run(call("pluralize", { count: 1, one: "file", other: "files" }))).toBe("file");
    expect(run(call("pluralize", { count: at("/people"), one: "file", other: "files" }))).toBe("files");
    expect(run(call("pluralize", { count: 0, zero: "none", one: "file", other: "files" }))).toBe("none");
    expect(run(call("formatNumber", { value: 1234.5, decimals: 0, grouping: false }))).toBe("1235");
  });

  it("resolve an unknown name, or a prototype's, to nothing", () => {
    expect(run(call("eval", { value: "1" }))).toBeUndefined();
    expect(run(call("constructor"))).toBeUndefined();
    expect(run(call("toString"))).toBeUndefined();
    expect(FUNCTION_NAMES).toContain("formatString");
  });

  it("are the same in the roer-ui plugin, which ships its own copy", () => {
    const here = readFileSync(resolve(__dirname, "functions.ts"), "utf8");
    const plugin = readFileSync(resolve(__dirname, "../../claude-plugin/roer-ui/hooks/functions.ts"), "utf8");
    expect(plugin).toBe(here);
  });
});
