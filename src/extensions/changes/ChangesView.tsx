import { useEffect, useState } from "react";
import {
  baseName,
  buildTree,
  fileOrder,
  gitBranches,
  gitCurrentBranch,
  gitRoot,
  resolveDir,
  useActivateTab,
  useSessions,
  useShowSession,
  useStartSession,
  type FileChange,
  type Session,
} from "roer";
import { Button, EmptyState } from "roer/ui";

import { DiffBrowserView } from "./DiffBrowserView";
import { acceptRest, canAsk, localReviewPrompt, ready, storedBase, undecided, holderOf, updateRoles, useBranchComments, useReviewRoles } from "./local";
import { SendComments } from "./SendComments";
import { ReviewView } from "./ReviewView";
import { agentTitle, deliver, sendTargets, targetName, type Target } from "./targets";

/** What the tab shows: the branch, all of it and then step by step, or its pull request. */
export type Scope = "branch" | "pr";

const SCOPES: { scope: Scope; label: string; title: string }[] = [
  {
    scope: "branch",
    label: "Branch",
    title: "Everything since the branch left its base, then what is not committed and each commit on its own",
  },
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

/**
 * The branch's work in one tab, at whichever stage it is: the whole branch,
 * then its uncommitted edits and commits stepped through one at a time, all
 * taking comments on their lines; or the pull request with its review
 * threads, from opening it to merging it. Each view stays mounted while the
 * other is shown, so coming back finds it where it was. Comments left on any
 * step are one list, sent with one button.
 *
 * All three show one branch, picked in the bar above them: the one checked
 * out in the session until another is picked, and again after a session
 * switch. Another branch is its commits alone; what is not committed is the
 * checked-out one's.
 */
export function ChangesView({ session, active, onSent, onOpenCount }: ChangesViewProps) {
  const [scope, setScope] = useState<Scope>("branch");
  const [where, setWhere] = useState<{ root: string; branch: string | null; branches: string[] } | null>(null);
  /** Picked by hand; null follows the branch checked out in the session. */
  const [picked, setPicked] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /** Where Branch puts its own controls, so the tab has one bar rather than two. */
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
  // Looked up again when the session's repository changes (a `cd` into another one) and when the tab comes up,
  // so comments are never kept or sent under the repository it was in before.
  const sessionRoot = session?.root;
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
  }, [cwd, pane, sessionBranch, sessionRoot, active]);

  // Another session, or another repository, starts again from its own branch.
  const root = where?.root;
  useEffect(() => setPicked(null), [cwd, pane, root]);

  const agent = agentTitle(session?.agent);
  const startSession = useStartSession();
  const sessions = useSessions();
  const showSession = useShowSession();
  const activateTab = useActivateTab();
  const roles = useReviewRoles(where?.root ?? null, branch, sessions);
  const targets = sendTargets(roles, session, sessions);

  // The first comment still to decide, shown on the Branch view: on the branch as a whole before those on a commit,
  // and in the order its tree lists the files, top line first.
  const [showComment, setShowComment] = useState<{ id: string; seq: number } | undefined>(undefined);
  const showOpen = () => {
    const open = undecided(comments);
    // Only the paths matter to the order, so only they are given.
    const order = fileOrder(buildTree(open.map((c) => ({ path: c.path }) as FileChange))).map((file) => file.path);
    const [first] = open.sort(
      (a, b) => Number(!!a.commit) - Number(!!b.commit) || order.indexOf(a.path) - order.indexOf(b.path) || a.line - b.line,
    );
    if (!first) return;
    setScope("branch");
    setShowComment((last) => ({ id: first.id, seq: (last?.seq ?? 0) + 1 }));
  };

  const send = async (target: Target) => {
    const sent = ready(comments);
    if (!where || sent.length === 0) return;
    setSending(true);
    setSaid(null);
    try {
      const prompt = localReviewPrompt(storedBase(where.root, branch) ?? "", sent);
      await deliver(target, prompt, { session, root: where.root, branch });
      // Sent comments are done with: the agent is about to move the lines they sat on.
      update((current) => current.filter((c) => !sent.some((one) => one.id === c.id)));
      setSaid(`Sent ${sent.length} ${sent.length === 1 ? "comment" : "comments"} to ${targetName(target, session?.pane)}.`);
      // Where it went comes up, so the agent can be seen taking them on.
      if (target.pane !== session?.pane) showSession?.(target.pane);
      onSent?.();
    } catch (cause) {
      setSaid(String(cause));
    } finally {
      setSending(false);
    }
  };

  // Nothing to show changes of: the sessions there are to open instead, rather than a view that looks for a
  // repository in no folder and says what git said about that.
  if (!session) {
    return (
      <div className="changes-view">
        <EmptyState
          text="No session on screen"
          detail="Changes shows the branch of the session on screen: its edits, its commits and its pull request."
          footer={
            <div className="changes-pick">
              {sessions.slice(0, 5).map((one) => (
                <Button key={one.pane} onClick={() => showSession?.(one.pane)} disabled={!showSession}>
                  {agentTitle(one.agent)} in {baseName(one.cwd) || one.cwd}
                </Button>
              ))}
              <Button variant="borderless" onClick={() => activateTab("sessions")}>
                {sessions.length > 0 ? "Pick another in Workspace" : "Pick one in Workspace"}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

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
        <select
          className="changes-branch"
          aria-label="Branch"
          title="The branch every view shows"
          value={branch ?? ""}
          disabled={!where}
          onChange={(e) => setPicked(e.target.value === "" || e.target.value === checkedOut ? null : e.target.value)}
        >
          {branch && !where?.branches.includes(branch) ? <option value={branch}>{branch}</option> : null}
          {/* The checked-out one first, under its own heading: the open list says which it is, the closed picker
              stays as short as the name. A detached HEAD is offered as itself, so every view shows the same. */}
          {where && !checkedOut ? (
            <optgroup label="Checked out here">
              <option value="">HEAD (detached)</option>
            </optgroup>
          ) : checkedOut && where?.branches.includes(checkedOut) ? (
            <optgroup label="Checked out here">
              <option value={checkedOut}>{checkedOut}</option>
            </optgroup>
          ) : null}
          <optgroup label="Branches">
            {where?.branches
              .filter((name) => name !== checkedOut)
              .map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </optgroup>
        </select>
        {elsewhere ? (
          <span className="muted changes-said" title="Its commits only: what is not committed belongs to the branch checked out">
            not checked out
          </span>
        ) : null}
        <div className="changes-slot" ref={setSlot} hidden={scope !== "branch"} />
        {said ? <span className="muted changes-said">{said}</span> : null}
        {scope !== "branch" ? <span className="review-spacer" /> : null}
        {/* Only once there is something to send or decide on; the agent's name is in the accessible names. */}
        {scope !== "pr" ? (
          <SendComments
            comments={comments}
            targets={targets}
            stagePane={session?.pane}
            disabled={sending}
            onSend={(target) => void send(target)}
            onAcceptRest={() => update(acceptRest)}
            onShowOpen={showOpen}
          />
        ) : null}
      </div>
      <div className="changes-scope" hidden={scope !== "branch"}>
        <DiffBrowserView
          // Another repository or branch is another history: started over, rather than leaving the old one's
          // commits on screen (and taking comments on them) until the new one's arrive.
          key={`${root ?? ""}\0${branch ?? ""}`}
          toolbar={slot}
          branch={branch ?? (where ? "HEAD" : undefined)}
          cwd={session?.cwd}
          pane={session?.pane}
          active={active && scope === "branch"}
          changed={session?.changed}
          comments={comments}
          onComments={where ? update : undefined}
          agent={agent}
          send={session && canAsk(session) ? session.send : undefined}
          startSession={startSession}
          showComment={showComment}
          onReviewAsked={(by) => {
            if (!where) return;
            // The session that asked keeps the decisions: its own work, reviewed by itself or by a new session.
            const asker = canAsk(session) ? holderOf(session?.pane, sessions) : undefined;
            updateRoles(where.root, branch, () => (by === "here" ? { asker, reviewer: asker } : { asker }));
          }}
          onSent={onSent}
          onCommitted={(short) => setSaid(`Committed ${short}.`)}
        />
      </div>
      <div className="changes-scope" hidden={scope !== "pr"}>
        <ReviewView
          // Started over for the same reason: the old branch's diff and comments must not stay answerable under
          // the new one's name.
          key={`${root ?? ""}\0${branch ?? ""}`}
          session={session}
          branch={elsewhere}
          active={active && scope === "pr"}
          scope="pr"
          // Its own comments are the branch's: asking for them shows the branch.
          onScope={(next) => setScope(next === "pr" ? "pr" : "branch")}
          onSent={onSent}
          onOpenCount={onOpenCount}
        />
      </div>
    </div>
  );
}
