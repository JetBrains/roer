import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Conversations, bucketOf } from "./Conversations";
import { readClaudeTranscript, searchClaudeSessions, type ClaudeHit, type ClaudeSession, type ClaudeTranscript } from "./lib/pty";

vi.mock("./lib/pty", () => ({ searchClaudeSessions: vi.fn(), readClaudeTranscript: vi.fn() }));

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
const titles = () => screen.queryAllByRole("button", { name: /^(Resume|Show) (?!\d+ more$)/ }).map((row) => row.getAttribute("aria-label"));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  vi.mocked(searchClaudeSessions).mockReset().mockResolvedValue([]);
  vi.mocked(readClaudeTranscript).mockReset().mockResolvedValue({ messages: [], earlier: 0 });
  localStorage.removeItem("roer:conversation-preview");
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
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

describe("the preview", () => {
  const list = [
    at("a", "login form loses focus", 60, { branch: "main" }),
    at("b", "rounding in invoices", DAY, { branch: "fix/billing-rounding" }),
  ];
  const toggle = () => screen.getByRole("button", { name: "Preview" });
  const panel = () => screen.queryByRole("complementary", { name: "Preview" });

  it("is turned on and off by its own button, and remembered", () => {
    renderList(list);
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(panel()).not.toBeInTheDocument();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(panel()).toHaveTextContent("Pick a conversation to read it here.");
    expect(localStorage.getItem("roer:conversation-preview")).toBe("on");

    fireEvent.click(toggle());
    expect(panel()).not.toBeInTheDocument();
    expect(localStorage.getItem("roer:conversation-preview")).toBe("off");
  });

  it("shows what was said without resuming, and resumes from there", async () => {
    vi.mocked(readClaudeTranscript).mockResolvedValue({
      messages: [
        { role: "user", text: "the login form loses focus on submit" },
        { role: "assistant", text: "It re-renders the form; fixed by keeping its key." },
        { role: "assistant", text: "| before | after |\n|---|---|\n| **lost** | kept |" },
      ],
      earlier: 0,
    });
    const onOpen = renderList(list);
    fireEvent.click(toggle());

    fireEvent.click(screen.getByRole("button", { name: "Show login form loses focus" }));

    expect(await within(panel()!).findByText("It re-renders the form; fixed by keeping its key.")).toBeInTheDocument();
    expect(readClaudeTranscript).toHaveBeenCalledWith(["/work/shop"], "a");
    // Who said what, named as the rows name the agent that will run.
    expect(within(panel()!).getByText("You")).toBeInTheDocument();
    expect(within(panel()!).getAllByText("claude")).toHaveLength(2);
    // A reply reads as the Markdown it was written in.
    expect(within(panel()!).getByRole("table")).toBeInTheDocument();
    expect(within(panel()!).getByText("lost").tagName).toBe("STRONG");
    expect(within(panel()!).getByText(/Read-only/)).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(within(panel()!).getByRole("button", { name: "Resume" }));
    expect(onOpen).toHaveBeenCalledWith(list[0]);
  });

  it("opens on a row from the row's own preview button", async () => {
    renderList(list);

    fireEvent.click(screen.getByRole("button", { name: "Preview rounding in invoices" }));

    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(readClaudeTranscript).toHaveBeenCalledWith(["/work/shop"], "b"));
    expect(within(panel()!).getByRole("heading", { name: "rounding in invoices" })).toBeInTheDocument();
  });

  it("steps through the rows with the arrows, and Escape closes it", async () => {
    const onOpen = renderList(list);
    fireEvent.click(toggle());
    const first = screen.getByRole("button", { name: "Show login form loses focus" });
    fireEvent.click(first);

    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(readClaudeTranscript).toHaveBeenLastCalledWith(["/work/shop"], "b"));
    expect(screen.getByRole("button", { name: "Show rounding in invoices" })).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(screen.getByRole("button", { name: "Show rounding in invoices" }), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(list[1]);

    fireEvent.keyDown(screen.getByRole("button", { name: "Show rounding in invoices" }), { key: "Escape" });
    expect(panel()).not.toBeInTheDocument();
    // Off again, a click resumes as before.
    fireEvent.click(screen.getByRole("button", { name: "Resume login form loses focus" }));
    expect(onOpen).toHaveBeenLastCalledWith(list[0]);
  });

  it("goes to what the filter found, marked", async () => {
    vi.mocked(searchClaudeSessions).mockResolvedValue([{ id: "b", snippet: "…the cents are lost…" }]);
    vi.mocked(readClaudeTranscript).mockResolvedValue({
      messages: [
        { role: "user", text: "look at the invoices" },
        { role: "assistant", text: "The cents are lost when rounding." },
      ],
      earlier: 12,
    });
    renderList(list);
    fireEvent.change(filter(), { target: { value: "cents" } });
    await waitFor(() => expect(titles()).toEqual(["Resume rounding in invoices"]));

    fireEvent.click(screen.getByRole("button", { name: "Preview rounding in invoices" }));

    const mark = await within(panel()!).findByText("cents", { selector: "mark" });
    // The panel's own list scrolls to it; the page around it stays put.
    await waitFor(() => expect(Element.prototype.scrollTo).toHaveBeenCalled());
    expect(vi.mocked(Element.prototype.scrollTo).mock.contexts[0]).toBe(mark.closest("ol"));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(mark.closest("li")).toHaveTextContent("The cents are lost when rounding.");
    expect(within(panel()!).getByText("12 earlier messages not shown")).toBeInTheDocument();
  });

  it("opens at the latest of what was said, with no filter to go by", async () => {
    vi.mocked(readClaudeTranscript).mockResolvedValue({
      messages: [
        { role: "user", text: "look at the invoices" },
        { role: "assistant", text: "Fixed the rounding." },
      ],
      earlier: 0,
    });
    const tall = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    renderList(list);
    fireEvent.click(screen.getByRole("button", { name: "Preview rounding in invoices" }));

    const last = await within(panel()!).findByText("Fixed the rounding.");
    await waitFor(() => expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 900 }));
    expect(vi.mocked(Element.prototype.scrollTo).mock.contexts.at(-1)).toBe(last.closest("ol"));
    tall.mockRestore();
  });

  it("reads only the row the arrows stop at", async () => {
    const three = [...list, at("c", "dark mode toggle", 2 * DAY)];
    renderList(three);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Show login form loses focus" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Show login form loses focus" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Show rounding in invoices" }), { key: "ArrowDown" });

    await waitFor(() => expect(readClaudeTranscript).toHaveBeenCalledWith(["/work/shop"], "c"));
    expect(readClaudeTranscript).toHaveBeenCalledTimes(1);
  });

  it("shows the row picked last, whichever answer comes back first", async () => {
    let answerA: (transcript: ClaudeTranscript) => void = () => {};
    vi.mocked(readClaudeTranscript)
      .mockImplementationOnce(() => new Promise((resolve) => (answerA = resolve)))
      .mockResolvedValueOnce({ messages: [{ role: "assistant", text: "About invoices." }], earlier: 0 });
    renderList(list);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Show login form loses focus" }));
    await waitFor(() => expect(readClaudeTranscript).toHaveBeenCalledWith(["/work/shop"], "a"));
    fireEvent.click(screen.getByRole("button", { name: "Show rounding in invoices" }));
    expect(await within(panel()!).findByText("About invoices.")).toBeInTheDocument();

    await act(async () => answerA({ messages: [{ role: "assistant", text: "About the login form." }], earlier: 0 }));
    expect(within(panel()!).queryByText("About the login form.")).not.toBeInTheDocument();
  });

  it("says when it could not read one", async () => {
    vi.mocked(readClaudeTranscript).mockRejectedValue("permission denied");
    renderList(list);
    fireEvent.click(screen.getByRole("button", { name: "Preview login form loses focus" }));
    expect(await within(panel()!).findByText("Could not read it: permission denied")).toBeInTheDocument();
  });

  it("offers no preview of a conversation it cannot read, and still resumes it", async () => {
    const both = [...list, at("x", "port the parser", 2 * DAY, { agent: "codex" })];
    const onOpen = renderList(both);
    expect(screen.queryByRole("button", { name: "Preview port the parser" })).not.toBeInTheDocument();

    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Show port the parser" }));
    expect(within(panel()!).getByText("Roer can't read codex conversations yet; Resume opens it.")).toBeInTheDocument();
    expect(readClaudeTranscript).not.toHaveBeenCalled();
    fireEvent.click(within(panel()!).getByRole("button", { name: "Resume" }));
    expect(onOpen).toHaveBeenCalledWith(both[2]);
  });

  it("gives the keyboard back to the row when it closes", async () => {
    renderList(list);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Show rounding in invoices" }));

    fireEvent.keyDown(within(panel()!).getByRole("button", { name: "Close the preview" }), { key: "Escape" });
    expect(panel()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume rounding in invoices" })).toHaveFocus();
  });

  it("is not open with nothing to read, even when it was left on", () => {
    localStorage.setItem("roer:conversation-preview", "on");
    renderList([]);
    expect(panel()).not.toBeInTheDocument();
  });
});
