import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Conversations, bucketOf } from "./Conversations";
import { searchClaudeSessions, type ClaudeHit, type ClaudeSession } from "./lib/pty";

vi.mock("./lib/pty", () => ({ searchClaudeSessions: vi.fn() }));

const DAY = 24 * 60 * 60;
/** Noon on a Wednesday, local time, so "yesterday" is never across a week. */
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime() / 1000;

const at = (id: string, title: string, ago: number, extra: Partial<ClaudeSession> = {}): ClaudeSession => ({
  id,
  title,
  cwd: "/work/shop",
  updatedAt: NOW - ago,
  ...extra,
});

function renderList(conversations: ClaudeSession[], onOpen = vi.fn()) {
  render(
    <Conversations
      conversations={conversations}
      cwds={["/work/shop"]}
      repos={{}}
      worktrees={{}}
      projects={[]}
      home="/home/me"
      workspaces={[]}
      assignments={{}}
      handleAssign={vi.fn()}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}

const filter = () => screen.getByRole("searchbox", { name: "Filter conversations" });
const titles = () => screen.queryAllByRole("button", { name: /^Resume / }).map((row) => row.getAttribute("aria-label"));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  vi.mocked(searchClaudeSessions).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bucketOf", () => {
  it("goes by the local day", () => {
    const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime() / 1000;
    expect(bucketOf(midnight + 1, NOW)).toBe("Today");
    expect(bucketOf(midnight - 1, NOW)).toBe("Yesterday");
    expect(bucketOf(NOW - 6 * DAY, NOW)).toBe("Previous 7 days");
    expect(bucketOf(NOW - 20 * DAY, NOW)).toBe("Previous 30 days");
    expect(bucketOf(NOW - 90 * DAY, NOW)).toBe("Older");
  });
});

describe("the timeline", () => {
  it("puts each conversation under when it was last had, newest first", () => {
    renderList([
      at("a", "older one", 90 * DAY),
      at("b", "this morning", 2 * 60 * 60),
      at("c", "last night", DAY),
      at("d", "earlier this month", 20 * DAY),
      at("e", "a few days back", 3 * DAY),
    ]);

    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"]);
    expect(titles()).toEqual([
      "Resume this morning",
      "Resume last night",
      "Resume a few days back",
      "Resume earlier this month",
      "Resume older one",
    ]);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("5");
  });

  it("shows ten of a long day, and the rest on asking", () => {
    renderList(Array.from({ length: 14 }, (_, n) => at(`c${n}`, `task ${n}`, 60 + n)));

    expect(titles()).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(titles()).toHaveLength(14);
  });

  it("says the branch, and when a claude outside Roer has it open", () => {
    renderList([at("a", "fix rounding", 60, { branch: "fix/billing-rounding", openElsewhere: true })]);

    const row = screen.getByRole("button", { name: "Resume fix rounding" });
    expect(within(row).getByText("fix/billing-rounding")).toBeInTheDocument();
    expect(within(row).getByText("running outside Roer")).toBeInTheDocument();
    // Said to a screen reader too, which hears the row by its label.
    expect(row).toHaveAccessibleDescription(/running outside Roer/);
  });

  it("keeps a day unfolded when the list is read again", () => {
    const list = Array.from({ length: 14 }, (_, n) => at(`c${n}`, `task ${n}`, 60 + n));
    const props = {
      repos: {},
      worktrees: {},
      projects: [],
      home: "/home/me",
      workspaces: [],
      assignments: {},
      handleAssign: vi.fn(),
      onOpen: vi.fn(),
    };
    const { rerender } = render(<Conversations conversations={list} cwds={["/work/shop"]} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));

    rerender(<Conversations conversations={[...list]} cwds={["/work/shop", "/work/shop-wt"]} {...props} />);
    expect(titles()).toHaveLength(14);
  });

  it("resumes the conversation clicked", () => {
    const conversation = at("a", "fix rounding", 60);
    const onOpen = renderList([conversation]);

    fireEvent.click(screen.getByRole("button", { name: "Resume fix rounding" }));
    expect(onOpen).toHaveBeenCalledWith(conversation);
  });
});

describe("the filter", () => {
  const list = [
    at("a", "login form loses focus", 60, { branch: "main" }),
    at("b", "rounding in invoices", DAY, { branch: "fix/billing-rounding" }),
    at("c", "flaky test", 3 * DAY),
  ];

  it("keeps the timeline, with only what the search found, and the words that matched", async () => {
    vi.mocked(searchClaudeSessions).mockResolvedValue([
      { id: "b", snippet: "…the cents are lost when…" },
      { id: "c", snippet: "…cents again…" },
    ]);
    renderList(list);

    fireEvent.change(filter(), { target: { value: "cents" } });

    await waitFor(() => expect(titles()).toEqual(["Resume rounding in invoices", "Resume flaky test"]));
    expect(searchClaudeSessions).toHaveBeenCalledWith(["/work/shop"], "cents");
    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(["Yesterday", "Previous 7 days"]);
    const snippet = screen.getByText((_, element) => element?.textContent === "…the cents are lost when…" && element.tagName === "SPAN");
    // The words searched for stand out in what matched.
    expect(within(snippet).getByText("cents", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("2 of 3");
  });

  it("narrows by name, folder and branch at once, while the search of what was said runs", async () => {
    vi.mocked(searchClaudeSessions).mockReturnValue(new Promise<ClaudeHit[]>(() => {}));
    renderList(list);

    fireEvent.change(filter(), { target: { value: "billing" } });

    expect(titles()).toEqual(["Resume rounding in invoices"]);
    await waitFor(() => expect(screen.getByText("Searching…")).toBeInTheDocument());
  });

  it("takes the answer to the latest query, whichever lands last", async () => {
    let answerFirst: (hits: ClaudeHit[]) => void = () => {};
    vi.mocked(searchClaudeSessions)
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce([{ id: "c" }]);
    renderList(list);

    fireEvent.change(filter(), { target: { value: "flak" } });
    await waitFor(() => expect(searchClaudeSessions).toHaveBeenCalledTimes(1));
    fireEvent.change(filter(), { target: { value: "flaky" } });
    await waitFor(() => expect(titles()).toEqual(["Resume flaky test"]));

    await act(async () => answerFirst([{ id: "a" }]));
    expect(titles()).toEqual(["Resume flaky test"]);
  });

  it("keeps what was found while a longer query is asked, rather than flicker", async () => {
    let answerSecond: (hits: ClaudeHit[]) => void = () => {};
    vi.mocked(searchClaudeSessions)
      .mockResolvedValueOnce([{ id: "b", snippet: "…cents…" }, { id: "c", snippet: "…cents…" }])
      .mockImplementationOnce(() => new Promise((resolve) => (answerSecond = resolve)));
    renderList(list);

    fireEvent.change(filter(), { target: { value: "cent" } });
    await waitFor(() => expect(titles()).toHaveLength(2));
    fireEvent.change(filter(), { target: { value: "cents" } });
    await waitFor(() => expect(searchClaudeSessions).toHaveBeenCalledTimes(2));
    expect(titles()).toHaveLength(2);

    await act(async () => answerSecond([{ id: "b", snippet: "…cents…" }]));
    expect(titles()).toEqual(["Resume rounding in invoices"]);
  });

  it("says when nothing matches, and Escape brings everything back", async () => {
    renderList(list);

    fireEvent.change(filter(), { target: { value: "zebra" } });
    expect(await screen.findByText("Nothing matches “zebra”.")).toBeInTheDocument();

    fireEvent.keyDown(filter(), { key: "Escape" });
    expect(filter()).toHaveValue("");
    expect(titles()).toHaveLength(3);
  });
});
