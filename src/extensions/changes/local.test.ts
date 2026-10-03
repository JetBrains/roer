import { describe, expect, it } from "vitest";

import { answered, localReviewPrompt, type LocalComment } from "./local";

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
