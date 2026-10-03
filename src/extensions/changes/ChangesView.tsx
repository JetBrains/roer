import { useEffect, useState } from "react";
import { gitCurrentBranch, gitRoot, resolveDir, type Session } from "roer";
import { Button } from "roer/ui";

import { DiffBrowserView } from "./DiffBrowserView";
import { localReviewPrompt, ready, storedBase, useBranchComments } from "./local";
import { ReviewView } from "./ReviewView";

/** What the tab shows: the edits and commits one at a time, the whole branch at once, or its pull request. */
export type Scope = "commits" | "local" | "pr";

const SCOPES: { scope: Scope; label: string; title: string }[] = [
  { scope: "commits", label: "By commit", title: "What is not committed, then each of the branch's commits" },
  { scope: "local", label: "Whole branch", title: "Everything since the branch left its base, to comment on and send to the agent" },
  { scope: "pr", label: "Pull request", title: "The pull request as GitHub has it, with its review threads" },
];

export interface ChangesViewProps {
  session: Session | null;
  active: boolean;
  /** A prompt went to the session; show it. */
  onSent?: () => void;
  /** Asks for the Pull Request tab, which is where one is opened. */
  onOpenPullRequest?: () => void;
  /** How many comments still wait on a decision. */
  onOpenCount?: (count: number) => void;
}

function agentName(session: Session | null): string {
  const agent = session?.agent;
  return agent ? agent[0].toUpperCase() + agent.slice(1) : "the agent";
}

/**
 * The branch's work in one tab, at whichever stage it is: uncommitted edits and
 * commits stepped through one at a time, the whole branch with comments on its
 * lines, or the pull request with its review threads. Each view stays mounted
 * while another is shown, so coming back finds it where it was. Comments left
 * by commit and on the whole branch are one list, sent with one button.
 */
export function ChangesView({ session, active, onSent, onOpenPullRequest, onOpenCount }: ChangesViewProps) {
  const [scope, setScope] = useState<Scope>("commits");
  const [where, setWhere] = useState<{ root: string; branch: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [comments, update] = useBranchComments(where?.root ?? null, where?.branch ?? null);

  // The repository and branch the comments are kept under, the same key the review view and the agent's tool use.
  const cwd = session?.cwd;
  const pane = session?.pane;
  const branch = session?.branch;
  useEffect(() => {
    let gone = false;
    void resolveDir(cwd, pane)
      .then(async (dir) => {
        const root = await gitRoot(dir);
        const onBranch = root ? await gitCurrentBranch(root).catch(() => null) : null;
        if (!gone) setWhere(root ? { root, branch: onBranch || null } : null);
      })
      .catch(() => !gone && setWhere(null));
    return () => {
      gone = true;
    };
  }, [cwd, pane, branch]);

  const agent = agentName(session);
  const toSend = ready(comments);

  const send = async () => {
    if (!session || !where || toSend.length === 0) return;
    setSending(true);
    setSaid(null);
    try {
      const sent = toSend;
      await session.send(localReviewPrompt(storedBase(where.root, where.branch) ?? "", sent));
      // Sent comments are done with: the agent is about to move the lines they sat on.
      update((current) => current.filter((c) => !sent.some((one) => one.id === c.id)));
      setSaid(`Sent ${sent.length} ${sent.length === 1 ? "comment" : "comments"} to ${agent}.`);
      onSent?.();
    } catch (cause) {
      setSaid(String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="changes-view">
      <div className="changes-scopes">
        <div className="seg" role="group" aria-label="What to show">
          {SCOPES.map((one) => (
            <button
              key={one.scope}
              type="button"
              className={scope === one.scope ? "on" : undefined}
              aria-pressed={scope === one.scope}
              title={one.title}
              onClick={() => setScope(one.scope)}
            >
              {one.label}
            </button>
          ))}
        </div>
        {said ? <span className="muted changes-said">{said}</span> : null}
        <span className="review-spacer" />
        {scope !== "pr" ? (
          <Button variant="primary" onClick={() => void send()} disabled={sending || toSend.length === 0 || !session?.pane}>
            Send {toSend.length} to {agent}
          </Button>
        ) : null}
      </div>
      <div className="changes-scope" hidden={scope !== "commits"}>
        <DiffBrowserView
          cwd={session?.cwd}
          pane={session?.pane}
          active={active && scope === "commits"}
          changed={session?.changed}
          comments={comments}
          onComments={where ? update : undefined}
          agent={agent}
        />
      </div>
      <div className="changes-scope" hidden={scope === "commits"}>
        <ReviewView
          session={session}
          active={active && scope !== "commits"}
          scope={scope === "pr" ? "pr" : "local"}
          onScope={setScope}
          onSent={onSent}
          onOpenPullRequest={onOpenPullRequest}
          onOpenCount={onOpenCount}
        />
      </div>
    </div>
  );
}
