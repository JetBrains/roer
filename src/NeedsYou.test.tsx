import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NeedsYou } from "./NeedsYou";
import { notify } from "./lib/notify";
import type { SessionInfo } from "./lib/pty";
import { allThreads, replyToThread, startThread } from "./lib/threads";

vi.mock("./lib/notify", () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ pane: "%1", id: "s1", session: "roer-1", cwd: "/repo", command: "claude", agent: "claude", title: "", ...over }) as SessionInfo;

const show = (over: Partial<Parameters<typeof NeedsYou>[0]> = {}) => {
  const props = {
    sessions: [session()],
    waiting: new Set<string>(),
    activePane: null,
    onOpenSession: vi.fn(),
    onOpenFile: vi.fn(),
    people: {},
    ...over,
  };
  render(<NeedsYou {...props} />);
  return props;
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("NeedsYou", () => {
  it("is not there while nothing waits on the person", () => {
    show();
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
  });

  it("lists a session held up on the person, and opens it", () => {
    const props = show({ sessions: [session({ state: "waiting", note: "Wants to run npm test" })], waiting: new Set(["%1"]) });
    expect(screen.getByText("Wants to run npm test")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Wants to run npm test"));
    expect(props.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ pane: "%1" }));
  });

  it("lists a thread an agent answered, opens it in place to read and reply, and opens its file", () => {
    const thread = startThread({
      root: "/repo",
      anchors: [{ kind: "line", path: "src/a.ts", line: 4, code: "x" }],
      text: "Why?",
      session: { pane: "%1", id: "s1" },
    });
    replyToThread(thread.id, "Claude", "Because it is.", false);
    const props = show();
    expect(screen.getByText("a.ts:4")).toBeInTheDocument();
    expect(screen.getByText("Because it is.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /answered/ }));
    // Read now, and still listed while it is open.
    expect(allThreads()[0].seen).toBe(2);
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open a.ts:4" }));
    expect(props.onOpenFile).toHaveBeenCalledWith("/repo", "src/a.ts", 4, { thread: thread.id });

    // Closed, it is off the list.
    fireEvent.click(screen.getByRole("button", { name: /answered/ }));
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
  });

  it("says in a banner that an agent answered, in its own words never, while Roer is not in front", () => {
    const thread = startThread({ root: "/repo", anchors: [{ kind: "line", path: "src/a.ts", line: 4, code: "x" }], text: "Why?" });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    show();
    act(() => void replyToThread(thread.id, "claude", "A secret answer", false));
    expect(notify).toHaveBeenCalledWith("Claude", "Claude answered your comment on a.ts:4", expect.any(Function));
    expect(vi.mocked(notify).mock.calls[0].join(" ")).not.toContain("secret");
  });

  it("shows four of many, newest first, the rest on asking, and folds away", () => {
    for (let i = 1; i <= 15; i += 1) {
      startThread({ root: "/repo", anchors: [{ kind: "line", path: `src/f${i}.ts`, line: 1, code: "" }], text: `Q${i}`, author: "Claude" });
    }
    show();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("f15.ts:1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "11 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(15);
    fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("15")).toBeInTheDocument();
  });
});

