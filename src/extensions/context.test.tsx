import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitCurrentBranch, gitRoot } from "../lib/git";
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
