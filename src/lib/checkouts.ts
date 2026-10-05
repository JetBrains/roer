/**
 * A Project's checkouts — its main one and each worktree — and what is in
 * them, for the two lists that group sessions that way: the sidebar's tree
 * and the Workspace tab.
 */
import type { Repo } from "./git";
import type { Project } from "./projects";
import type { Worktree } from "./worktrees";

/** One checkout and what was or is being done in it. */
export interface TreeCheckout<T> {
  worktree: Worktree;
  items: T[];
}

export interface TreeProject<T> {
  project: Project;
  checkouts: TreeCheckout<T>[];
}

/** Whether `cwd` is `path` or somewhere under it. */
const within = (cwd: string, path: string) => cwd === path || cwd.startsWith(`${path.replace(/\/+$/, "")}/`);

/** A checkout git has not described, only named: the main one first. */
const bareCheckout = (path: string, main: boolean): Worktree => ({
  path,
  branch: null,
  commit: "",
  main,
  base: null,
  locked: false,
  missing: false,
});

/** A Project's checkouts: git's own list of its worktrees when that has been
 * read, else the worktree paths its repository was found with, else just
 * its folder, which is all a Project outside a repository has. One whose
 * folder is not there is left out: nothing can be started in it.
 *
 * Two Projects can be checkouts of one repository, both registered. Each
 * then keeps to its own: a Project that is a linked worktree has only that
 * checkout, and the main one leaves out any checkout another Project in
 * view stands for. */
export function checkoutsOf(
  project: Project,
  others: ReadonlySet<string>,
  worktrees: Record<string, Worktree[]>,
  repos: Record<string, Repo>,
): Worktree[] {
  const listed = (worktrees[project.path] ?? []).filter((worktree) => !worktree.missing);
  const repo = repos[project.path];
  const all =
    listed.length > 0
      ? listed
      : repo && repo.worktrees.length > 0
        ? repo.worktrees.map((path, index) => bareCheckout(path, index === 0))
        : [bareCheckout(project.path, true)];
  const own = all.find((worktree) => worktree.path === project.path);
  if (own && !own.main) return [own];
  return all.filter((worktree) => !others.has(worktree.path));
}

/**
 * Sorts what has a directory — live sessions, past conversations — into the
 * checkouts of the Projects in view: each goes to the checkout whose folder
 * holds it most closely, so one in a worktree is under that worktree and not
 * under the main checkout a parent folder up. What no checkout holds — an
 * assigned session, or one the first Workspace takes in from nowhere in
 * particular — is `elsewhere`. `order` puts each list in the order it is
 * shown in.
 */
export function buildTree<T>(
  projects: Project[],
  worktrees: Record<string, Worktree[]>,
  repos: Record<string, Repo>,
  items: T[],
  cwdOf: (item: T) => string,
  order: (list: T[]) => T[],
): { projects: TreeProject<T>[]; elsewhere: T[] } {
  const tree: TreeProject<T>[] = projects.map((project) => {
    const others = new Set(projects.filter((other) => other !== project).map((other) => other.path));
    return {
      project,
      checkouts: checkoutsOf(project, others, worktrees, repos).map((worktree) => ({ worktree, items: [] })),
    };
  });
  const elsewhere: T[] = [];
  for (const item of items) {
    let best: TreeCheckout<T> | null = null;
    for (const checkout of tree.flatMap((node) => node.checkouts)) {
      if (within(cwdOf(item), checkout.worktree.path) && (!best || checkout.worktree.path.length > best.worktree.path.length)) {
        best = checkout;
      }
    }
    if (best) best.items.push(item);
    else elsewhere.push(item);
  }
  for (const node of tree) for (const checkout of node.checkouts) checkout.items = order(checkout.items);
  return { projects: tree, elsewhere: order(elsewhere) };
}

/** A checkout's name: its branch, else its commit, else its folder. */
export function checkoutName(worktree: Worktree): string {
  return worktree.branch ?? (worktree.commit || worktree.path.replace(/\/+$/, "").split("/").pop() || worktree.path);
}

/** A checkout a new session can start in, as the picker offers it. */
export interface Place {
  key: string;
  cwd: string;
  /** `null` for a folder outside every Project in view. */
  project: Project | null;
  /** "roer · fix-login", or the folder's own path outside a Project. */
  label: string;
  /** A linked worktree, rather than a Project's main checkout. */
  linked: boolean;
  /** Where the session on the stage runs. */
  here: boolean;
}

/**
 * Every checkout of `projects`, the one `here` is in first. A `here` that is
 * in none of them, a session's folder outside every Project, is offered as
 * itself, so starting beside it is always one Enter away.
 */
export function placesOf(
  projects: Project[],
  worktrees: Record<string, Worktree[]>,
  repos: Record<string, Repo>,
  here: string | undefined,
  outside: (path: string) => string,
): Place[] {
  const places: Place[] = [];
  for (const project of projects) {
    const others = new Set(projects.filter((other) => other !== project).map((other) => other.path));
    for (const worktree of checkoutsOf(project, others, worktrees, repos)) {
      places.push({
        key: worktree.path,
        cwd: worktree.path,
        project,
        label: `${project.name} · ${checkoutName(worktree)}`,
        linked: !worktree.main,
        here: false,
      });
    }
  }
  if (!here) return places;
  // The closest checkout that holds it, as sessions are sorted into them.
  let best: Place | null = null;
  for (const place of places) {
    if (within(here, place.cwd) && (!best || place.cwd.length > best.cwd.length)) best = place;
  }
  const first: Place = best
    ? { ...best, here: true }
    : { key: here, cwd: here, project: null, label: outside(here), linked: false, here: true };
  return [first, ...places.filter((place) => place !== best)];
}
