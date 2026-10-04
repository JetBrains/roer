import { describe, expect, it } from "vitest";

import types from "../../cli/src/ext/roer.d.ts?raw";

// The bundled extensions' own sources: what a fork of one starts from.
const sources = import.meta.glob(["./*/*.ts", "./*/*.tsx", "!./*/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The names `source` imports from `module`, types included. */
function imported(source: string, module: string): string[] {
  const from = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*"${module}"`, "g");
  return [...source.matchAll(from)].flatMap((match) =>
    match[1]
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim())
      .filter(Boolean),
  );
}

/** The declarations of `module` in roer.d.ts, up to the next module. */
function declarations(module: string): string {
  const start = types.indexOf(`declare module "${module}"`);
  const next = types.indexOf("declare module", start + 1);
  return types.slice(start, next < 0 ? undefined : next);
}

describe("roer.d.ts", () => {
  // `roer ext new` and `roer ext guide` hand these declarations to agents: a bundled extension copied as the start
  // of a fork has to type-check against them.
  it("declares everything a bundled extension imports", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(3);
    for (const module of ["roer", "roer/ui"]) {
      const declared = declarations(module);
      for (const [path, source] of Object.entries(sources)) {
        for (const name of imported(source, module)) {
          expect(declared, `${path} imports ${name} from ${module}`).toMatch(
            new RegExp(`(function|const|type|interface|class)\\s+${name}\\b`),
          );
        }
      }
    }
  });
});
