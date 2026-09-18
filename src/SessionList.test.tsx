import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitRoot } from "./lib/git";
import { SessionList, type OpenRequest } from "./SessionList";
import { listClaudeSessions, listPastSessions, listSessions, roerStatus } from "./lib/pty";

vi.mock("./lib/pty", () => ({
  listSessions: vi.fn(),
  listPastSessions: vi.fn(),
  listClaudeSessions: vi.fn(),
  roerStatus: vi.fn(),
}));

vi.mock("./lib/git", () => ({
  gitRoot: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(listSessions).mockReset().mockResolvedValue([]);
  vi.mocked(listPastSessions).mockReset().mockResolvedValue([]);
  vi.mocked(listClaudeSessions).mockReset().mockResolvedValue([]);
  vi.mocked(gitRoot).mockReset().mockResolvedValue(null);
  vi.mocked(roerStatus)
    .mockReset()
    .mockResolvedValue({ bin: "roer", available: true, home: "/Users/test" });
});

function renderList(onOpen: (request: OpenRequest) => void = vi.fn()) {
  return render(<SessionList token="none" error={null} onOpen={onOpen} />);
}

describe("past Claude conversations", () => {
  it("renders resumable conversations under a divider", async () => {
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/project",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      {
        id: "abc-123",
        cwd: "/Users/test/project",
        title: "fix the flaky test",
        updatedAt: Math.floor(Date.now() / 1000) - 120,
      },
    ]);
    renderList();

    expect(await screen.findByRole("heading", { name: /resume/i })).toBeInTheDocument();
    const row = await screen.findByRole("button", { name: /fix the flaky test/i });
    expect(row).toHaveTextContent("ago");
  });

  it("resumes via the shim's resume command in the conversation's old directory", async () => {
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/project",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      {
        id: "abc-123",
        cwd: "/Users/test/project",
        title: "fix the flaky test",
        updatedAt: Math.floor(Date.now() / 1000),
      },
    ]);
    const onOpen = vi.fn();
    renderList(onOpen);

    fireEvent.click(await screen.findByRole("button", { name: /fix the flaky test/i }));

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["resume", "abc-123"],
        cwd: "/Users/test/project",
        title: "fix the flaky test",
      }),
    );
  });

  it("scopes the Claude lookup to the union of live and past-history cwds", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer-a",
        pane: "%0",
        attached: true,
        cwd: "/Users/test/live",
        command: "claude",
      },
    ]);
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/ended",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    renderList();

    await screen.findByRole("navigation", { name: /sessions/i });
    expect(listClaudeSessions).toHaveBeenCalledWith(["/Users/test/live", "/Users/test/ended"]);
  });

  it("shows no Resume divider when there is no history", async () => {
    renderList();
    await screen.findByRole("navigation", { name: /sessions/i });
    expect(screen.queryByRole("heading", { name: /resume/i })).not.toBeInTheDocument();
  });
});

describe("grouping by git root", () => {
  it("groups sessions from different repositories under their own heading", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/work/one", command: "zsh" },
      { id: "2", session: "roer-b", pane: "%1", attached: true, cwd: "/work/two", command: "zsh" },
    ]);
    vi.mocked(gitRoot).mockImplementation(async (cwd: string) =>
      cwd === "/work/one" ? "/work/one" : "/work/two",
    );
    renderList();

    const groups = await screen.findAllByRole("heading", { level: 3 });
    expect(groups.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("one"), expect.stringContaining("two")]),
    );
  });

  it("shows no group heading when everything shares one root", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { id: "1", session: "roer-a", pane: "%0", attached: true, cwd: "/work/one", command: "zsh" },
      {
        id: "2",
        session: "roer-b",
        pane: "%1",
        attached: true,
        cwd: "/work/one/sub",
        command: "zsh",
      },
    ]);
    vi.mocked(gitRoot).mockResolvedValue("/work/one");
    renderList();

    await screen.findByRole("button", { name: /roer-a/i });
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });
});

describe("naming the agent", () => {
  it("names a running claude session the same way the terminal would", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        id: "1",
        session: "roer-a",
        pane: "%0",
        attached: true,
        cwd: "/Users/test/project",
        command: "claude",
      },
    ]);
    renderList();

    const row = await screen.findByRole("button", { name: /roer-a/i });
    expect(row).toHaveTextContent("claude");
  });

  it("names the agent on every row in the Resume list", async () => {
    vi.mocked(listPastSessions).mockResolvedValue([
      {
        id: "past-1",
        name: "roer-3f5c",
        cwd: "/Users/test/project",
        createdAt: 1,
        updatedAt: 1,
        endedAt: 2,
      },
    ]);
    vi.mocked(listClaudeSessions).mockResolvedValue([
      {
        id: "abc-123",
        cwd: "/Users/test/project",
        title: "fix the flaky test",
        updatedAt: Math.floor(Date.now() / 1000),
      },
    ]);
    renderList();

    const row = await screen.findByRole("button", { name: /fix the flaky test/i });
    expect(row).toHaveTextContent("claude");
  });
});
