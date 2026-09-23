import { describe, expect, it } from "vitest";

import {
  copilotPending,
  draftPrPrompt,
  fixThreadsPrompt,
  threadLine,
  type PrReview,
  type PrSummary,
  type ReviewThread,
} from "./github";

const pr: PrSummary = {
  number: 19,
  title: "Add a thing",
  url: "https://github.com/o/r/pull/19",
  state: "OPEN",
  isDraft: false,
  headRefName: "feat",
  baseRefName: "main",
  reviewDecision: null,
};

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T1",
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 12,
  originalLine: 10,
  comments: [
    {
      author: "copilot-pull-request-reviewer",
      body: "Off by one here.",
      createdAt: "2026-09-01T00:00:00Z",
      url: "https://github.com/o/r/pull/19#discussion_r1",
      diffHunk: "@@ -1,2 +1,2 @@\n-let i = 0\n+let i = 1",
    },
  ],
  ...over,
});

describe("draftPrPrompt", () => {
  it("names the branch, the base, and the exact command to answer with", () => {
    const text = draftPrPrompt("%3", "feat", "main");
    expect(text).toContain("`feat` against `main`");
    expect(text).toContain("git diff main...HEAD");
    expect(text).toContain("roer pr-draft --pane %3 <<'ROER_PR_DRAFT'");
    expect(text).toMatch(/Do not create the pull request/);
  });
});

describe("fixThreadsPrompt", () => {
  it("carries each thread's place, hunk and conversation", () => {
    const text = fixThreadsPrompt(pr, [thread(), thread({ id: "T2", path: "b.rs", line: null, isOutdated: true })]);
    expect(text).toContain("pull request #19 (https://github.com/o/r/pull/19)");
    expect(text).toContain("## 1. src/a.ts:12");
    expect(text).toContain("## 2. b.rs:10 (outdated)");
    expect(text).toContain("```diff\n@@ -1,2 +1,2 @@\n-let i = 0\n+let i = 1\n```");
    expect(text).toContain("**copilot-pull-request-reviewer** (https://github.com/o/r/pull/19#discussion_r1):\nOff by one here.");
    expect(text).toMatch(/commit the fixes and push/);
  });
});

describe("helpers", () => {
  it("falls back to the original line once a thread has moved", () => {
    expect(threadLine(thread())).toBe(12);
    expect(threadLine(thread({ line: null }))).toBe(10);
    expect(threadLine(thread({ line: null, originalLine: null }))).toBeNull();
  });

  it("knows when Copilot still owes a review", () => {
    const review = (pendingReviewers: string[]): PrReview => ({ pendingReviewers, reviews: [], threads: [] });
    expect(copilotPending(review(["copilot-pull-request-reviewer"]))).toBe(true);
    expect(copilotPending(review(["octocat"]))).toBe(false);
    expect(copilotPending(null)).toBe(false);
  });
});
