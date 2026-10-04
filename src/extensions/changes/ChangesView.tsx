import { useEffect, useState } from "react";
import { gitBranches, gitCurrentBranch, gitRoot, resolveDir, type Session } from "roer";
import { Button } from "roer/ui";

import { DiffBrowserView } from "./DiffBrowserView";
import { localReviewPrompt, onBranch, ready, storedBase, useBranchComments } from "./local";
import { ReviewView } from "./ReviewView";

/** What the tab shows: the edits and commits one at a time, the whole branch at once, or its pull request. */
export type Scope = "commits" | "local" | "pr";

const SCOPES: { scope: Scope; label: string; title: string }[] = [
  { scope: "commits", label: "By commit", title: "What is not committed, then each of the branch's commits" },
  { scope: "local", label: "Whole branch", title: "Everything since the branch left its base, to comment on and send to the agent" },
  { scope: "pr", label: "Pull request", title: "The pull request as GitHub has it, with its review threads, or the form that opens one" },
];

export interface ChangesViewProps {
  session: Session | null;
  active: boolean;
  /** A prompt went to the session; show it. */
  onSent?: () => void;
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
 * lines, or the pull request with its review threads, from opening it to
 * merging it. Each view stays mounted while another is shown, so coming back
 * finds it where it was. Comments left by commit and on the whole branch are
 * one list, sent with one button.
 *
 * All three show one branch, picked in the bar above them: the one checked
 * out in the session until another is picked, and again after a session
 * switch. Another branch is its commits alone; what is not committed is the
 * checked-out one's.
 */
export function ChangesView({ session, active, onSent, onOpenCount }: ChangesViewProps) {
  const [scope, setScope] = useState<Scope>("commits");
  const [where, setWhere] = useState<{ root: string; branch: string | null; branches: string[] } | null>(null);
  /** Picked by hand; null follows the branch checked out in the session. */
  const [picked, setPicked] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /** Where By commit puts its own controls, so the tab has one bar rather than two. */
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const checkedOut = where?.branch ?? null;
  const branch = picked ?? checkedOut;
  // The branch picked when it is not the checked-out one: the views read it from git rather than the worktree.
  const elsewhere = picked !== null && picked !== checkedOut ? picked : undefined;
  const [comments, update] = useBranchComments(where?.root ?? null, branch);

  // The repository and branch the comments are kept under, the same key the review view and the agent's tool use.
  const cwd = session?.cwd;
  const pane = session?.pane;
  const sessionBranch = session?.branch;
  useEffect(() => {
    let gone = false;
    void resolveDir(cwd, pane)
      .then(async (dir) => {
        const root = await gitRoot(dir);
        if (!root) return !gone && setWhere(null);
        const [current, branches] = await Promise.all([
          gitCurrentBranch(root).catch(() => null),
          gitBranches(root).catch(() => [] as string[]),
        ]);
        if (!gone) setWhere({ root, branch: current || null, branches });
      })
      .catch(() => !gone && setWhere(null));
    return () => {
      gone = true;
    };
  }, [cwd, pane, sessionBranch]);

  // Another session starts again from its own branch.
  useEffect(() => setPicked(null), [cwd, pane]);

  const agent = agentName(session);
  const toSend = ready(comments);

  const send = async () => {
    if (!session || !where || toSend.length === 0) return;
    setSending(true);
    setSaid(null);
    try {
      const sent = toSend;
      await session.send(onBranch(localReviewPrompt(storedBase(where.root, branch) ?? "", sent), elsewhere));
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
        <label className="changes-branch">
          Branch
          <select
            value={branch ?? ""}
            disabled={!where}
            onChange={(e) => setPicked(e.target.value === checkedOut ? null : e.target.value)}
          >
            {branch && !where?.branches.includes(branch) ? <option value={branch}>{branch}</option> : null}
            {where?.branches.map((name) => (
              <option key={name} value={name}>
                {name === checkedOut ? `${name} (checked out)` : name}
              </option>
            ))}
          </select>
        </label>
        {elsewhere ? (
          <span className="muted changes-said" title="Its commits only: what is not committed belongs to the branch checked out">
            not checked out
          </span>
        ) : null}
        <div className="changes-slot" ref={setSlot} hidden={scope !== "commits"} />
        {said ? <span className="muted changes-said">{said}</span> : null}
        {scope !== "commits" ? <span className="review-spacer" /> : null}
        {/* Only once there is something to send; the agent's name is in its accessible name. */}
        {scope !== "pr" && toSend.length > 0 ? (
          <Button
            variant="primary"
            aria-label={`Send ${toSend.length} to ${agent}`}
            onClick={() => void send()}
            disabled={sending || !session?.pane}
          >
            Send {toSend.length}
          </Button>
        ) : null}
      </div>
      <div className="changes-scope" hidden={scope !== "commits"}>
        <DiffBrowserView
          toolbar={slot}
          branch={branch ?? undefined}
          cwd={session?.cwd}
          pane={session?.pane}
          active={active && scope === "commits"}
          changed={session?.changed}
          comments={comments}
          onComments={where ? update : undefined}
          agent={agent}
          send={session?.pane ? session.send : undefined}
          onSent={onSent}
          onCommitted={(short) => setSaid(`Committed ${short}.`)}
        />
      </div>
      <div className="changes-scope" hidden={scope === "commits"}>
        <ReviewView
          session={session}
          branch={elsewhere}
          active={active && scope !== "commits"}
          scope={scope === "pr" ? "pr" : "local"}
          onScope={setScope}
          onSent={onSent}
          onOpenCount={onOpenCount}
        />
      </div>
    </div>
  );
}
