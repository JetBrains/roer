import { gitCurrentBranch, gitRoot, resolveDir, sendToSession, type AgentSession, type Session } from "roer";

import { canAsk, forCheckout, holds, type ReviewRoles } from "./local";

/** Where the decisions on a review can go: a live session with an agent in it. Never a new one: the review is
 * between the sessions there are. */
export interface Target {
  pane: string;
  agent: string;
  role: "here" | "asker" | "reviewer";
}

/** An agent as the person knows it: "claude" is Claude. */
export const agentTitle = (agent: string | null | undefined): string =>
  agent ? agent[0].toUpperCase() + agent.slice(1) : "the agent";

/**
 * Every place the decisions can go, the default first: the session that asked
 * for the review, whose work it is; this session; the one that wrote the
 * comments. A session is offered once, under the first of these it is, and
 * a role only while the session that had it is still live in its pane.
 */
export function sendTargets(
  roles: ReviewRoles,
  session: Session | null,
  sessions: readonly AgentSession[],
): Target[] {
  const targets: Target[] = [];
  // Only while the same session is still in its pane: a later one with the pane's id is someone else.
  const asker = holds(roles.asker, sessions) ? roles.asker?.pane : undefined;
  const reviewer = holds(roles.reviewer, sessions) ? roles.reviewer?.pane : undefined;
  const add = (pane: string | undefined, role: "here" | "asker" | "reviewer") => {
    if (!pane || targets.some((one) => one.pane === pane)) return;
    if (pane === session?.pane) {
      if (canAsk(session)) targets.push({ pane, agent: session.agent ?? "", role: pane === asker ? "asker" : role });
      return;
    }
    const live = sessions.find((one) => one.pane === pane);
    if (live) targets.push({ pane, agent: live.agent, role });
  };
  add(asker, "asker");
  add(session?.pane, "here");
  add(reviewer, "reviewer");
  return targets;
}

/** The target in a sentence: "this session, with Claude". */
export function targetName(target: Target, stagePane: string | undefined): string {
  const who = agentTitle(target.agent);
  if (target.pane === stagePane) return `this session, with ${who}`;
  return target.role === "asker" ? `the session that asked for the review, with ${who}` : `the session that reviewed it, with ${who}`;
}

/** The target on the send button, short: the agent itself when it is on the stage, else its role. */
export function targetLabel(target: Target, stagePane: string | undefined): string {
  if (target.pane === stagePane) return agentTitle(target.agent);
  return target.role === "asker" ? "the asking session" : "the reviewer";
}

/** The repository and branch checked out in `dir`, as far as git can say. */
async function checkoutOf(dir: string): Promise<{ root: string | null; branch: string | null }> {
  const root = dir ? await gitRoot(dir).catch(() => null) : null;
  const branch = root ? (await gitCurrentBranch(root).catch(() => "")) || null : null;
  return { root, branch };
}

/**
 * Hands `prompt`, about `branch` of the repository at `root`, to `target`,
 * told which those are wherever its checkout is another: the session that
 * asked, or the reviewer, may have switched branch or repository since.
 */
export async function deliver(
  target: Target,
  prompt: string,
  {
    session,
    root,
    branch,
  }: { session: Session | null; root: string; branch: string | null },
): Promise<void> {
  const reviewed = { root, branch };
  const onStage = target.pane === session?.pane;
  const there = await checkoutOf(await resolveDir(onStage ? session.cwd : undefined, target.pane));
  const text = forCheckout(prompt, reviewed, there);
  // The stage's own goes through its session, which knows when only a shell is left in it.
  if (onStage) await session.send(text);
  else await sendToSession(target.pane, text);
}
