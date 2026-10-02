import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POLL_MS, PullRequestView } from "./PullRequestView";
import { gitBranches, gitCurrentBranch } from "./lib/git";
import {
  ghMergeMethods,
  ghPrCanBypass,
  ghPrCreate,
  ghPrForBranch,
  ghPrMerge,
  ghPrReview,
  ghRequestCopilotReview,
  ghStatus,
  onPrDraft,
  sendToSession,
  type PrDraftRecord,
  type PrReview,
  type PrSummary,
} from "./lib/github";

vi.mock("./lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/github")>()),
  ghStatus: vi.fn(),
  ghMergeMethods: vi.fn(),
  ghPrCanBypass: vi.fn(),
  ghPrMerge: vi.fn(),
  ghPrForBranch: vi.fn(),
  ghPrCreate: vi.fn(),
  ghPrReview: vi.fn(),
  ghRequestCopilotReview: vi.fn(),
  onPrDraft: vi.fn(),
  openUrl: vi.fn(),
  sendToSession: vi.fn(),
}));

vi.mock("./lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/git")>()),
  gitBranches: vi.fn(),
  gitCurrentBranch: vi.fn(),
}));

vi.mock("./lib/session", () => ({
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

const copilotReview = {
  author: "copilot-pull-request-reviewer",
  state: "COMMENTED",
  body: "Copilot reviewed 3 files.",
  submittedAt: "2026-09-01T00:00:00Z",
  url: "https://github.com/o/r/pull/19#review-1",
};

const withThreads: PrReview = {
  pendingReviewers: [],
  reviews: [copilotReview],
  threads: [
    {
      id: "T1",
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 12,
      originalLine: 12,
      comments: [
        {
          author: "copilot-pull-request-reviewer",
          body: "Off by one here.",
          createdAt: "2026-09-01T00:00:00Z",
          url: "https://github.com/o/r/pull/19#discussion_r1",
          diffHunk: "@@ -1 +1 @@\n-a\n+b",
        },
      ],
    },
    {
      id: "T2",
      isResolved: true,
      isOutdated: false,
      path: "src/b.ts",
      line: 3,
      originalLine: 3,
      comments: [
        {
          author: "octocat",
          body: "Already handled.",
          createdAt: "2026-09-01T00:00:00Z",
          url: "https://github.com/o/r/pull/19#discussion_r2",
          diffHunk: "",
        },
      ],
    },
  ],
  truncated: false,
};

let draftListener: ((record: PrDraftRecord) => void) | null = null;

beforeEach(() => {
  vi.mocked(ghStatus).mockResolvedValue({ installed: true, authenticated: true, repo: "o/r", message: null });
  vi.mocked(gitBranches).mockResolvedValue(["feat", "main"]);
  vi.mocked(gitCurrentBranch).mockResolvedValue("feat");
  vi.mocked(sendToSession).mockResolvedValue();
  vi.mocked(ghMergeMethods).mockResolvedValue({ merge: true, squash: true, rebase: true });
  localStorage.clear();
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

/** Radix opens a menu from the keyboard in jsdom; a click needs pointer
 * events jsdom does not have. */
const openMethods = () =>
  fireEvent.keyDown(screen.getByRole("button", { name: "Choose merge method" }), { key: "Enter" });

const view = (props: Partial<React.ComponentProps<typeof PullRequestView>> = {}) =>
  render(<PullRequestView cwd="/work/r" pane="%3" active {...props} />);

describe("PullRequestView", () => {
  it("explains a missing login instead of offering anything", async () => {
    vi.mocked(ghStatus).mockResolvedValue({
      installed: true,
      authenticated: false,
      repo: null,
      message: "gh is not logged in. Run `gh auth login` in a terminal.",
    });
    view();
    expect(await screen.findByText(/gh auth login/)).toBeInTheDocument();
    expect(ghPrForBranch).not.toHaveBeenCalled();
  });

  it("asks Claude for a draft and fills the form from its answer", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(null);
    const onSent = vi.fn();
    view({ onSent });

    fireEvent.click(await screen.findByRole("button", { name: "Draft with Claude" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalled());
    const [pane, text] = vi.mocked(sendToSession).mock.calls[0];
    expect(pane).toBe("%3");
    expect(text).toContain("`feat` against `main`");
    expect(onSent).toHaveBeenCalled();

    act(() => draftListener?.({ pane: "%9", draft: { title: "someone else's", body: "" } }));
    expect(screen.getByLabelText("Title")).toHaveValue("");
    act(() => draftListener?.({ pane: "%3", draft: { title: "Add a thing", body: "Why and what." } }));
    expect(screen.getByLabelText("Title")).toHaveValue("Add a thing");
    expect(screen.getByLabelText("Description")).toHaveValue("Why and what.");
  });

  it("names the session's agent, and hands nothing to a plain shell", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(null);
    const { rerender } = view({ agent: "Reviewer" });
    expect(await screen.findByRole("button", { name: "Draft with Reviewer" })).toBeEnabled();

    rerender(<PullRequestView cwd="/work/r" pane="%3" active agent={null} />);
    const draft = screen.getByRole("button", { name: "Draft with an agent" });
    expect(draft).toBeDisabled();
    fireEvent.click(draft);
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("creates the pull request against the chosen base", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(null);
    vi.mocked(ghPrCreate).mockResolvedValue(pr);
    vi.mocked(ghPrReview).mockResolvedValue({ pendingReviewers: [], reviews: [], threads: [], truncated: false });
    view();

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Add a thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    expect(await screen.findByText("#19 Add a thing")).toBeInTheDocument();
    expect(ghPrCreate).toHaveBeenCalledWith("/work/r", { title: "Add a thing", body: "", base: "main", draft: false });
  });

  it("sends the selected unresolved threads to Claude", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(pr);
    vi.mocked(ghPrReview).mockResolvedValue(withThreads);
    view();

    expect(await screen.findByText("1 unresolved of 2")).toBeInTheDocument();
    // A resolved thread cannot be picked.
    expect(screen.queryByLabelText("Select src/b.ts:3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select src/a.ts:12"));
    fireEvent.click(screen.getByRole("button", { name: "Fix with Claude (1)" }));

    await waitFor(() => expect(sendToSession).toHaveBeenCalled());
    const [, text] = vi.mocked(sendToSession).mock.calls[0];
    expect(text).toContain("## 1. src/a.ts:12");
    expect(text).toContain("Off by one here.");
    expect(text).not.toContain("Already handled.");
  });

  it("drops a base branch the new session's repository does not have", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(null);
    const { rerender } = view();
    expect(await screen.findByLabelText("Base branch")).toHaveValue("main");

    vi.mocked(gitBranches).mockResolvedValue(["trunk", "topic"]);
    vi.mocked(gitCurrentBranch).mockResolvedValue("topic");
    rerender(<PullRequestView cwd="/work/other" pane="%4" active />);
    await waitFor(() => expect(gitCurrentBranch).toHaveBeenLastCalledWith("/work/other"));

    // What matters is what reaches `gh pr create`: a select shows its first
    // option for a value it does not have, so the screen alone would pass.
    vi.mocked(ghPrCreate).mockResolvedValue(pr);
    vi.mocked(ghPrReview).mockResolvedValue(withThreads);
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "T" } });
    fireEvent.click(screen.getByRole("button", { name: "Push and create pull request" }));
    await waitFor(() =>
      expect(ghPrCreate).toHaveBeenCalledWith("/work/other", { title: "T", body: "", base: "trunk", draft: false }),
    );
  });

  it("reports a Copilot review that lands before the first fetch", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(pr);
    vi.mocked(ghRequestCopilotReview).mockResolvedValue();
    vi.mocked(ghPrReview)
      .mockResolvedValueOnce({ pendingReviewers: [], reviews: [], threads: [], truncated: false })
      .mockResolvedValue(withThreads);
    const onReviewLanded = vi.fn();
    view({ onReviewLanded });

    fireEvent.click(await screen.findByRole("button", { name: "Request Copilot review" }));
    await waitFor(() => expect(onReviewLanded).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Request Copilot review" })).toBeEnabled();
  });

  it("colours the code a thread is about", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(pr);
    const hunk = "@@ -1,2 +1,2 @@\n const keep = 1;\n-const a = 1;\n+const a = 2;";
    vi.mocked(ghPrReview).mockResolvedValue({
      ...withThreads,
      threads: [{ ...withThreads.threads[0], comments: [{ ...withThreads.threads[0].comments[0], diffHunk: hunk }] }],
    });
    view();

    await screen.findByText("1 unresolved of 1");
    const snippet = document.querySelector(".pr-hunk")!;
    // The header is GitHub's bookkeeping, not code.
    expect(snippet.textContent).not.toContain("@@");
    const rows = [...snippet.children].map((row) => [row.className, row.textContent]);
    expect(rows).toEqual([
      ["", " const keep = 1;"],
      ["del", "-const a = 1;"],
      ["add", "+const a = 2;"],
    ]);
    // Coloured by the grammar (an inline colour) or, until it loads, by the
    // fallback (a class): either way `const` is not plain text.
    const keyword = [...snippet.querySelectorAll(".add span")].find((span) => span.textContent === "const")!;
    expect(keyword.className === "t-keyword" || (keyword as HTMLElement).style.color !== "").toBe(true);
  });

  describe("merging", () => {
    beforeEach(() => {
      vi.mocked(ghPrForBranch).mockResolvedValue(pr);
      vi.mocked(ghPrReview).mockResolvedValue(withThreads);
    });

    it("offers only what the repository allows and asks before merging", async () => {
      vi.mocked(ghMergeMethods).mockResolvedValue({ merge: false, squash: true, rebase: true });
      vi.mocked(ghPrMerge).mockResolvedValue({ ...pr, state: "MERGED" });
      view();

      // The split button's face is the first allowed method; its arrow opens
      // the rest.
      await screen.findByRole("button", { name: "Squash and merge" });
      openMethods();
      const options = screen.getAllByRole("menuitemradio");
      expect(options.map((o) => o.querySelector("strong")?.textContent)).toEqual([
        "Squash and merge",
        "Rebase and merge",
      ]);
      expect(options[0]).toHaveAttribute("aria-checked", "true");
      fireEvent.click(options[1]);
      fireEvent.click(await screen.findByRole("button", { name: "Rebase and merge" }));
      expect(ghPrMerge).not.toHaveBeenCalled();

      expect(screen.getByRole("group", { name: "Confirm merge" })).toHaveTextContent(
        "Rebase and merge #19 into main? This closes the pull request.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Confirm rebase and merge" }));

      expect(await screen.findByText(/Merged into/)).toBeInTheDocument();
      // Pinned to the head that was on screen.
      expect(ghPrMerge).toHaveBeenCalledWith("/work/r", 19, "rebase", "abc123", false);
      expect(localStorage.getItem("roer:merge-method")).toBe("rebase");
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

    it("merges by the rules while the bypass is not ticked", async () => {
      vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, mergeStateStatus: "BLOCKED" });
      vi.mocked(ghPrCanBypass).mockResolvedValue(true);
      vi.mocked(ghPrMerge).mockResolvedValue({ ...pr, state: "MERGED" });
      view();

      await screen.findByRole("checkbox", { name: /bypass rules/ });
      fireEvent.click(screen.getByRole("button", { name: "Create a merge commit" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm create a merge commit" }));
      expect(await screen.findByText(/Merged into/)).toBeInTheDocument();
      expect(ghPrMerge).toHaveBeenCalledWith("/work/r", 19, "merge", "abc123", false);
    });

    it("says why a held-back merge will be refused when it cannot be bypassed", async () => {
      vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, mergeStateStatus: "BLOCKED" });
      vi.mocked(ghPrCanBypass).mockResolvedValue(false);
      view();

      expect(await screen.findByText(/rules for/)).toHaveTextContent("GitHub will refuse the merge until they are.");
      expect(screen.queryByRole("checkbox", { name: /bypass rules/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create a merge commit" })).toBeEnabled();
    });

    it("does not ask about bypassing a pull request nothing holds back", async () => {
      vi.mocked(ghPrForBranch).mockResolvedValue({ ...pr, mergeStateStatus: "CLEAN" });
      view();

      await screen.findByRole("button", { name: "Create a merge commit" });
      expect(ghPrCanBypass).not.toHaveBeenCalled();
      expect(screen.queryByRole("checkbox", { name: /bypass rules/ })).not.toBeInTheDocument();
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

    it("has no menu to open when only one method is allowed", async () => {
      vi.mocked(ghMergeMethods).mockResolvedValue({ merge: false, squash: true, rebase: false });
      view();
      await screen.findByRole("button", { name: "Squash and merge" });
      expect(screen.getByRole("button", { name: "Choose merge method" })).toBeDisabled();
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

  it("says when GitHub had more comments than were loaded", async () => {
    vi.mocked(ghPrForBranch).mockResolvedValue(pr);
    vi.mocked(ghPrReview).mockResolvedValue({ ...withThreads, truncated: true });
    view();
    expect(await screen.findByText(/more review comments than Roer loads at once/)).toBeInTheDocument();
  });

  it("polls a requested Copilot review until it lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(ghPrForBranch).mockResolvedValue(pr);
    vi.mocked(ghRequestCopilotReview).mockResolvedValue();
    const pending: PrReview = { pendingReviewers: ["copilot-pull-request-reviewer"], reviews: [], threads: [], truncated: false };
    vi.mocked(ghPrReview)
      .mockResolvedValueOnce({ pendingReviewers: [], reviews: [], threads: [], truncated: false })
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(withThreads);
    const onReviewLanded = vi.fn();
    view({ onReviewLanded });

    fireEvent.click(await screen.findByRole("button", { name: "Request Copilot review" }));
    expect(await screen.findByRole("button", { name: "Copilot is reviewing…" })).toBeDisabled();
    expect(ghRequestCopilotReview).toHaveBeenCalledWith("/work/r", 19);

    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(onReviewLanded).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    await waitFor(() => expect(onReviewLanded).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Request Copilot review" })).toBeEnabled();
    expect(screen.getByText("1 unresolved of 2")).toBeInTheDocument();
  });
});
