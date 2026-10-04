import { useCallback, useEffect, useRef, useState } from "react";
import {
  copilotPending,
  draftPrPrompt,
  ghMergeMethods,
  ghPrCanBypass,
  ghPrCreate,
  ghPrMerge,
  ghPrReview,
  ghRequestCopilotReview,
  gitBranches,
  gitCurrentBranch,
  isCopilot,
  Markdown,
  MERGE_METHODS,
  onPrDraft,
  type MergeMethod,
  type MergeMethods,
  type PrReview,
  type PrSummary,
  type Session,
} from "roer";
import { Button } from "roer/ui";

import { onBranch } from "./local";

/** How often a pending Copilot review is checked on, and for how long. */
export const POLL_MS = 30_000;
export const POLL_FOR_MS = 20 * 60_000;

export interface OpenPullRequestProps {
  /** Where `gh` and git run: the session's directory. */
  dir: string;
  /** Another branch than the one checked out, to open it from. */
  branch?: string;
  session: Session;
  /** The agent's name, for the button that asks it for a draft. */
  agent: string;
  /** The pull request is open on GitHub; resolves once the view has loaded it. */
  onCreated: () => Promise<void>;
  /** A prompt went to the session; show it. */
  onSent?: () => void;
}

/**
 * The branch has no pull request yet: a title and description, written by
 * hand or drafted by the agent (which hands them back through `roer
 * pr-draft`), and one button that pushes the branch and opens it.
 */
export function OpenPullRequest({ dir, branch: other, session, agent, onCreated, onSent }: OpenPullRequestProps) {
  const [branch, setBranch] = useState(other ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState<"draft" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void Promise.all([gitBranches(dir), other ?? gitCurrentBranch(dir)])
      .then(([names, on]) => {
        if (gone) return;
        setBranches(names);
        setBranch(on);
        // A base picked earlier is kept only while it is still a branch here and not the one the pull request
        // would come from.
        setBase(
          (existing) =>
            (existing && existing !== on && names.includes(existing) ? existing : "") ||
            ["main", "master"].find((name) => names.includes(name) && name !== on) ||
            names.find((name) => name !== on) ||
            "",
        );
      })
      .catch((cause: unknown) => !gone && setError(String(cause)));
    return () => {
      gone = true;
    };
  }, [dir, other]);

  const pane = session.pane;
  useEffect(() => {
    const unlisten = onPrDraft((record) => {
      if (record.pane !== pane) return;
      setTitle(record.draft.title);
      setBody(record.draft.body);
      setDrafting(false);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [pane]);

  const run = async (what: "draft" | "create", job: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await job();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const askForDraft = () =>
    run("draft", async () => {
      if (!pane) return;
      await session.send(onBranch(draftPrPrompt(pane, branch, base), other));
      setDrafting(true);
      onSent?.();
    });

  const create = () =>
    run("create", async () => {
      await ghPrCreate(dir, { title: title.trim(), body, base, draft, ...(other ? { head: other } : {}) });
      await onCreated();
    });

  return (
    <form
      className="pr-create"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="pr-head">
        <h2>Open a pull request</h2>
        <span className="muted">
          <code>{branch || "(detached)"}</code> into
        </span>
        <select aria-label="Base branch" value={base} onChange={(e) => setBase(e.target.value)}>
          {branches
            .filter((name) => name !== branch)
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="gen-button primary"
          disabled={busy !== null || !base || !branch || !pane}
          title={pane ? undefined : "Needs a live session to send the prompt to"}
          onClick={() => void askForDraft()}
        >
          {drafting ? `Waiting for ${agent}…` : `Draft with ${agent}`}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        aria-label="Description"
        placeholder="Description (markdown)"
        rows={14}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="pr-actions">
        <label className="gen-checkbox">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          <span>Draft</span>
        </label>
        <button type="submit" className="gen-button primary" disabled={busy !== null || !title.trim() || !base || !branch}>
          {busy === "create" ? "Pushing and creating…" : "Push and create pull request"}
        </button>
      </div>
    </form>
  );
}

/** How many reviews Copilot has submitted, to tell a new one from the last. */
function copilotReviews(review: PrReview | null): number {
  return review?.reviews.filter((one) => isCopilot(one.author)).length ?? 0;
}

/**
 * Asks Copilot to review `pr`, and waits for it: from the moment it was asked,
 * or found already pending, until Copilot has submitted one more review than
 * it had then. Meanwhile the review is fetched again every `POLL_MS`, while
 * the tab is away too, which is when it lands; each fetch goes to `onReview`
 * with the pull request it is for.
 */
export function useCopilotReview(
  dir: string | null,
  pr: PrSummary | null,
  review: PrReview | null,
  onReview: (url: string, review: PrReview) => void,
): { waiting: boolean; request: () => Promise<void> } {
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const baseline = useRef(0);
  const url = pr?.url;
  const number = pr?.number;
  const shown = useRef(url);
  shown.current = url;

  // Another pull request is another wait.
  useEffect(() => setWaitingSince(null), [url]);

  useEffect(() => {
    if (waitingSince === null && copilotPending(review)) {
      baseline.current = copilotReviews(review);
      setWaitingSince(Date.now());
    }
  }, [review, waitingSince]);

  useEffect(() => {
    if (waitingSince !== null && review && copilotReviews(review) > baseline.current && !copilotPending(review)) {
      setWaitingSince(null);
    }
  }, [review, waitingSince]);

  useEffect(() => {
    if (waitingSince === null || !dir || !url || number === undefined) return;
    // Clearing the timer does not stop a poll already in flight; this does.
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() - waitingSince > POLL_FOR_MS) {
        setWaitingSince(null);
        return;
      }
      void ghPrReview(dir, number)
        .then((fresh) => {
          if (!stopped) onReview(url, fresh);
        })
        .catch(() => {
          /* A missed poll is retried on the next tick. */
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [waitingSince, dir, url, number, onReview]);

  const request = useCallback(async () => {
    if (!dir || !url || number === undefined) return;
    // Counted before asking, so a review that lands before the fetch below is the one that was asked for, not
    // the baseline to wait past.
    baseline.current = copilotReviews(review);
    await ghRequestCopilotReview(dir, number);
    const fresh = await ghPrReview(dir, number);
    if (shown.current !== url) return;
    onReview(url, fresh);
    // Already in, as a quick review can be: nothing to wait for.
    if (copilotReviews(fresh) > baseline.current && !copilotPending(fresh)) return;
    setWaitingSince(Date.now());
  }, [dir, url, number, review, onReview]);

  return { waiting: waitingSince !== null, request };
}

/** The reviews' own verdicts and words, above the threads drawn in the diff. */
export function Reviews({ review }: { review: PrReview }) {
  // A bare COMMENTED review with no body is just the envelope around inline comments, which the diff shows.
  const worth = review.reviews.filter((r) => r.body.trim() || r.state !== "COMMENTED");
  if (worth.length === 0) return null;
  return (
    <div className="pr-reviews">
      {worth.map((r, i) => (
        <details key={`${r.url}-${i}`} className="pr-review">
          <summary>
            <strong>{r.author}</strong> <span className={`pr-verdict ${r.state.toLowerCase()}`}>{verdict(r.state)}</span>
          </summary>
          {r.body.trim() ? <Markdown className="file-markdown pr-md">{r.body}</Markdown> : null}
        </details>
      ))}
    </div>
  );
}

function verdict(state: string): string {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "DISMISSED":
      return "dismissed";
    default:
      return "commented";
  }
}

const METHOD_KEY = "roer:merge-method";

/** The last method used, remembered per viewer; storage may be unavailable. */
function rememberedMethod(): MergeMethod | null {
  try {
    const stored = localStorage.getItem(METHOD_KEY);
    return MERGE_METHODS.some((m) => m.method === stored) ? (stored as MergeMethod) : null;
  } catch {
    return null;
  }
}

function rememberMethod(method: MergeMethod) {
  try {
    localStorage.setItem(METHOD_KEY, method);
  } catch {
    /* Only a convenience: next time starts from the default again. */
  }
}

/**
 * The end of a review: merge the pull request into its base, which closes
 * it. Two steps, pick and press, then confirm, since it cannot be undone from
 * here. One held back by the base's rules can be merged anyway by someone
 * GitHub lets bypass them, as on its own page, once they tick that. Give it a
 * `key` of the head and merge state, so a bypass ticked for one is never
 * carried to another.
 */
export function MergeBox({ dir, pr, onMerged }: { dir: string; pr: PrSummary; onMerged: (pr: PrSummary) => void }) {
  const [methods, setMethods] = useState<MergeMethods | null>(null);
  const [canBypass, setCanBypass] = useState(false);
  const [picked, setPicked] = useState<MergeMethod | null>(rememberedMethod);
  const [confirming, setConfirming] = useState(false);
  const [bypassTicked, setBypassTicked] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = pr.state === "OPEN";
  const held = pr.mergeStateStatus === "BLOCKED";
  useEffect(() => {
    if (!open) return;
    let gone = false;
    void Promise.all([
      // Not knowing the settings is no reason to hide merging: offer all three and let GitHub refuse the one it
      // does not allow.
      ghMergeMethods(dir).catch(() => ({ merge: true, squash: true, rebase: true })),
      // Asked only of one held back by its rules. Not knowing is not offering: the plain merge is still there,
      // for GitHub to refuse.
      held ? ghPrCanBypass(dir, pr.number).catch(() => false) : false,
    ]).then(([allowed, bypass]) => {
      if (gone) return;
      setMethods(allowed);
      setCanBypass(bypass);
    });
    return () => {
      gone = true;
    };
  }, [dir, pr.number, open, held]);

  const allowed = MERGE_METHODS.filter((m) => methods?.[m.method]);
  // What was picked, if the repository still allows it; else its first.
  const method = allowed.find((m) => m.method === picked)?.method ?? allowed[0]?.method;
  const label = MERGE_METHODS.find((m) => m.method === method)?.label ?? "Merge";
  // Only while it is still held back: a fresh status that is not drops it.
  const bypass = held && canBypass && bypassTicked;

  if (pr.state === "MERGED") {
    return (
      <p className="pr-merge muted">
        Merged into <code>{pr.baseRefName}</code>.
      </p>
    );
  }
  if (!open || !methods) return null;

  const blocked = pr.isDraft
    ? "A draft pull request cannot be merged; mark it ready for review on GitHub first."
    : allowed.length === 0
      ? "This repository allows no merge method."
      : null;

  const merge = async () => {
    if (!method) return;
    rememberMethod(method);
    setMerging(true);
    setError(null);
    try {
      onMerged(await ghPrMerge(dir, pr.number, method, pr.headRefOid, bypass));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setMerging(false);
      setConfirming(false);
    }
  };

  return (
    <div className="pr-merge">
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {confirming && method ? (
        <div className="pr-merge-row" role="group" aria-label="Confirm merge">
          <span>
            {label} <strong>#{pr.number}</strong> into <code>{pr.baseRefName}</code>
            {bypass ? ", bypassing its rules" : ""}? This closes the pull request.
          </span>
          <button type="button" className={bypass ? "gen-button primary danger" : "gen-button primary"} disabled={merging} onClick={() => void merge()}>
            {merging ? "Merging…" : bypass ? `Bypass rules and ${label.toLowerCase()}` : `Confirm ${label.toLowerCase()}`}
          </button>
          <Button disabled={merging} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="pr-merge-row">
          <select
            aria-label="Merge method"
            value={method ?? ""}
            disabled={Boolean(blocked) || allowed.length < 2}
            onChange={(e) => setPicked(e.target.value as MergeMethod)}
          >
            {allowed.map((m) => (
              <option key={m.method} value={m.method} title={m.description}>
                {m.label}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={Boolean(blocked) || !method} onClick={() => setConfirming(true)}>
            {label}
          </Button>
          {blocked ? <span className="muted">{blocked}</span> : null}
          {!blocked && held && !canBypass ? (
            <span className="muted">
              The rules for <code>{pr.baseRefName}</code> are not met yet, such as a review or a check; GitHub will
              refuse the merge until they are.
            </span>
          ) : null}
          {!blocked && held && canBypass ? (
            <label className="gen-checkbox">
              <input type="checkbox" checked={bypassTicked} onChange={(e) => setBypassTicked(e.target.checked)} />
              <span>Merge without waiting for requirements to be met (bypass rules)</span>
            </label>
          ) : null}
        </div>
      )}
    </div>
  );
}
