import { describe, expect, it } from "vitest";

import type { FileChange } from "./git";
import { ancestors, buildTree, fileOrder, rows } from "./tree";

function file(path: string): FileChange {
  return { path, staged: ".", unstaged: "M", added: 1, deleted: 0, binary: false, counted: true };
}

const changed = ["src/lib/git.ts", "src/App.tsx", "README.md", "src/lib/tree.ts"].map(file);

describe("buildTree", () => {
  it("groups files under their folders, folders first", () => {
    const tree = buildTree(changed);
    expect(tree.map((node) => [node.kind, node.name])).toEqual([
      ["dir", "src"],
      ["file", "README.md"],
    ]);
  });

  it("compacts a folder that holds nothing but one folder", () => {
    // src/lib holds two changed files and src/App.tsx sits beside it, so
    // `src` stays a row of its own — but deep/only/child collapses.
    const tree = buildTree([file("a/b/c/deep.ts")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("a/b/c");
    expect(tree[0].path).toBe("a/b/c");
  });

  it("keeps a folder that holds a file of its own", () => {
    const tree = buildTree([file("a/b/deep.ts"), file("a/own.ts")]);
    expect(tree.map((node) => node.name)).toEqual(["a"]);
    const inside = tree[0].kind === "dir" ? tree[0].children : [];
    expect(inside.map((node) => node.name)).toEqual(["b", "own.ts"]);
  });
});

describe("rows", () => {
  it("indents by depth and counts the files under a folder", () => {
    const visible = rows(buildTree(changed), new Set());
    expect(visible.map((row) => [row.name, row.depth])).toEqual([
      ["src", 0],
      ["lib", 1],
      ["git.ts", 2],
      ["tree.ts", 2],
      ["App.tsx", 1],
      ["README.md", 0],
    ]);
    expect(visible[0]).toMatchObject({ kind: "dir", count: 3 });
  });

  it("hides what a collapsed folder holds, itself included", () => {
    const visible = rows(buildTree(changed), new Set(["src/lib"]));
    expect(visible.map((row) => row.name)).toEqual(["src", "lib", "App.tsx", "README.md"]);
  });
});

describe("fileOrder", () => {
  it("walks every change in tree order, collapsed or not", () => {
    expect(fileOrder(buildTree(changed)).map((f) => f.path)).toEqual([
      "src/lib/git.ts",
      "src/lib/tree.ts",
      "src/App.tsx",
      "README.md",
    ]);
  });
});

describe("ancestors", () => {
  it("names every folder a file sits under", () => {
    expect(ancestors("src/lib/git.ts")).toEqual(["src", "src/lib"]);
    expect(ancestors("README.md")).toEqual([]);
  });
});
