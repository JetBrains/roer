/**
 * Threads outlive nothing they are about. A thread whose worktree is gone (removed when its task was done), or one
 * left on a branch that no longer exists, can never be drawn again: it is marked gone, leaves Needs you, and is
 * deleted once it has stayed gone for `GONE_FOR`. The wait is for a disk that is only unplugged, or a worktree that
 * comes back under the same path; one found again is unmarked.
 */
import { useEffect } from "react";

import { gitBranches, gitRoot } from "./git";
import { allThreads, updateThreads, type Thread } from "./threads";

export const GONE_FOR = 7 * 24 * 60 * 60 * 1000;

export interface Probe {
  /** The repository at `dir`, or null when there is none. */
  root: (dir: string) => Promise<string | null>;
  /** The local branches of the repository at `dir`. */
  branches: (dir: string) => Promise<string[]>;
}

const git: Probe = { root: gitRoot, branches: gitBranches };

/** Looks for every thread's place, marks the ones gone and deletes those gone for long enough. Says how many it deleted. */
export async function sweepThreads(now = Date.now(), probe: Probe = git): Promise<number> {
  const threads = allThreads();
  const roots = [...new Set(threads.map((thread) => thread.root))];
  const there = new Map<string, boolean>();
  const branches = new Map<string, Set<string> | null>();
  await Promise.all(
    roots.map(async (root) => {
      const found = await probe.root(root).catch(() => undefined);
      // Asked and not there; an error says nothing either way.
      there.set(root, found !== null);
      const wanted = threads.some((thread) => thread.root === root && branchesOf(thread).length > 0);
      if (found && wanted) branches.set(root, await probe.branches(root).then((names) => new Set(names), () => null));
    }),
  );
  const gone = (thread: Thread) => {
    if (!there.get(thread.root)) return true;
    const known = branches.get(thread.root);
    return !!known && branchesOf(thread).some((branch) => !known.has(branch));
  };
  const looked = new Set(threads.map((thread) => thread.id));
  const step = (current: Thread[]) => {
    let changed = false;
    let deleted = 0;
    const list = current.flatMap((thread): Thread[] => {
      // Started while the sweep was looking: next time.
      if (!looked.has(thread.id)) return [thread];
      if (!gone(thread)) {
        if (thread.goneSince === undefined) return [thread];
        changed = true;
        const { goneSince: _, ...back } = thread;
        return [back];
      }
      if (thread.goneSince === undefined) {
        changed = true;
        return [{ ...thread, goneSince: now }];
      }
      if (now - thread.goneSince < GONE_FOR) return [thread];
      changed = true;
      deleted += 1;
      return [];
    });
    return { list, changed, deleted };
  };
  // Written only when something changed, so a sweep that finds everything in place wakes no window.
  if (!step(allThreads()).changed) return 0;
  let deleted = 0;
  updateThreads((current) => {
    const done = step(current);
    deleted = done.deleted;
    return done.list;
  });
  return deleted;
}

/** The branches a thread's lines were read from, for one left in a tab showing a branch from git. */
function branchesOf(thread: Thread): string[] {
  return thread.anchors.flatMap((a) => (a.kind === "line" && a.branch ? [a.branch] : []));
}

/** How often a window sweeps: soon after it opens, then every hour. */
const FIRST_SWEEP = 15_000;
const SWEEP_EVERY = 60 * 60 * 1000;

/** Sweeps the threads while comments are on; switched off, they are left exactly as they are. */
export function useThreadSweep(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const sweep = () => void sweepThreads().catch(() => undefined);
    const first = window.setTimeout(sweep, FIRST_SWEEP);
    const every = window.setInterval(sweep, SWEEP_EVERY);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [on]);
}
