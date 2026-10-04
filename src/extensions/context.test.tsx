import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitCurrentBranch, gitRoot } from "../lib/git";
import { sendToSession } from "../lib/github";
import { useStageSession } from "./context";

vi.mock("../lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/git")>()),
  gitRoot: vi.fn(),
  gitCurrentBranch: vi.fn(),
}));
vi.mock("../lib/session", () => ({ resolveDir: vi.fn(async (cwd?: string) => cwd ?? "") }));
vi.mock("../lib/github", () => ({ sendToSession: vi.fn() }));

const batch = (n: number) => ({ root: "/a", paths: [`f${n}`], broad: false });

beforeEach(() => {
  vi.mocked(gitRoot).mockImplementation(async (dir) => dir);
  vi.mocked(gitCurrentBranch).mockResolvedValue("main");
});

describe("useStageSession", () => {
  it("types nothing into a plain shell, whoever asks", async () => {
    const staged = { cwd: "/a", pane: "%1" };
    const shell = renderHook(() => useStageSession(staged, { agent: null, busy: false, changed: null }));
    await expect(shell.result.current!.send("Review this")).rejects.toThrow(/only a shell/);
    expect(sendToSession).not.toHaveBeenCalled();
    // An agent, or one not known yet, is typed into.
    const agent = renderHook(() => useStageSession(staged, { agent: "claude", busy: false, changed: null }));
    await agent.result.current!.send("Review this");
    expect(sendToSession).toHaveBeenCalledWith("%1", "Review this");
  });

  it("sees a checkout on the next batch the watch reports", async () => {
    const staged = { cwd: "/a", pane: "%1" };
    const { result, rerender } = renderHook(({ changed }) => useStageSession(staged, { busy: false, changed }), {
      initialProps: { changed: batch(1) },
    });
    await waitFor(() => expect(result.current?.branch).toBe("main"));

    vi.mocked(gitCurrentBranch).mockResolvedValue("feature");
    rerender({ changed: batch(2) });
    await waitFor(() => expect(result.current?.branch).toBe("feature"));
  });

  it("never shows one session's pane with another's repository", async () => {
    const { result, rerender } = renderHook(({ staged }) => useStageSession(staged, { busy: false, changed: null }), {
      initialProps: { staged: { cwd: "/a", pane: "%1" } },
    });
    await waitFor(() => expect(result.current?.root).toBe("/a"));

    let answer: (branch: string) => void = () => undefined;
    vi.mocked(gitCurrentBranch).mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    rerender({ staged: { cwd: "/b", pane: "%2" } });
    expect(result.current).toMatchObject({ pane: "%2", root: null, branch: null });
    await waitFor(() => expect(gitCurrentBranch).toHaveBeenLastCalledWith("/b"));
    answer("dev");
    await waitFor(() => expect(result.current).toMatchObject({ pane: "%2", root: "/b", branch: "dev" }));
  });
});
