import { describe, expect, it } from "vitest";

import { anchorOf, answered, forCheckout, localReviewPrompt, placeInDiff, type LocalComment } from "./local";

const comment = (over: Partial<LocalComment>): LocalComment => ({
  id: "c1",
  path: "src/a.ts",
  line: 3,
  side: "new",
  text: "Rename this.",
  code: "let x = 1",
  ...over,
});

describe("localReviewPrompt", () => {
  it("names the commit a comment was left on, and says its lines count there", () => {
    const prompt = localReviewPrompt("origin/main", [
      comment({}),
      comment({ id: "c2", line: 9, commit: { hash: "abc1234def", short: "abc1234", subject: "Add x" } }),
    ]);
    expect(prompt).toMatch(/## 1\. src\/a\.ts:3\n/);
    expect(prompt).toMatch(/## 2\. src\/a\.ts:9 in commit abc1234 \("Add x"\)/);
    expect(prompt).toMatch(/names a commit is about the code as that commit left it/);
  });

  it("says nothing about commits when no comment names one", () => {
    expect(localReviewPrompt("origin/main", [comment({})])).not.toMatch(/commit left it/);
  });
});

describe("answered", () => {
  it("deletes, decides and takes a decision back", () => {
    const agent = comment({ id: "a1", author: "Claude" });
    expect(answered([agent], { note: { id: "a1" }, action: "delete" })).toEqual([]);
    const decided = answered([agent], { note: { id: "a1" }, action: "instruct", text: "Keep it" });
    expect(decided[0].verdict).toEqual({ kind: "instruct", text: "Keep it" });
    expect(answered(decided, { note: { id: "a1" }, action: "" })[0].verdict).toBeUndefined();
  });
});

describe("forCheckout", () => {
  const reviewed = { root: "/repo", branch: "feat" };

  it("leaves the prompt as it is for an agent on the reviewed branch", () => {
    expect(forCheckout("Do it.", reviewed, { root: "/repo", branch: "feat" })).toBe("Do it.");
  });

  it("names the branch to an agent in the same repository on another one", () => {
    expect(forCheckout("Do it.", reviewed, { root: "/repo", branch: "main" })).toMatch(/^This is about the branch `feat`, which is not the one checked out here\.[\s\S]*Do it\.$/);
  });

  it("names the repository too to an agent that is elsewhere, or that cannot be found", () => {
    for (const there of [{ root: "/other", branch: "feat" }, { root: null, branch: null }]) {
      expect(forCheckout("Do it.", reviewed, there)).toMatch(/^This is about the branch `feat` of the repository at `\/repo`, which is not where you are now\./);
    }
    expect(forCheckout("Do it.", { root: "/repo", branch: null }, { root: "/other", branch: null })).toMatch(/^This is about the repository at `\/repo`/);
  });
});

describe("comments as threads", () => {
  it("names each comment's thread, and asks for an answer in every one", () => {
    const prompt = localReviewPrompt("origin/main", [comment({}), comment({ id: "c2", line: 9 })], new Map([["c1", "t1"], ["c2", "t2"]]));
    expect(prompt).toMatch(/## 1\. src\/a\.ts:3\nThread "t1"\./);
    expect(prompt).toMatch(/## 2\. src\/a\.ts:9\nThread "t2"\./);
    expect(prompt).toContain("answer in every one with the threads__answer tool");
    expect(localReviewPrompt("origin/main", [comment({})])).not.toContain("threads__answer");
  });

  it("anchors a thread where the comment was: its side, its commit, and a branch read from git", () => {
    const commit = { hash: "abc", short: "abc", subject: "s" };
    expect(anchorOf(comment({ side: "old", commit }), "spec")).toEqual({
      kind: "line",
      path: "src/a.ts",
      line: 3,
      code: "let x = 1",
      side: "old",
      commit,
      branch: "spec",
    });
  });

  const diff = ["@@ -1,3 +1,5 @@", " one", "+added", "+more", " let x = 1", " three", ""].join("\n");

  it("finds a thread's line again by its code once lines above it moved", () => {
    expect(placeInDiff(diff, "let x = 1", 2, "new")).toEqual({ line: 4, outdated: false });
    expect(placeInDiff(diff, "let x = 1", 4, "new")).toEqual({ line: 4, outdated: false });
  });

  it("is outdated where its words are gone from a line the diff still draws, and left alone where it draws none", () => {
    expect(placeInDiff(diff, "let x = 2", 4, "new")).toEqual({ line: 4, outdated: true });
    expect(placeInDiff(diff, "let x = 2", 40, "new")).toEqual({ line: 40, outdated: false });
  });
});
