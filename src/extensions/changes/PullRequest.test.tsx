import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../api";
import { gitBranchDiff, gitBranches, gitCurrentBranch } from "../../lib/git";
import {
  ghMergeMethods,
  ghPrCanBypass,
  ghPrCreate,
  ghPrDiff,
  ghPrForBranch,
  ghPrMerge,
  ghPrReview,
  ghRequestCopilotReview,
  ghStatus,
  onPrDraft,
  type PrDraftRecord,
  type PrReview,
  type PrSummary,
} from "../../lib/github";
import { POLL_MS } from "./PullRequest";
import { ReviewView } from "./ReviewView";

vi.mock("../../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/github")>()),
  ghStatus: vi.fn(),
  ghMergeMethods: vi.fn(),
  ghPrCanBypass: vi.fn(),
  ghPrMerge: vi.fn(),
  ghPrForBranch: vi.fn(),
  ghPrCreate: vi.fn(),
  ghPrDiff: vi.fn(),
  ghPrReview: vi.fn(),
  ghRequestCopilotReview: vi.fn(),
  onPrDraft: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../../lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git")>()),
  gitBranchDiff: vi.fn(),
  gitBranches: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitRoot: vi.fn(async () => "/work/r"),
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
  "@@ -11,2 +11,2 @@",
  " keep",
  "-let i = 0",
  "+let i = 1",
  "",
].join("\n");

const none: PrReview = { pendingReviewers: [], reviews: [], threads: [], truncated: false };

const withThreads: PrReview = {
  pendingReviewers: [],
  reviews: [
    {
      author: "copilot-pull-request-reviewer",
      state: "COMMENTED",
      body: "Copilot reviewed 3 files.",
      submittedAt: "2026-09-01T00:00:00Z",
      url: "https://github.com/o/r/pull/19#review-1",
    },
  ],
  threads: [
    {
      id: "T1",
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 12,
      originalLine: 12,
      diffSide: "RIGHT",
      comments: [
        {
          author: "copilot-pull-request-reviewer",
          body: "Off by one here.",
          createdAt: "2026-09-01T00:00:00Z",
          url: "https://github.com/o/r/pull/19#discussion_r1",
          diffHunk: "@@ -11,2 +11,2 @@\n keep\n-let i = 0\n+let i = 1",
        },
      ],
    },
  ],
  truncated: false,
};

function session(over: Partial<Session> = {}): Session {
  return {
    pane: "%3",
    cwd: "/work/r",
    root: "/work/r",
    branch: "feat",
    agent: "claude",
    busy: false,
    changed: null,
    send: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

let draftListener: ((record: PrDraftRecord) => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ghStatus).mockResolvedValue({ installed: true, authenticated: true, repo: "o/r", message: null });
  vi.mocked(ghPrForBranch).mockResolvedValue(pr);
  vi.mocked(ghPrDiff).mockResolvedValue(patch);
  // Reset, not just cleared: a queued once-answer a test did not use must not reach the next.
  vi.mocked(ghPrReview).mockReset().mockResolvedValue(withThreads);
  vi.mocked(ghMergeMethods).mockResolvedValue({ merge: true, squash: true, rebase: true });
  vi.mocked(gitBranches).mockResolvedValue(["feat", "main"]);
  vi.mocked(gitCurrentBranch).mockResolvedValue("feat");
  vi.mocked(gitBranchDiff).mockResolvedValue({ root: "/work/r", base: "origin/main", commits: 1, diff: patch });
  vi.mocked(onPrDraft).mockImplementation(async (handler) => {
    draftListener = handler;
    return () => {
      draftListener = null;
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const view = (staged = session()) => render(<ReviewView session={staged} active scope="pr" />);

/** The form offers nothing until it has read the branches and picked a base. */
const branchesRead = (base = "main") =>
  waitFor(() => expect(screen.getByLabelText("Base branch")).toHaveValue(base));

describe("opening a pull request", () => {
  beforeEach(() => {
    vi.mocked(ghPrForBranch).mockResolvedValue(null);
  });

  it("asks the agent for a draft and fills the form from its answer", async () => {
    const staged = session();
    const onSent = vi.fn();
    render(<ReviewView session={staged} active scope="pr" onSent={onSent} />);

    // Enabled once the branches are read.
    await waitFor(() => expect(screen.getByRole("button", { name: "Draft with Claude" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Draft with Claude" }));
    await waitFor(() => expect(staged.send).toHaveBeenCalled());
    const text = vi.mocked(staged.send).mock.calls[0][0];
    expect(text).toContain("`feat` against `main`");
    expect(text).toContain("%3");
    expect(onSent).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Waiting for Claude…" })).toBeInTheDocument();

    act(() => draftListener?.({ pane: "%9", draft: { title: "someone else's", body: "" } }));
    expect(screen.getByLabelText("Title")).toHaveValue("");
    act(() => draftListener?.({ pane: "%3", draft: { title: "Add a thing", body: "Why and what." } }));
    expect(screen.getByLabelText("Title")).toHaveValue("Add a thing");
    expect(screen.getByLabelText("Description")).toHaveValue("Why and what.");
  });

  it("creates it against the chosen base, then shows it", async () => {
    vi.mocked(ghPrCreate).mockResolvedValue(pr);
    view();
    await branchesRead();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Add a thing" } });
    // GitHub has it from now on.
    vi.mocked(ghPrForBranch).mockResolvedValue(pr);
    fireEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    await waitFor(() =>
      expect(ghPrCreate).toHaveBeenCalledWith("/work/r", { title: "Add a thing", body: "", base: "main", draft: false }),
    );
    expect(await screen.findByText("Off by one here.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Open a pull request" })).toBeNull();
  });

  it("shows why gh refused, and keeps what was written", async () => {
    vi.mocked(ghPrCreate).mockRejectedValue("a pull request for branch feat already exists");
    view();
    await branchesRead();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "T" } });
    fireEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByLabelText("Title")).toHaveValue("T");
  });

  it("drops a base branch the new session's repository does not have", async () => {
    const { rerender } = view();
    await branchesRead();

    vi.mocked(gitBranches).mockResolvedValue(["trunk", "topic"]);
    vi.mocked(gitCurrentBranch).mockResolvedValue("topic");
    rerender(<ReviewView session={session({ cwd: "/work/other", pane: "%4", branch: "topic" })} active scope="pr" />);
    await waitFor(() => expect(gitBranches).toHaveBeenLastCalledWith("/work/other"));
    await branchesRead("trunk");

    // What matters is what reaches `gh pr create`: a select shows its first option for a value it does not
    // have, so the screen alone would pass.
    vi.mocked(ghPrCreate).mockResolvedValue(pr);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "T" } });
    fireEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    await waitFor(() =>
      expect(ghPrCreate).toHaveBeenCalledWith("/work/other", { title: "T", body: "", base: "trunk", draft: false }),
    );
  });
});

describe("another branch than the one checked out", () => {
  const other = () => render(<ReviewView session={session()} active scope="pr" branch="spec" />);

  it("looks up that branch's pull request", async () => {
    other();
    await screen.findByText("Off by one here.");
    expect(ghPrForBranch).toHaveBeenCalledWith("/work/r", "spec");
  });

  it("opens the pull request from it, and says so when asking for a draft", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(null);
    vi.mocked(ghPrCreate).mockResolvedValue(pr);
    const staged = session();
    render(<ReviewView session={staged} active scope="pr" branch="spec" />);
    await branchesRead();
    expect(screen.getByText("spec")).toBeInTheDocument();
    expect(gitCurrentBranch).not.toHaveBeenCalledWith("/work/r");

    fireEvent.click(screen.getByRole("button", { name: "Draft with Claude" }));
    await waitFor(() => expect(staged.send).toHaveBeenCalled());
    const text = vi.mocked(staged.send).mock.calls[0][0];
    expect(text).toMatch(/^This is about the branch `spec`, which is not the one checked out here/);
    expect(text).toContain("git diff main...spec");

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Spec" } });
    fireEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    await waitFor(() =>
      expect(ghPrCreate).toHaveBeenCalledWith("/work/r", { title: "Spec", body: "", base: "main", draft: false, head: "spec" }),
    );
  });
});

describe("Copilot", () => {
  it("is asked from the header, and waited on until its review lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(ghRequestCopilotReview).mockResolvedValue();
    const pending: PrReview = { ...none, pendingReviewers: ["copilot-pull-request-reviewer"] };
    vi.mocked(ghPrReview)
      .mockResolvedValueOnce(none)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(withThreads);
    const onOpenCount = vi.fn();
    render(<ReviewView session={session()} active scope="pr" onOpenCount={onOpenCount} />);

    fireEvent.click(await screen.findByRole("button", { name: "Request Copilot review" }));
    expect(await screen.findByRole("button", { name: "Copilot is reviewing…" })).toBeDisabled();
    expect(ghRequestCopilotReview).toHaveBeenCalledWith("/work/r", 19);

    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(screen.queryByText("Off by one here.")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(await screen.findByText("Off by one here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request Copilot review" })).toBeEnabled();
    // The strip counts the new thread, which is how a review that landed while the tab was away shows.
    expect(onOpenCount).toHaveBeenLastCalledWith(1);
  });

  it("stops waiting on a review that lands before the first fetch", async () => {
    vi.mocked(ghRequestCopilotReview).mockResolvedValue();
    vi.mocked(ghPrReview).mockResolvedValueOnce(none).mockResolvedValue(withThreads);
    view();

    fireEvent.click(await screen.findByRole("button", { name: "Request Copilot review" }));
    expect(await screen.findByText("Off by one here.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Request Copilot review" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Copilot is reviewing…" })).toBeNull();
  });

  it("shows the reviews' own words above the diff", async () => {
    view();
    fireEvent.click(await screen.findByText("copilot-pull-request-reviewer"));
    expect(screen.getByText("Copilot reviewed 3 files.")).toBeInTheDocument();
  });
});

describe("merging", () => {
  it("offers only what the repository allows and asks before merging", async () => {
    vi.mocked(ghMergeMethods).mockResolvedValue({ merge: false, squash: true, rebase: true });
    vi.mocked(ghPrMerge).mockResolvedValue({ ...pr, state: "MERGED" });
    view();

    const methods = await screen.findByLabelText("Merge method");
    expect([...(methods as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      "Squash and merge",
      "Rebase and merge",
    ]);
    fireEvent.change(methods, { target: { value: "rebase" } });
    fireEvent.click(screen.getByRole("button", { name: "Rebase and merge" }));
    expect(ghPrMerge).not.toHaveBeenCalled();

    expect(screen.getByRole("group", { name: "Confirm merge" })).toHaveTextContent(
      "Rebase and merge #19 into main? This closes the pull request.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm rebase and merge" }));

    expect(await screen.findByText(/Merged into/)).toBeInTheDocument();
    expect(screen.getByText("MERGED")).toBeInTheDocument();
    // Pinned to the head that was on screen.
    expect(ghPrMerge).toHaveBeenCalledWith("/work/r", 19, "rebase", "abc123", false);
    expect(localStorage.getItem("roer:merge-method")).toBe("rebase");
    expect(screen.queryByRole("button", { name: "Request Copilot review" })).toBeNull();
  });

  it("bypasses the base's rules only when ticked, by someone GitHub lets", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, mergeStateStatus: "BLOCKED" });
    vi.mocked(ghPrCanBypass).mockResolvedValue(true);
    vi.mocked(ghPrMerge).mockResolvedValue({ ...pr, state: "MERGED" });
    view();

    const box = await screen.findByRole("checkbox", { name: /bypass rules/ });
    expect(box).not.toBeChecked();
    expect(ghPrCanBypass).toHaveBeenCalledWith("/work/r", 19);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Create a merge commit" }));

    expect(screen.getByRole("group", { name: "Confirm merge" })).toHaveTextContent(
      "Create a merge commit #19 into main, bypassing its rules? This closes the pull request.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Bypass rules and create a merge commit" }));
    expect(await screen.findByText(/Merged into/)).toBeInTheDocument();
    expect(ghPrMerge).toHaveBeenCalledWith("/work/r", 19, "merge", "abc123", true);
  });

  it("forgets a ticked bypass once the pull request on screen changes", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, mergeStateStatus: "BLOCKED" });
    vi.mocked(ghPrCanBypass).mockResolvedValue(true);
    vi.mocked(ghPrMerge).mockResolvedValue({ ...pr, state: "MERGED" });
    view();
    fireEvent.click(await screen.findByRole("checkbox", { name: /bypass rules/ }));

    // A new head, still held back: ticked for the old one, not for this.
    vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, headRefOid: "def456", mergeStateStatus: "BLOCKED" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /bypass rules/ })).not.toBeChecked());

    fireEvent.click(screen.getByRole("button", { name: "Create a merge commit" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm create a merge commit" }));
    expect(await screen.findByText(/Merged into/)).toBeInTheDocument();
    expect(ghPrMerge).toHaveBeenCalledWith("/work/r", 19, "merge", "def456", false);
  });

  it("says why a held-back merge will be refused when it cannot be bypassed", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, mergeStateStatus: "BLOCKED" });
    vi.mocked(ghPrCanBypass).mockResolvedValue(false);
    view();

    expect(await screen.findByText(/rules for/)).toHaveTextContent("GitHub will refuse the merge until they are.");
    expect(screen.queryByRole("checkbox", { name: /bypass rules/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Create a merge commit" })).toBeEnabled();
  });

  it("does not ask about bypassing a pull request nothing holds back", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, mergeStateStatus: "CLEAN" });
    view();
    await screen.findByRole("button", { name: "Create a merge commit" });
    expect(ghPrCanBypass).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Create a merge commit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ghPrMerge).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create a merge commit" })).toBeInTheDocument();
  });

  it("starts from the method used last time", async () => {
    localStorage.setItem("roer:merge-method", "squash");
    view();
    expect(await screen.findByRole("button", { name: "Squash and merge" })).toBeEnabled();
  });

  it("has no choice to make when only one method is allowed", async () => {
    vi.mocked(ghMergeMethods).mockResolvedValue({ merge: false, squash: true, rebase: false });
    view();
    await screen.findByRole("button", { name: "Squash and merge" });
    expect(screen.getByLabelText("Merge method")).toBeDisabled();
  });

  it("shows GitHub's refusal and stays open", async () => {
    vi.mocked(ghPrMerge).mockRejectedValue("Head branch was modified. Review and try the merge again.");
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Create a merge commit" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm create a merge commit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Head branch was modified");
    expect(screen.getByRole("button", { name: "Create a merge commit" })).toBeInTheDocument();
  });

  it("will not merge a draft", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, isDraft: true });
    view();
    expect(await screen.findByText(/draft pull request cannot be merged/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a merge commit" })).toBeDisabled();
  });
});
