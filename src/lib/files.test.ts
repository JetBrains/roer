import { describe, expect, it } from "vitest";

import { baseName, parts, runs, type Hit } from "./files";

/** A run list as `text` with the matched runs wrapped in brackets. */
const show = (list: { text: string; hit: boolean }[]) =>
  list.map((run) => (run.hit ? `[${run.text}]` : run.text)).join("");

describe("runs", () => {
  it("brackets the matched characters and nothing else", () => {
    expect(show(runs("App.tsx", [0, 1, 2]))).toBe("[App].tsx");
    expect(show(runs("App.tsx", [0, 4]))).toBe("[A]pp.[t]sx");
  });

  it("leaves a path with no matches whole", () => {
    expect(runs("App.tsx", [])).toEqual([{ text: "App.tsx", hit: false }]);
  });

  it("reads the offsets as bytes, so a multi-byte path still splits", () => {
    // `é` is two bytes, so `U` is at byte 6 where a character count says 5.
    expect(show(runs("café/Unicode", [6]))).toBe("café/[U]nicode");
    expect(show(runs("café/Unicode", [3]))).toBe("caf[é]/Unicode");
  });

  it("never splits a character down the middle", () => {
    // Byte 4 is the continuation half of `é`; it cannot open a run of its own.
    expect(runs("café", [3, 4])).toEqual([
      { text: "caf", hit: false },
      { text: "é", hit: true },
    ]);
  });
});

describe("parts", () => {
  const hit = (path: string, at: number[]): Hit => ({
    path,
    nameAt: new TextEncoder().encode(path.slice(0, path.lastIndexOf("/") + 1)).length,
    at,
    score: 0,
  });

  it("splits the name from the directory that holds it", () => {
    const split = parts(hit("src/lib/App.tsx", [4, 8, 9, 10]));
    expect(show(split.dir)).toBe("src/[l]ib/");
    expect(show(split.name)).toBe("[App].tsx");
  });

  it("gives a file at the root an empty directory", () => {
    const split = parts(hit("README.md", [0]));
    expect(split.dir).toEqual([]);
    expect(show(split.name)).toBe("[R]EADME.md");
  });

  it("partitions on the name offset even where the directory is multi-byte", () => {
    const split = parts(hit("café/App.tsx", [3, 6]));
    expect(show(split.dir)).toBe("caf[é]/");
    expect(show(split.name)).toBe("[A]pp.tsx");
  });
});

describe("baseName", () => {
  it("is the last segment, or the whole path when there is no slash", () => {
    expect(baseName("src/lib/App.tsx")).toBe("App.tsx");
    expect(baseName("README.md")).toBe("README.md");
  });
});
