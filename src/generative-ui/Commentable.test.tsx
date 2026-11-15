import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadPeopleContext } from "../Threads";
import type { Session } from "../extensions/api";
import { allThreads, replyToThread } from "../lib/threads";
import { applyAll } from "./apply";
import { CommentScope } from "./Commentable";
import { GenerativeSurface } from "./GenerativeSurface";
import { A2UI_VERSION, type Component } from "./schema";

const components: Component[] = [
  { id: "root", component: "Column", children: ["title", "api", "db"] },
  { id: "title", component: "Text", text: "Architecture" },
  { id: "api", component: "Commentable", label: "API", child: "apiText" },
  { id: "apiText", component: "Text", text: "The API" },
  { id: "db", component: "Button", child: "dbLabel", action: { event: { name: "open" } } },
  { id: "dbLabel", component: "Text", text: "Database" },
] as Component[];

const stage = (): Session => ({
  pane: "%1",
  root: "/repo",
  branch: "main",
  agent: "claude",
  busy: false,
  changed: null,
  send: vi.fn().mockResolvedValue(undefined),
});

// jsdom does not measure: every part is given a box, so the counts are drawn.
beforeAll(() => {
  Range.prototype.getBoundingClientRect = () => ({ top: 10, left: 10, width: 100, height: 20, right: 110, bottom: 30, x: 10, y: 10, toJSON: () => ({}) });
});

function draw(root: string | null) {
  const staged = stage();
  const onAction = vi.fn();
  const state = applyAll([{ version: A2UI_VERSION, createSurface: { surfaceId: "arch", components, dataModel: {} } }]);
  render(
    <ThreadPeopleContext.Provider value={{ stage: staged }}>
      <CommentScope root={root} view="ui:arch" title="Architecture">
        <GenerativeSurface surface={state.surfaces.arch} dataModel={state.dataModels.arch} onSetValue={vi.fn()} onAction={onAction} />
      </CommentScope>
    </ThreadPeopleContext.Provider>,
  );
  return { staged, onAction };
}

beforeEach(() => localStorage.clear());

describe("Comment mode", () => {
  it("adds nothing to the view until it is turned on, and the view's buttons work as before", () => {
    const { onAction } = draw("/repo");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Database"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("picks any component, a Commentable as a whole, Shift-clicks more, and sends one prompt about them", async () => {
    const { staged, onAction } = draw("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    // A click picks instead of pressing: the button does nothing.
    fireEvent.click(screen.getByText("Database"));
    expect(onAction).not.toHaveBeenCalled();
    // Inside a Commentable the whole group is the part, by its label.
    fireEvent.click(screen.getByText("The API"), { shiftKey: true });
    fireEvent.click(screen.getByText("Architecture"), { shiftKey: true });
    // A press on the view does not take the keys from the comment box.
    expect(fireEvent.mouseDown(screen.getByText("The API"))).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on Database, API and Architecture" }), {
      target: { value: "How do these fit?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to claude" }));

    await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
    const prompt = vi.mocked(staged.send).mock.calls[0][0];
    expect(prompt).toContain('- "API" (`api`)');
    expect(prompt).toContain('- "Architecture" (`title`)');
    expect(prompt).toContain('- "Database" (`db`)');

    // Done: the view is the view again, and the parts carry the thread's count.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByText("Database"));
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "1 open of 1 thread on API" }));
    expect(screen.getByText("How do these fit?")).toBeInTheDocument();
    act(() => void replyToThread(allThreads()[0].id, "Claude", "They do.", false));
    expect(await screen.findByText("They do.")).toBeInTheDocument();
  });

  it("leaves Comment mode on Esc", () => {
    draw("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Comment" })).toHaveAttribute("aria-pressed", "false");
  });

  it("has no Comment mode where there is no repository to keep threads with", () => {
    draw(null);
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
    expect(screen.getByText("The API")).toBeInTheDocument();
  });
});
