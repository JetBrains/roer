/**
 * Typed bridge to the Rust GitHub layer, which is the person's own `gh`.
 *
 * Like the git bridge, every call carries the directory it is about: the
 * pull request is always the one for the branch the staged session is on.
 * The prompt builders below are what the Pull Request tab types into that
 * session when it hands the agent a job.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  /** `owner/name`, when the directory is in a GitHub repository. */
  repo: string | null;
  message: string | null;
}

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
}

export interface Review {
  author: string;
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
}

export interface ReviewComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
  diffHunk: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: ReviewComment[];
}

export interface PrReview {
  pendingReviewers: string[];
  reviews: Review[];
  threads: ReviewThread[];
}

export interface Upstream {
  upstream: string | null;
  ahead: number;
  behind: number;
}

export const ghStatus = (dir: string): Promise<GhStatus> => invoke("gh_status", { dir });

export const ghPrForBranch = (dir: string): Promise<PrSummary | null> =>
  invoke("gh_pr_for_branch", { dir });

export const ghPrCreate = (
  dir: string,
  pr: { title: string; body: string; base: string; draft: boolean },
): Promise<PrSummary> => invoke("gh_pr_create", { dir, ...pr });

export const ghRequestCopilotReview = (dir: string, number: number): Promise<void> =>
  invoke("gh_request_copilot_review", { dir, number });

export const ghPrReview = (dir: string, number: number): Promise<PrReview> =>
  invoke("gh_pr_review", { dir, number });

export const gitUpstreamStatus = (cwd: string): Promise<Upstream> =>
  invoke("git_upstream_status", { cwd });

export const openUrl = (url: string): Promise<void> => invoke("open_url", { url });

/** Submits `text` as a prompt to whatever is running in `pane`. */
export const sendToSession = (pane: string, text: string): Promise<void> =>
  invoke("roer_send", { pane, text });

export interface PrDraftRecord {
  pane: string;
  draft: { title: string; body: string };
}

function isPrDraftRecord(value: unknown): value is PrDraftRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const draft = v.draft as Record<string, unknown> | null | undefined;
  return (
    typeof v.pane === "string" &&
    typeof draft === "object" &&
    draft !== null &&
    typeof draft.title === "string" &&
    typeof draft.body === "string"
  );
}

/** A title and body the agent drafted with `roer pr-draft`. */
export const onPrDraft = (handler: (record: PrDraftRecord) => void): Promise<UnlistenFn> =>
  listen<PrDraftRecord>("roer://pr-draft", (event) => {
    if (isPrDraftRecord(event.payload)) handler(event.payload);
  });

/** Copilot's reviewer is a bot, `copilot-pull-request-reviewer`. */
export const isCopilot = (login: string): boolean => login.toLowerCase().includes("copilot");

/** Whether Copilot has been asked and has not answered yet. */
export const copilotPending = (review: PrReview | null): boolean =>
  Boolean(review?.pendingReviewers.some(isCopilot));

/** The line a thread is about, or the one it was about before it moved. */
export const threadLine = (thread: ReviewThread): number | null =>
  thread.line ?? thread.originalLine;

/**
 * Asks the session's agent for a title and body, answered through
 * `roer pr-draft` rather than printed, so the tab can fill its form. The pane
 * is spelled out because the agent's shell may not be the one that knows it.
 */
export function draftPrPrompt(pane: string, branch: string, base: string): string {
  return [
    `Draft a pull request title and description for the branch \`${branch}\` against \`${base}\`.`,
    `Base it on \`git log ${base}..HEAD\` and \`git diff ${base}...HEAD\`, and on what we did in this session.`,
    "Keep the title under 72 characters. The description should say why the change is made, what it changes, and how it was tested, in GitHub markdown.",
    "Do not create the pull request and do not push. When the draft is ready, hand it to Roer by running exactly:",
    "",
    `roer pr-draft --pane ${pane} <<'ROER_PR_DRAFT'`,
    '{"title": "<title>", "body": "<description, JSON-escaped>"}',
    "ROER_PR_DRAFT",
  ].join("\n");
}

/**
 * Hands the agent the threads to address, with enough of each — where it is,
 * the hunk it was left on, the whole conversation — that it does not need to
 * go and fetch the pull request itself.
 */
export function fixThreadsPrompt(pr: PrSummary, threads: readonly ReviewThread[]): string {
  const parts = [
    `Address these review comments on pull request #${pr.number} (${pr.url}).`,
    "For each one, make the change if the comment is right; if it is wrong, say why instead of changing code.",
    "Then commit the fixes and push the branch.",
  ];
  threads.forEach((thread, i) => {
    const line = threadLine(thread);
    const where = line === null ? thread.path : `${thread.path}:${line}`;
    parts.push("", `## ${i + 1}. ${where}${thread.isOutdated ? " (outdated)" : ""}`);
    const hunk = thread.comments[0]?.diffHunk;
    if (hunk) parts.push("```diff", hunk, "```");
    for (const comment of thread.comments) {
      parts.push(`**${comment.author}** (${comment.url}):`, comment.body.trim());
    }
  });
  return parts.join("\n");
}
