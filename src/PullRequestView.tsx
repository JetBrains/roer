import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spans } from "./CodeLine";
import { parseDiff } from "./lib/diff";
import { gitBranches, gitCurrentBranch } from "./lib/git";
import {
  copilotPending,
  draftPrPrompt,
  fixThreadsPrompt,
  ghMergeMethods,
  ghPrCreate,
  ghPrForBranch,
  ghPrMerge,
  ghPrReview,
  ghRequestCopilotReview,
  ghStatus,
  isCopilot,
  MERGE_METHODS,
  onPrDraft,
  openUrl,
  sendToSession,
  threadLine,
  type GhStatus,
  type MergeMethod,
  type MergeMethods,
  type PrReview,
  type PrSummary,
  type ReviewThread,
} from "./lib/github";
import { highlight, loadLang, paint, ready, toSpans } from "./lib/highlight";
import { langFor } from "./lib/lang";
import { resolveDir } from "./lib/session";

/** How often a pending Copilot review is checked on, and for how long. */
export const POLL_MS = 30_000;
export const POLL_FOR_MS = 20 * 60_000;

export interface PullRequestViewProps {
  cwd?: string;
  pane?: string;
  /** Who runs in the session, for the buttons that hand it work. */
  agent?: string;
  active: boolean;
  /** A prompt went to the session; the stage should show it. */
  onSent?: () => void;
  /** A review Roer was waiting on has arrived. */
  onReviewLanded?: () => void;
}

/**
 * The pull request for the branch the staged session is on: open one if
 * there is none, ask Copilot to review it, read what came back, and hand the
 * threads worth fixing to the session's agent.
 */
export function PullRequestView({ cwd, pane, agent = "Claude", active, onSent, onReviewLanded }: PullRequestViewProps) {
  const [dir, setDir] = useState<string | null>(null);
  const [status, setStatus] = useState<GhStatus | null>(null);
  // `undefined` until asked; `null` once GitHub says the branch has none.
  const [pr, setPr] = useState<PrSummary | null | undefined>(undefined);
  const [review, setReview] = useState<PrReview | null>(null);
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [methods, setMethods] = useState<MergeMethods | null>(null);

  // Waiting on Copilot: from the moment it was asked (or found pending) until
  // it has submitted one more review than it had then.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const copilotBaseline = useRef(0);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    setLoading(true);
    setError(null);
    try {
      const at = await resolveDir(cwd, pane);
      if (!current()) return;
      setDir(at);
      const gh = await ghStatus(at);
      if (!current()) return;
      setStatus(gh);
      if (!gh.installed || !gh.authenticated || !gh.repo) return;

      const [found, names, on] = await Promise.all([ghPrForBranch(at), gitBranches(at), gitCurrentBranch(at)]);
      if (!current()) return;
      setPr(found);
      setBranches(names);
      setBranch(on);
      // A base picked earlier is kept only while it is still a branch here and
      // not the one the pull request would come from.
      setBase(
        (existing) =>
          (existing && existing !== on && names.includes(existing) ? existing : "") ||
          ["main", "master"].find((name) => names.includes(name) && name !== on) ||
          names.find((name) => name !== on) ||
          "",
      );
      const [fetched, allowed] = found
        ? await Promise.all([
            ghPrReview(at, found.number),
            // Not knowing the settings is no reason to hide merging: offer all
            // three and let GitHub refuse the one it does not allow.
            ghMergeMethods(at).catch(() => ({ merge: true, squash: true, rebase: true })),
          ])
        : [null, null];
      if (!current()) return;
      setReview(fetched);
      setMethods(allowed);
    } catch (cause) {
      if (current()) setError(String(cause));
    } finally {
      if (current()) setLoading(false);
    }
  }, [cwd, pane]);

  // Another session, or a `cd` in this one, is another pull request.
  useEffect(() => {
    generation.current += 1;
    setDir(null);
    setStatus(null);
    setPr(undefined);
    setReview(null);
    setSelected(new Set());
    setMethods(null);
    setWaitingSince(null);
    setDrafting(false);
  }, [cwd, pane]);

  // Coming back to the tab is a good moment to look again: a push from the
  // terminal may have made threads outdated, or a review may have landed.
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

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

  // A review that was already pending when the tab first saw it is waited on
  // too, not just one requested from here.
  useEffect(() => {
    if (waitingSince === null && copilotPending(review)) {
      copilotBaseline.current = copilotReviews(review);
      setWaitingSince(Date.now());
    }
  }, [review, waitingSince]);

  useEffect(() => {
    if (waitingSince === null || !review) return;
    if (copilotReviews(review) > copilotBaseline.current && !copilotPending(review)) {
      setWaitingSince(null);
      onReviewLanded?.();
    }
  }, [review, waitingSince, onReviewLanded]);

  useEffect(() => {
    if (waitingSince === null || !dir || !pr) return;
    // Clearing the timer does not stop a poll already in flight; this does.
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() - waitingSince > POLL_FOR_MS) {
        setWaitingSince(null);
        return;
      }
      void ghPrReview(dir, pr.number)
        .then((fresh) => {
          if (!stopped) setReview(fresh);
        })
        .catch(() => {
          /* A missed poll is retried on the next tick. */
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [waitingSince, dir, pr]);

  /** Runs an action; `current()` says whether the view is still about the
   * session it started on, which a job checks after each await. */
  const run = async (what: string, job: (current: () => boolean) => Promise<void>) => {
    const mine = generation.current;
    const current = () => mine === generation.current;
    setBusy(what);
    setError(null);
    try {
      await job(current);
    } catch (cause) {
      if (current()) setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const askForDraft = () =>
    run("draft", async (current) => {
      if (!pane) return;
      await sendToSession(pane, draftPrPrompt(pane, branch, base));
      if (!current()) return;
      setDrafting(true);
      onSent?.();
    });

  const create = () =>
    run("create", async (current) => {
      if (!dir) return;
      const made = await ghPrCreate(dir, { title: title.trim(), body, base, draft });
      if (!current()) return;
      setPr(made);
      const fetched = await ghPrReview(dir, made.number);
      if (current()) setReview(fetched);
    });

  const requestCopilot = () =>
    run("copilot", async (current) => {
      if (!dir || !pr) return;
      // Counted before asking, so a review that lands before the fetch below
      // is the one that was asked for, not the baseline to wait past. The
      // landing effect sees it on the very first fetch.
      copilotBaseline.current = copilotReviews(review);
      await ghRequestCopilotReview(dir, pr.number);
      const fresh = await ghPrReview(dir, pr.number);
      if (!current()) return;
      setReview(fresh);
      setWaitingSince(Date.now());
    });

  const merge = (method: MergeMethod) =>
    run("merge", async (current) => {
      if (!dir || !pr) return;
      const merged = await ghPrMerge(dir, pr.number, method, pr.headRefOid);
      if (current()) setPr(merged);
    });

  const refresh = () =>
    run("refresh", async () => {
      await load();
    });

  const threads = review?.threads ?? [];
  const open = useMemo(() => threads.filter((t) => !t.isResolved), [threads]);
  const picked = threads.filter((t) => selected.has(t.id));

  const fix = () =>
    run("fix", async () => {
      if (!pane || !pr || picked.length === 0) return;
      await sendToSession(pane, fixThreadsPrompt(pr, picked));
      setSelected(new Set());
      onSent?.();
    });

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const noPane = pane ? undefined : "Needs a live session to send the prompt to";

  if (!cwd && !pane) {
    return <div className="pr-view empty"><p className="muted">Pick a session to see its pull request.</p></div>;
  }

  if (status && (!status.installed || !status.authenticated || !status.repo)) {
    return (
      <div className="pr-view">
        <p className="error">{status.message ?? "This directory is not a GitHub repository."}</p>
        <button type="button" onClick={refresh}>Try again</button>
      </div>
    );
  }

  return (
    <div className="pr-view">
      {error ? <p className="error" role="alert">{error}</p> : null}

      {pr === undefined ? (
        <p className="muted">{loading ? "Looking for a pull request…" : ""}</p>
      ) : pr === null ? (
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
              className="primary"
              disabled={busy !== null || !base || !branch || !pane}
              title={noPane}
              onClick={askForDraft}
            >
              {drafting ? `Waiting for ${agent}…` : `Draft with ${agent}`}
            </button>
          </div>
          <input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            aria-label="Description"
            placeholder="Description (markdown)"
            rows={14}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="pr-actions">
            <label>
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
            </label>
            <button type="submit" className="primary" disabled={busy !== null || !title.trim() || !base || !branch}>
              {busy === "create" ? "Pushing and creating…" : "Push and create pull request"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="pr-head">
            <h2>
              <button type="button" className="link pr-title" onClick={() => void openUrl(pr.url)}>
                #{pr.number} {pr.title}
              </button>
            </h2>
            <span className={`pr-state ${pr.state.toLowerCase()}`}>{pr.isDraft ? "DRAFT" : pr.state}</span>
            <span className="muted">
              <code>{pr.headRefName}</code> → <code>{pr.baseRefName}</code>
            </span>
            <span className="pr-spacer" />
            <button type="button" onClick={refresh} disabled={busy !== null || loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="primary"
              onClick={requestCopilot}
              disabled={busy !== null || waitingSince !== null || pr.state !== "OPEN"}
            >
              {waitingSince !== null ? "Copilot is reviewing…" : "Request Copilot review"}
            </button>
          </div>

          <Reviews review={review} />

          <div className="pr-threads-head">
            <h3>
              Review comments <span className="muted">{open.length} unresolved of {threads.length}</span>
            </h3>
            <span className="pr-spacer" />
            <button
              type="button"
              className="link"
              disabled={open.length === 0}
              onClick={() => setSelected(new Set(open.map((t) => t.id)))}
            >
              Select all unresolved
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy !== null || picked.length === 0 || !pane}
              title={noPane}
              onClick={fix}
            >
              Fix with {agent} ({picked.length})
            </button>
          </div>

          {review?.truncated ? (
            <p className="notice">
              This pull request has more review comments than Roer loads at once; some are not shown here or picked by
              “Select all unresolved”.{" "}
              <button type="button" className="link" onClick={() => void openUrl(pr.url)}>
                See all on GitHub
              </button>
            </p>
          ) : null}

          {threads.length === 0 ? (
            <p className="muted">No review comments yet.</p>
          ) : (
            groupByPath(threads).map(([path, group]) => (
              <section key={path} className="pr-file">
                <h4>
                  <code>{path}</code>
                </h4>
                {group.map((thread) => (
                  <Thread
                    key={thread.id}
                    thread={thread}
                    selected={selected.has(thread.id)}
                    onToggle={() => toggle(thread.id)}
                  />
                ))}
              </section>
            ))
          )}

          <MergeBox pr={pr} methods={methods} busy={busy} onMerge={merge} />
        </>
      )}
    </div>
  );
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
 * it. Two steps — pick and press, then confirm — since it cannot be undone
 * from here.
 */
function MergeBox({
  pr,
  methods,
  busy,
  onMerge,
}: {
  pr: PrSummary;
  methods: MergeMethods | null;
  busy: string | null;
  onMerge: (method: MergeMethod) => Promise<void>;
}) {
  const allowed = MERGE_METHODS.filter((m) => methods?.[m.method]);
  const [picked, setPicked] = useState<MergeMethod | null>(rememberedMethod);
  const [confirming, setConfirming] = useState(false);
  // What was picked, if the repository still allows it; else its first.
  const method = allowed.find((m) => m.method === picked)?.method ?? allowed[0]?.method;
  const label = MERGE_METHODS.find((m) => m.method === method)?.label ?? "Merge";

  if (pr.state === "MERGED") {
    return (
      <section className="pr-merge">
        <p className="notice">
          Merged into <code>{pr.baseRefName}</code>.
        </p>
      </section>
    );
  }
  if (pr.state !== "OPEN" || !methods) return null;

  const blocked = pr.isDraft
    ? "A draft pull request cannot be merged; mark it ready for review on GitHub first."
    : allowed.length === 0
      ? "This repository allows no merge method."
      : null;

  return (
    <section className="pr-merge">
      <h3>Merge</h3>
      {blocked ? <p className="muted">{blocked}</p> : null}
      {confirming && method ? (
        <div className="pr-merge-row" role="group" aria-label="Confirm merge">
          <span>
            {label} <strong>#{pr.number}</strong> into <code>{pr.baseRefName}</code>? This closes the pull request.
          </span>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => {
              rememberMethod(method);
              void onMerge(method).finally(() => setConfirming(false));
            }}
          >
            {busy === "merge" ? "Merging…" : `Confirm ${label.toLowerCase()}`}
          </button>
          <button type="button" disabled={busy === "merge"} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="pr-split">
          <button
            type="button"
            className="primary"
            disabled={Boolean(blocked) || busy !== null || !method}
            onClick={() => setConfirming(true)}
          >
            {label}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="primary pr-split-arrow"
                aria-label="Choose merge method"
                disabled={Boolean(blocked) || busy !== null || allowed.length < 2}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="pr-merge-menu">
              <DropdownMenuRadioGroup value={method} onValueChange={(next) => setPicked(next as MergeMethod)}>
                {allowed.map((m) => (
                  <DropdownMenuRadioItem key={m.method} value={m.method}>
                    <span className="pr-merge-option">
                      <strong>{m.label}</strong>
                      <span className="muted">{m.description}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </section>
  );
}

/** How many reviews Copilot has submitted, to tell a new one from the last. */
function copilotReviews(review: PrReview | null): number {
  return review?.reviews.filter((one) => isCopilot(one.author)).length ?? 0;
}

function groupByPath(threads: readonly ReviewThread[]): [string, ReviewThread[]][] {
  const groups = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    groups.set(thread.path, [...(groups.get(thread.path) ?? []), thread]);
  }
  return [...groups];
}

function Reviews({ review }: { review: PrReview | null }) {
  // A bare COMMENTED review with no body is just the envelope around inline
  // comments, which are shown below; it says nothing on its own.
  const worth = (review?.reviews ?? []).filter((r) => r.body.trim() || r.state !== "COMMENTED");
  if (worth.length === 0) return null;
  return (
    <section className="pr-reviews">
      <h3>Reviews</h3>
      {worth.map((r, i) => (
        <details key={`${r.url}-${i}`} className="pr-review" open={i === worth.length - 1}>
          <summary>
            <strong>{r.author}</strong> <span className={`pr-verdict ${r.state.toLowerCase()}`}>{verdict(r.state)}</span>
          </summary>
          {r.body.trim() ? <Markdown>{r.body}</Markdown> : null}
        </details>
      ))}
    </section>
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

function Thread({ thread, selected, onToggle }: { thread: ReviewThread; selected: boolean; onToggle: () => void }) {
  const line = threadLine(thread);
  const settled = thread.isResolved || thread.isOutdated;
  return (
    <details className={settled ? "pr-thread settled" : "pr-thread"} open={!settled}>
      <summary>
        {thread.isResolved ? null : (
          <input
            type="checkbox"
            aria-label={`Select ${thread.path}${line === null ? "" : `:${line}`}`}
            checked={selected}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        <span className="pr-where">{line === null ? "file" : `line ${line}`}</span>
        {thread.isResolved ? <span className="pr-tag">resolved</span> : null}
        {thread.isOutdated ? <span className="pr-tag">outdated</span> : null}
        <span className="muted pr-first">{firstLine(thread.comments[0]?.body ?? "")}</span>
      </summary>
      <Hunk text={thread.comments[0]?.diffHunk ?? ""} path={thread.path} />
      {thread.comments.map((comment) => (
        <div key={comment.url} className="pr-comment">
          <div className="pr-comment-head">
            <strong>{comment.author}</strong>
            <button type="button" className="link" onClick={() => void openUrl(comment.url)}>
              view on GitHub
            </button>
          </div>
          <Markdown>{comment.body}</Markdown>
        </div>
      ))}
    </details>
  );
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** GitHub's hunk runs from the hunk header to the line commented on; the
 * last few lines are the context a reader needs. */
const HUNK_LINES = 8;

/**
 * The code a thread is about, coloured the way the Changes tab colours a
 * diff: the grammar for the file's language once it has loaded, `paint`
 * until then. The whole hunk goes to the grammar, not just the lines shown,
 * so a string or comment opened above the cut still reads as one.
 */
function Hunk({ text, path }: { text: string; path: string }) {
  const hunk = useMemo(() => (text ? parseDiff(text).hunks[0] : undefined), [text]);
  const lang = useMemo(() => langFor(path), [path]);

  const [grammars, setGrammars] = useState(0);
  useEffect(() => {
    if (!lang || ready(lang)) return;
    let live = true;
    void loadLang(lang).then(() => {
      if (live) setGrammars((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [lang]);

  const coloured = useMemo(
    () => (hunk && lang && ready(lang) ? highlight([hunk], lang) : null),
    // `grammars` is how a grammar arriving asks for this to be worked out again.
    [hunk, lang, grammars],
  );

  if (!hunk) return null;
  return (
    <pre className="pr-hunk">
      {hunk.lines.slice(-HUNK_LINES).map((line, i) => {
        const tokens = coloured?.[line.kind === "del" ? "old" : "new"].get(line);
        return (
          <div key={i} className={line.kind === "context" ? undefined : line.kind}>
            <span className="pr-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
            <Spans spans={tokens ? toSpans(tokens) : paint(line.text)} />
          </div>
        );
      })}
    </pre>
  );
}

/** Review text is markdown; a link in it must open in the browser, not
 * navigate the app's own window away. */
function Markdown({ children }: { children: string }) {
  return (
    <div className="file-markdown pr-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: text }: { href?: string; children?: ReactNode }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void openUrl(href);
              }}
            >
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
