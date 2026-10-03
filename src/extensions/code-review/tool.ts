import { gitBranchDiff, gitCurrentBranch, gitRoot, resolveDir, splitPatch, type ToolContext, type ToolOptions } from "roer";

import { diffSpots, lineText, newCommentId, spot, storedBase, updateComments, type LocalComment } from "./local";

const SEVERITIES = ["info", "warn", "error"] as const;

/** A comment as the agent sends it, checked one field at a time. */
function read(raw: unknown): Omit<LocalComment, "id" | "code" | "author"> | string {
  const c = raw as Record<string, unknown> | null;
  if (typeof c !== "object" || c === null) return "not an object";
  if (typeof c.path !== "string" || !c.path) return "no path";
  if (typeof c.line !== "number" || !Number.isInteger(c.line) || c.line < 1) return `${c.path}: no line`;
  if (typeof c.text !== "string" || !c.text.trim()) return `${c.path}:${c.line}: no text`;
  const severity = SEVERITIES.find((s) => s === c.severity);
  return {
    path: c.path.replace(/^\.\//, ""),
    line: c.line,
    side: c.side === "old" ? "old" : "new",
    text: c.text.trim(),
    ...(severity ? { severity } : {}),
  };
}

/** `add_comments`: an agent's review, onto the branch's diff in the Review tab, for the person to decide on. */
export function addCommentsTool(onAdded: (pending: number) => void): ToolOptions {
  return {
    name: "add_comments",
    description:
      "Hand review comments on this branch's changes to the user, in Roer's Review tab: each is drawn on its " +
      "line of the diff, and the user accepts, declines or answers it with an instruction, then sends their " +
      "decisions back to you as a prompt. Use it when asked to review the branch in Roer, instead of listing " +
      "findings in your reply, and do not act on them before the user has answered. `line` is the line's number " +
      "in the file as it is on disk now; for a removed line, give `side: \"old\"` and its number in the old file.",
    inputSchema: {
      type: "object",
      properties: {
        comments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative to the repository's root." },
              line: { type: "integer", minimum: 1 },
              side: { type: "string", enum: ["new", "old"], description: "Default new." },
              severity: { type: "string", enum: ["info", "warn", "error"] },
              text: { type: "string", description: "Markdown: what is wrong, and what you would change." },
            },
            required: ["path", "line", "text"],
          },
        },
        author: { type: "string", description: "Your name as the user knows you, e.g. Claude." },
      },
      required: ["comments"],
    },
    async run(args: Record<string, unknown>, context: ToolContext) {
      const dir = await resolveDir(context.cwd, context.pane);
      const root = await gitRoot(dir);
      if (!root) throw new Error(`${dir} is not in a git repository`);
      const branch = await gitCurrentBranch(root).catch(() => null);
      // The diff the tab shows: against the base it last compared with, its pull request's when that differs.
      const diff = await gitBranchDiff(root, storedBase(root, branch));
      const changed = new Set(splitPatch(diff.diff).map((file) => file.path));
      const drawn = diffSpots(diff.diff);
      const author = typeof args.author === "string" && args.author.trim() ? args.author.trim() : "Agent";

      const added: LocalComment[] = [];
      const skipped: string[] = [];
      for (const raw of Array.isArray(args.comments) ? args.comments : []) {
        const comment = read(raw);
        if (typeof comment === "string") {
          skipped.push(comment);
          continue;
        }
        if (!changed.has(comment.path)) {
          skipped.push(`${comment.path}: this branch does not change it`);
          continue;
        }
        const code = lineText(diff.diff, comment.path, comment.line, comment.side);
        added.push({ id: newCommentId(), ...comment, code, author });
      }
      if (added.length === 0) {
        throw new Error(skipped.length > 0 ? `No comments added: ${skipped.join("; ")}` : "`comments` is empty");
      }
      const all = updateComments(diff.root, branch, (current) => [...current, ...added]);
      onAdded(all.filter((c) => c.author && !c.verdict).length);

      const outside = added.filter((c) => !drawn.has(spot(c.path, c.side, c.line))).length;
      return [
        `Added ${added.length} ${added.length === 1 ? "comment" : "comments"} to Roer's Review tab, under Local changes.`,
        ...(outside > 0 ? [`${outside} of them are on lines outside the diff, so they head their file.`] : []),
        ...(skipped.length > 0 ? [`Skipped: ${skipped.join("; ")}.`] : []),
        "The user will decide on each and send the decisions back to you; do not change code for them before then.",
      ].join(" ");
    },
  };
}
