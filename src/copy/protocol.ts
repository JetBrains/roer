/**
 * A saved copy of a tab ("Save as HTML…"): one HTML file that draws the tab
 * from the answers it got while it was saved, with no backend behind it.
 *
 * Saving runs the tab in a sandboxed frame of its own (`src/copy/main.tsx`,
 * built by `vite.copy.config.ts`), whose backend asks the view that saves it
 * for everything (`src/lib/savedCopy.ts`). That view runs only what is in
 * `READ_ONLY` and refuses the rest before it runs, so saving a copy cannot
 * commit, merge, type into a session or start an agent, whatever the tab's
 * code asks for. The file then plays the answers back.
 */

/**
 * Commands that only read: what a saved copy may ask for and keep. Everything
 * else is refused while it is saved, including reads that are expensive or
 * reach beyond the tab (`git_blob`, the session list), and `extension_rpc`
 * unless the tab names the method in `copy.readOnlyRpc`.
 */
export const READ_ONLY: ReadonlySet<string> = new Set([
  "git_root",
  "git_repo",
  "git_checked_out",
  "git_current_branch",
  "git_branches",
  "git_default_base",
  "git_changes",
  "git_diff",
  "git_branch_diff",
  "git_branch_commits",
  "git_commit_files",
  "git_commit_diff",
  "gh_pr_for_branch",
  "gh_pr_diff",
  "gh_pr_review",
  "gh_merge_methods",
  "gh_pr_can_bypass",
  "file_read",
]);

/** Whether a copy being saved may run `cmd` with `args`. */
export function readOnly(cmd: string, args: Record<string, unknown>, readOnlyRpc: readonly string[]): boolean {
  if (cmd === "extension_rpc") return typeof args.method === "string" && readOnlyRpc.includes(args.method);
  return READ_ONLY.has(cmd);
}

/** `value` as JSON with every object's keys in order, so two equal calls are one key. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, one]) => one !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, one]) => `${JSON.stringify(key)}:${stable(one)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What a recorded answer is filed under. */
export const callKey = (cmd: string, args: Record<string, unknown>): string => `${cmd} ${stable(args)}`;

/** One recorded answer: the value, or what the call failed with. */
export type Answer = { value: unknown } | { error: string };

/** The session a copy's tab is given: where it is, never a pane to type into. */
export interface CopySession {
  cwd: string;
  root: string | null;
  branch: string | null;
}

/** What the copy's page starts from: `window.__roerCopy`. */
export interface CopyBoot {
  mode: "record" | "replay";
  extension: string;
  tabId: string;
  title: string;
  session: CopySession | null;
  theme: "light" | "dark";
  /** The extension's own build, for one that is not bundled with Roer. */
  js?: string;
  css?: string;
  /** Replay: every answer, by `callKey`. */
  answers?: Record<string, Answer>;
  /** Replay: the shared-storage values the tab read while it was saved. */
  shared?: Record<string, string>;
  /** Replay: when it was saved, for the banner. */
  savedAt?: string;
}

/** Frame → saving view. */
export type FromFrame =
  | { type: "roer-copy:invoke"; id: number; cmd: string; args: Record<string, unknown> }
  | { type: "roer-copy:done"; sharedRead: string[] }
  | { type: "roer-copy:failed"; error: string };

/** Saving view → frame. */
export type ToFrame = { type: "roer-copy:answer"; id: number; answer: Answer };

/** JavaScript safe inside an inline `<script>`: nothing in it can close the element. `<\/` reads as `</` in a
 * string, a template or a regular expression, which is where a bundle has it. */
export const scriptText = (js: string): string => js.replace(/<\/(script)/gi, "<\\/$1");

/** `value` as JSON safe inside a `<script type="application/json">`: no `<` at all, which JSON spells `\u003c`. */
export const jsonText = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
