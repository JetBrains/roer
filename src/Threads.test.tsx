import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendToSession } from "./lib/github";
import { allThreads, replyToThread, startThread, useThreads, type LiveSession } from "./lib/threads";
import { ThreadCards, useThreadOutbox, useThreadSender, type ThreadPeople } from "./Threads";

vi.mock("./lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/github")>()),
  sendToSession: vi.fn().mockResolvedValue(undefined),
}));

const ROOT = "/Users/test/project";
const live = (busy: boolean): LiveSession => ({ pane: "%4", id: "s4", agent: "claude", cwd: ROOT, busy });
const onLine = { kind: "line" as const, path: "a.ts", line: 1, code: "x" };

beforeEach(() => {
  localStorage.clear();
  vi.mocked(sendToSession).mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe("the thread outbox", () => {
  it("keeps a comment written while its session was busy when its view closes, and another sends it", async () => {
    const view = renderHook((people: ThreadPeople) => useThreadSender(people), { initialProps: { sessions: [live(true)] } });
    act(() => void view.result.current.start({ root: ROOT, anchors: [onLine], text: "Why?" }));
    expect(view.result.current.statusOf(allThreads()[0])).toBe("claude · project · waiting for it to be free");
    view.unmount();
    expect(allThreads()[0].outbox).toEqual([{ kind: "ask" }]);

    // The app's own sender, with the session free now.
    renderHook(() => useThreadOutbox({ sessions: [live(false)] }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendToSession).mock.calls[0][1]).toContain("Why?");
    await waitFor(() => expect(allThreads()[0].outbox).toBeUndefined());
    expect(allThreads()[0].awaiting).toBe(true);
  });

  it("tries a failed send again after a while, not on every render", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(sendToSession).mockRejectedValueOnce(new Error("pane gone"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sessions = [live(false)];
    const view = renderHook(() => useThreadSender({ sessions: [...sessions] }));
    act(() => void view.result.current.start({ root: ROOT, anchors: [onLine], text: "Why?" }));
    await waitFor(() => expect(allThreads()[0].retryAt).toBeDefined());
    expect(view.result.current.statusOf(allThreads()[0])).toBe("claude · project · could not send it, trying again");

    // Renders on their own do not send it again.
    view.rerender();
    view.rerender();
    expect(sendToSession).toHaveBeenCalledTimes(1);

    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(allThreads()[0].outbox).toBeUndefined());
    expect(allThreads()[0].retryAt).toBeUndefined();
  });

  it("holds a comment with no session to go to, says so, and sends it once one works in its repository", async () => {
    const view = renderHook((people: ThreadPeople) => useThreadSender(people), { initialProps: { sessions: [] as LiveSession[] } });
    act(() => void view.result.current.start({ root: ROOT, anchors: [onLine], text: "Anyone?" }));
    expect(view.result.current.statusOf(allThreads()[0])).toBe("waiting for a session in this repository");
    expect(allThreads()[0].awaiting).toBeFalsy();

    view.rerender({ sessions: [live(false)] });
    await waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(allThreads()[0].session).toMatchObject({ pane: "%4", id: "s4" }));
    expect(allThreads()[0].awaiting).toBe(true);
  });

  it("does not mark a reply as due an answer until it has been sent", () => {
    const view = renderHook(() => useThreadSender({ sessions: [] }));
    let id = "";
    act(() => void (id = view.result.current.start({ root: ROOT, anchors: [onLine], text: "First" }).id));
    act(() => view.result.current.reply(allThreads()[0], "Again"));
    const thread = allThreads().find((one) => one.id === id)!;
    expect(thread.awaiting).toBeFalsy();
    expect(thread.outbox).toEqual([{ kind: "ask" }, { kind: "reply", text: "Again" }]);
  });
});

describe("thread cards", () => {
  function Cards({ sessions = [live(false)] }: { sessions?: LiveSession[] }) {
    const sender = useThreadSender({ sessions });
    const threads = useThreads(() => true, []);
    return <ThreadCards threads={threads} sender={sender} name={() => "line 1"} />;
  }
  const started = () => startThread({ root: ROOT, anchors: [onLine], text: "Why one?\nIt was two.", session: { pane: "%4", id: "s4" } });

  it("collapses to its head and first line, kept so, until something new is said in it", () => {
    const thread = started();
    render(<Cards />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse the comment" }));
    expect(screen.queryByText(/It was two/)).toBeNull();
    expect(screen.getByRole("button", { name: "Why one?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();

    // An answer opens it again, so it is never left folded away.
    act(() => void replyToThread(thread.id, "Claude", "Because.", false));
    expect(screen.getByText("Because.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse the comment" })).toBeInTheDocument();
  });

  it("tells the person's words from the agent's, and shows the key a reply is sent with", () => {
    const thread = started();
    act(() => void replyToThread(thread.id, "Claude", "Because.", false));
    act(() => void replyToThread(thread.id, "You", "Thanks.", true));
    const { container } = render(<Cards />);
    expect(container.querySelector(".note-card")).toHaveClass("mine");
    expect([...container.querySelectorAll(".note-card-reply")].map((one) => one.className)).toEqual([
      "note-card-reply theirs",
      "note-card-reply mine",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByRole("button", { name: "Reply" })).toHaveAttribute("aria-keyshortcuts");
  });

  it("replies on R while the thread has the keyboard, not while typing", () => {
    started();
    const { container } = render(<Cards />);
    const thread = container.querySelector<HTMLElement>("[data-thread]")!;
    thread.focus();
    fireEvent.keyDown(thread, { key: "r" });
    const box = screen.getByRole("textbox", { name: "Reply on line 1" });
    fireEvent.change(box, { target: { value: "r" } });
    fireEvent.keyDown(box, { key: "r" });
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
  });
});
