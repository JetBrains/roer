import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../api";
import { gitBranchDiff, gitCurrentBranch } from "../../lib/git";
import { ghPrDiff, ghPrForBranch, ghPrReview, ghStatus, type PrReview, type PrSummary } from "../../lib/github";
import { storedComments } from "./local";
import { ReviewView } from "./ReviewView";
import { addCommentsTool } from "./tool";

vi.mock("../../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/github")>()),
  ghStatus: vi.fn(),
  ghPrForBranch: vi.fn(),
  ghPrDiff: vi.fn(),
  ghPrReview: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../../lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git")>()),
  gitBranchDiff: vi.fn(),
  gitCurrentBranch: vi.fn(async () => "feat"),
  gitRoot: vi.fn(async () => "/repo"),
}));

vi.mock("../../lib/session", () => ({
  resolveDir: vi.fn(async (cwd?: string) => cwd ?? ""),
}));

const pr: PrSummary = {
  number: 19,
  title: "Add a thing",
  url: "https://github.com/o/r/pull/19",
  state: "OPEN",
  isDraft: false,
  headRefName: "feat",
  headRefOid: "abc123",
  baseRefName: "main",
  reviewDecision: null,
};

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-let i = 0",
  "+let i = 1",
  "",
].join("\n");

const comment = (body: string, n: number) => ({
  author: "octocat",
  body,
  createdAt: "2026-09-01T00:00:00Z",
  url: `https://github.com/o/r/pull/19#discussion_r${n}`,
  diffHunk: "@@ -1,2 +1,2 @@\n keep\n-let i = 0\n+let i = 1",
});

const review: PrReview = {
  pendingReviewers: [],
  reviews: [],
  truncated: false,
  threads: [
    {
      id: "T1",
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 2,
      originalLine: 2,
      diffSide: "RIGHT",
      comments: [comment("Off by one.", 1)],
    },
    {
      id: "T2",
      isResolved: false,
      isOutdated: true,
      path: "src/a.ts",
      line: null,
      originalLine: 1,
      comments: [comment("Rename this.", 2)],
    },
    {
      id: "T3",
      isResolved: true,
      isOutdated: false,
      path: "src/a.ts",
      line: 1,
      originalLine: 1,
      comments: [comment("Settled already.", 3)],
    },
  ],
};

function session(over: Partial<Session> = {}): Session {
  return {
    pane: "%1",
    cwd: "/repo",
    root: "/repo",
    branch: "feat",
    agent: "claude",
    busy: false,
    changed: null,
    send: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ghStatus).mockResolvedValue({ installed: true, authenticated: true, repo: "o/r", message: null });
  vi.mocked(ghPrForBranch).mockResolvedValue(pr);
  vi.mocked(ghPrDiff).mockResolvedValue(patch);
  vi.mocked(ghPrReview).mockResolvedValue(review);
  vi.mocked(gitBranchDiff).mockResolvedValue({ root: "/repo", base: "origin/main", commits: 2, diff: patch });
});

describe("ReviewView", () => {
  it("draws open threads on the pull request's diff, and resolved ones only when asked", async () => {
    const onOpenCount = vi.fn();
    render(<ReviewView session={session()} active onOpenCount={onOpenCount} />);
    expect(await screen.findByText("Off by one.")).toBeInTheDocument();
    expect(screen.getByText("Rename this.")).toBeInTheDocument();
    expect(screen.getByText("outdated · line 1")).toBeInTheDocument();
    expect(screen.queryByText("Settled already.")).toBeNull();
    expect(screen.getByText("2 open · 2 to decide")).toBeInTheDocument();
    expect(onOpenCount).toHaveBeenLastCalledWith(2);
    expect(ghPrDiff).toHaveBeenCalledWith("/repo", 19);

    fireEvent.click(screen.getByLabelText("Show resolved"));
    expect(screen.getByText("Settled already.")).toBeInTheDocument();
  });

  it("sends each decision to the agent in one prompt, then marks them sent", async () => {
    const onSent = vi.fn();
    const staged = session();
    render(<ReviewView session={staged} active onSent={onSent} />);
    await screen.findByText("Off by one.");
    const send = screen.getByRole("button", { name: "Send 0 to Claude" });
    expect(send).toBeDisabled();

    // The outdated thread heads the file, so its buttons come first.
    fireEvent.click(screen.getAllByRole("button", { name: "Decline" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Instruct" }));
    fireEvent.change(screen.getByPlaceholderText("Tell Claude how to address this"), {
      target: { value: "Start the loop at 1 instead" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Instruct" }));
    expect(screen.getByText("2 open · 0 to decide")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send 2 to Claude" }));
    await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
    const prompt = vi.mocked(staged.send).mock.calls[0][0];
    expect(prompt).toMatch(/## 1\. src\/a\.ts:2[\s\S]*Off by one\.[\s\S]*address it this way: Start the loop at 1 instead/);
    expect(prompt).toMatch(/## 2\. src\/a\.ts:1 \(outdated\)[\s\S]*Rename this\.[\s\S]*declined/);
    expect(onSent).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Send 0 to Claude" })).toBeDisabled();
    expect(screen.getAllByText("sent")).toHaveLength(1);
    expect(screen.getByText("outdated · line 1 · sent")).toBeInTheDocument();
  });

  it("drops the last branch's pull request when this one's cannot be read", async () => {
    const { rerender } = render(<ReviewView session={session()} active />);
    await screen.findByText("Off by one.");
    vi.mocked(ghPrForBranch).mockRejectedValue("GitHub is down");
    rerender(<ReviewView session={session({ branch: "other" })} active />);
    expect(await screen.findByText("GitHub is down")).toBeInTheDocument();
    expect(screen.queryByText("Off by one.")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Send \d+ to/ })).toBeNull();
  });

  it("keeps decisions for the pull request across a remount", async () => {
    const { unmount } = render(<ReviewView session={session()} active />);
    await screen.findByText("Off by one.");
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[1]);
    unmount();

    render(<ReviewView session={session()} active />);
    expect(await screen.findByText("Accepted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send 1 to Claude" })).toBeEnabled();
  });

  it("says when the branch has no pull request, and points at where one is opened", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(null);
    const onOpenPullRequest = vi.fn();
    render(<ReviewView session={session()} active onOpenPullRequest={onOpenPullRequest} />);
    // Without a pull request the tab opens on the local changes.
    expect(await screen.findByRole("button", { name: "Local changes", pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pull request" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open one" }));
    expect(onOpenPullRequest).toHaveBeenCalled();
  });

  it("passes on what gh says when it cannot reach GitHub", async () => {
    vi.mocked(ghStatus).mockResolvedValue({ installed: false, authenticated: false, repo: null, message: "gh is not installed." });
    render(<ReviewView session={session()} active />);
    await screen.findByRole("button", { name: "Local changes", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "Pull request" }));
    expect(await screen.findByText("gh is not installed.")).toBeInTheDocument();
  });

  describe("local changes", () => {
    async function openLocal(staged = session()) {
      render(<ReviewView session={staged} active />);
      await screen.findByText("Off by one.");
      fireEvent.click(screen.getByRole("button", { name: "Local changes" }));
      await screen.findByText("2 commits since origin/main, and what is not committed");
      return staged;
    }

    function comment(index: number, text: string) {
      fireEvent.click(screen.getAllByRole("button", { name: "Comment on line 2" })[index]);
      fireEvent.change(screen.getByRole("textbox", { name: "Comment on line 2" }), { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    }

    it("reads the branch at once, and again only when its pull request goes elsewhere", async () => {
      await openLocal();
      // origin/main is where the pull request goes already: nothing to read again.
      expect(vi.mocked(gitBranchDiff).mock.calls).toEqual([["/repo", undefined]]);
    });

    it("compares the branch with its pull request's base when that is not the default", async () => {
      vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, baseRefName: "release" });
      render(<ReviewView session={session()} active />);
      await waitFor(() => expect(gitBranchDiff).toHaveBeenCalledWith("/repo", "release"));
    });

    it("sends your comments with the code they sit on, then clears them", async () => {
      const onSent = vi.fn();
      const staged = session();
      render(<ReviewView session={staged} active onSent={onSent} />);
      await screen.findByText("Off by one.");
      fireEvent.click(screen.getByRole("button", { name: "Local changes" }));
      await screen.findByText("2 commits since origin/main, and what is not committed");
      expect(screen.getByRole("button", { name: "Send 0 to Claude" })).toBeDisabled();

      // Line 2 is both the removed line (old) and the added one (new); the second + is the added one.
      comment(1, "Start at 0 after all.");
      comment(0, "Why was this removed?");
      expect(screen.getByText("Start at 0 after all.")).toBeInTheDocument();
      expect(screen.getAllByText("You")).toHaveLength(2);

      fireEvent.click(screen.getByRole("button", { name: "Send 2 to Claude" }));
      await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
      const prompt = vi.mocked(staged.send).mock.calls[0][0];
      expect(prompt).toMatch(/since it left origin\/main/);
      expect(prompt).toMatch(/## 1\. src\/a\.ts:2\n```\nlet i = 1\n```\nStart at 0 after all\./);
      expect(prompt).toMatch(/## 2\. src\/a\.ts, removed line 2\n```\nlet i = 0\n```\nWhy was this removed\?/);
      expect(onSent).toHaveBeenCalled();
      expect(await screen.findByText("Sent 2 comments to Claude.")).toBeInTheDocument();
      expect(screen.queryByText("Start at 0 after all.")).toBeNull();
      expect(screen.getByRole("button", { name: "Send 0 to Claude" })).toBeDisabled();
    });

    it("keeps comments across a remount, and deletes one when asked", async () => {
      const { unmount } = render(<ReviewView session={session()} active />);
      await screen.findByText("Off by one.");
      fireEvent.click(screen.getByRole("button", { name: "Local changes" }));
      await screen.findByText("2 commits since origin/main, and what is not committed");
      comment(1, "Keep me.");
      unmount();

      await openLocal();
      expect(await screen.findByText("Keep me.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(screen.queryByText("Keep me.")).toBeNull();
      expect(screen.getByRole("button", { name: "Send 0 to Claude" })).toBeDisabled();
    });

    /** What `roer mcp` hands over when Claude calls `code-review__add_comments`. */
    async function claudeComments(comments: unknown[], onAdded = vi.fn()) {
      let said = "";
      await act(async () => {
        said = String(await addCommentsTool(onAdded).run({ comments, author: "Claude" }, { cwd: "/repo", pane: "%1" }));
      });
      return said;
    }

    it("shows Claude's comments as they land, and sends the decisions on them", async () => {
      const staged = await openLocal();
      const onAdded = vi.fn();
      const said = await claudeComments(
        [
          { path: "src/a.ts", line: 2, severity: "warn", text: "Off by one again." },
          { path: "elsewhere.ts", line: 1, text: "Not on this branch." },
          { path: "src/a.ts", text: "No line." },
        ],
        onAdded,
      );
      expect(said).toMatch(/^Added 1 comment to Roer's Review tab/);
      expect(said).toMatch(/Skipped: elsewhere\.ts: this branch does not change it; src\/a\.ts: no line\./);
      expect(said).toMatch(/do not change code for them before then/);
      expect(onAdded).toHaveBeenCalledWith(1);

      expect(await screen.findByText("Off by one again.")).toBeInTheDocument();
      expect(screen.getByRole("note", { name: "Comment by Claude" })).toBeInTheDocument();
      // Waiting on a decision, it is not ready to go back yet.
      expect(screen.getByRole("button", { name: "Send 0 to Claude" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      expect(screen.getByText("Accepted")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Send 1 to Claude" }));
      await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
      const prompt = vi.mocked(staged.send).mock.calls[0][0];
      expect(prompt).toMatch(/^I went through the review comments on the changes on this branch since it left origin\/main/);
      expect(prompt).toMatch(/## 1\. src\/a\.ts:2\n```\nlet i = 1\n```\nClaude's comment:\nOff by one again\.\nMy decision: accepted\./);
      expect(prompt).toMatch(/Don't commit/);
    });

    it("puts a comment on a line the diff does not show at the head of its file", async () => {
      await openLocal();
      const said = await claudeComments([{ path: "src/a.ts", line: 40, text: "Further down." }]);
      expect(said).toMatch(/1 of them are on lines outside the diff/);
      expect(await screen.findByText("Further down.")).toBeInTheDocument();
      expect(screen.getByText("line 40")).toBeInTheDocument();
    });

    it("asks Claude for a review that comes back through the tool", async () => {
      const staged = await openLocal();
      fireEvent.click(screen.getByRole("button", { name: "Review with Claude" }));
      await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
      const prompt = vi.mocked(staged.send).mock.calls[0][0];
      expect(prompt).toMatch(/git diff \$\(git merge-base HEAD origin\/main\)/);
      expect(prompt).toMatch(/`code-review__add_comments` tool/);
      expect(prompt).toMatch(/Don't change any code yet/);
    });

    it("points at Claude's comments from the pull request view", async () => {
      render(<ReviewView session={session()} active />);
      await screen.findByText("Off by one.");
      await waitFor(() => expect(gitBranchDiff).toHaveBeenCalled());
      await claudeComments([{ path: "src/a.ts", line: 2, text: "Look here." }]);
      expect(await screen.findByText(/Claude left 1 comment on your local changes\./)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show them" }));
      expect(await screen.findByText("Look here.")).toBeInTheDocument();
    });

    it("checks Claude's comments against the base the tab compared with", async () => {
      vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, baseRefName: "release" });
      render(<ReviewView session={session()} active />);
      await waitFor(() => expect(gitBranchDiff).toHaveBeenCalledWith("/repo", "release"));
      await screen.findByText("Off by one.");
      vi.mocked(gitBranchDiff).mockClear();
      await claudeComments([{ path: "src/a.ts", line: 2, text: "Against release." }]);
      expect(gitBranchDiff).toHaveBeenCalledWith("/repo", "release");
    });

    it("moves a comment to the head of its file once an edit takes its line out of the diff", async () => {
      const staged = session();
      const { rerender } = render(<ReviewView session={staged} active />);
      await screen.findByText("Off by one.");
      fireEvent.click(screen.getByRole("button", { name: "Local changes" }));
      await screen.findByText("2 commits since origin/main, and what is not committed");
      comment(1, "Mind this line.");
      expect(screen.queryByText("line 2")).toBeNull();

      // The file still changes, but no longer at line 2.
      const moved = patch.replace("@@ -1,2 +1,2 @@\n keep\n-let i = 0\n+let i = 1", "@@ -9 +9 @@\n-a\n+b");
      vi.mocked(gitBranchDiff).mockResolvedValue({ root: "/repo", base: "origin/main", commits: 2, diff: moved });
      rerender(<ReviewView session={{ ...staged, changed: { root: "/repo", paths: ["src/a.ts"], broad: false } }} active />);
      expect(await screen.findByText("line 2")).toBeInTheDocument();
      expect(screen.getByText("Mind this line.")).toBeInTheDocument();

      // And once the file leaves the diff, the tab says so instead of losing it.
      vi.mocked(gitBranchDiff).mockResolvedValue({ root: "/repo", base: "origin/main", commits: 2, diff: "" });
      rerender(<ReviewView session={{ ...staged, changed: { root: "/repo", paths: ["src/a.ts"], broad: false } }} active />);
      expect(await screen.findByText(/A comment is on src\/a\.ts:2, which this diff no longer changes/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Delete them" }));
      expect(screen.queryByText(/no longer changes/)).toBeNull();
    });

    it("keeps comments under the branch a save lands on, after a checkout", async () => {
      const staged = session();
      const { rerender } = render(<ReviewView session={staged} active />);
      await screen.findByText("Off by one.");
      fireEvent.click(screen.getByRole("button", { name: "Local changes" }));
      await screen.findByText("2 commits since origin/main, and what is not committed");
      comment(1, "Before the checkout.");

      // A checkout in the pane, reported as a batch of changed files.
      vi.mocked(gitCurrentBranch).mockResolvedValue("other");
      rerender(<ReviewView session={{ ...staged, changed: { root: "/repo", paths: ["src/a.ts"], broad: false } }} active />);
      await waitFor(() => expect(screen.queryByText("Before the checkout.")).toBeNull());
      comment(1, "After the checkout.");
      expect(storedComments("/repo", "other").map((c) => c.text)).toEqual(["After the checkout."]);
      expect(storedComments("/repo", "feat").map((c) => c.text)).toEqual(["Before the checkout."]);
      vi.mocked(gitCurrentBranch).mockResolvedValue("feat");
    });

    it("says why when the branch cannot be read", async () => {
      vi.mocked(gitBranchDiff).mockRejectedValue("/repo is not in a git repository.");
      vi.mocked(ghPrForBranch).mockResolvedValue(null);
      render(<ReviewView session={session()} active />);
      expect(await screen.findByRole("alert")).toHaveTextContent("/repo is not in a git repository.");
    });
  });
});
