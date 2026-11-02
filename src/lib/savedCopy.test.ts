import { describe, expect, it, vi } from "vitest";

import { callKey, jsonText, readOnly, scriptText } from "../copy/protocol";
import { copyFileName, handleCall, trimBranches } from "./savedCopy";

describe("saving a copy of a tab", () => {
  it("runs reads, and refuses everything that could change something before it runs", async () => {
    const run = vi.fn(async () => "diff") as unknown as Parameters<typeof handleCall>[3];

    expect(await handleCall("git_diff", { root: "/r", path: "a", untracked: false }, [], run)).toEqual({
      answer: { value: "diff" },
      keep: true,
    });

    for (const cmd of [
      "git_commit_all",
      "gh_pr_merge",
      "gh_pr_create",
      "gh_request_copilot_review",
      "roer_send",
      "stage_action",
      "shared_state_set",
      "pty_spawn",
      "open_url",
      "git_blob",
      "roer_sessions",
    ]) {
      const handled = await handleCall(cmd, {}, [], run);
      expect(handled.keep, cmd).toBe(false);
      expect(handled.refused, cmd).toBe(cmd);
      expect("error" in handled.answer, cmd).toBe(true);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a server.ts method only when the tab says it only reads", async () => {
    const run = vi.fn(async () => ({ rows: 1 })) as unknown as Parameters<typeof handleCall>[3];
    const refused = await handleCall("extension_rpc", { id: "x", method: "save" }, ["list"], run);
    expect(refused.refused).toBe("server.ts save");
    expect(run).not.toHaveBeenCalled();
    expect((await handleCall("extension_rpc", { id: "x", method: "list" }, ["list"], run)).keep).toBe(true);
    expect(readOnly("extension_rpc", { method: "list" }, [])).toBe(false);
  });

  it("hands the frame the shared store without keeping it", async () => {
    const run = vi.fn(async () => ({ "roer:review:a": "x" })) as unknown as Parameters<typeof handleCall>[3];
    expect(await handleCall("shared_state_all", {}, [], run)).toEqual({ answer: { value: { "roer:review:a": "x" } }, keep: false });
  });

  it("files a call under the same key however its arguments were ordered", () => {
    expect(callKey("git_diff", { root: "/r", path: "a", untracked: false })).toBe(
      callKey("git_diff", { untracked: false, path: "a", root: "/r" }),
    );
    expect(callKey("git_branch_diff", { cwd: "/r", base: null })).not.toBe(callKey("git_branch_diff", { cwd: "/r", base: "main" }));
  });

  it("keeps what it inlines from closing the script it is in", () => {
    expect(scriptText('const a = "</script><b>";')).toBe('const a = "<\\/script><b>";');
    expect(jsonText({ text: "</script>" })).not.toContain("<");
    expect(JSON.parse(jsonText({ text: "</script>" }))).toEqual({ text: "</script>" });
  });

  it("keeps of the branch list only the branches the copy shows", () => {
    const answers = {
      [callKey("git_branches", { cwd: "/r" })]: { value: ["main", "feature", "backup-secret-plan", "andrey-dashboard"] },
    };
    trimBranches(
      answers,
      [
        { cmd: "git_branches", args: { cwd: "/r" } },
        { cmd: "git_branch_commits", args: { root: "/r", branch: "feature", base: "origin/main" } },
      ],
      { cwd: "/r", root: "/r", branch: "feature" },
    );
    expect(answers[callKey("git_branches", { cwd: "/r" })]).toEqual({ value: ["main", "feature"] });
  });

  it("names the file after the tab, the repository, the branch and the day", () => {
    expect(copyFileName("Changes", { cwd: "/w/roer", root: "/w/roer/", branch: "extension-in-browser" })).toMatch(
      /^Changes-roer-extension-in-browser-\d{4}-\d{2}-\d{2}\.html$/,
    );
  });
});
