import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadPeopleContext } from "../Threads";
import type { Session } from "../extensions/api";
import { allThreads, replyToThread } from "../lib/threads";
import { applyAll } from "./apply";
import { CommentScope } from "./Commentable";
import { GenerativeSurface } from "./GenerativeSurface";
import { A2UI_VERSION, type Component } from "./schema";

const components: Component[] = [
  { id: "root", component: "Column", children: ["api", "db", "plain"] },
  { id: "api", component: "Commentable", label: "API", child: "apiText" },
  { id: "apiText", component: "Text", text: "The API" },
  { id: "db", component: "Commentable", label: "Database", child: "dbText" },
  { id: "dbText", component: "Text", text: "The database" },
  { id: "plain", component: "Text", text: "Not commentable" },
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

function draw(root: string | null, staged: Session | null = stage()) {
  const state = applyAll([{ version: A2UI_VERSION, createSurface: { surfaceId: "arch", components, dataModel: {} } }]);
  render(
    <ThreadPeopleContext.Provider value={{ stage: staged }}>
      <CommentScope root={root} view="ui:arch" title="Architecture">
        <GenerativeSurface surface={state.surfaces.arch} dataModel={state.dataModels.arch} onSetValue={vi.fn()} onAction={vi.fn()} />
      </CommentScope>
    </ThreadPeopleContext.Provider>,
  );
  return staged;
}

beforeEach(() => localStorage.clear());

describe("Commentable", () => {
  it("comments on two parts at once, Shift-clicking the second, and sends one prompt about both", async () => {
    const staged = draw("/repo")!;
    fireEvent.click(screen.getByRole("button", { name: "Comment on API" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment on Database" }), { shiftKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on API and Database" }), { target: { value: "How do these talk?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to claude" }));

    await waitFor(() => expect(staged.send).toHaveBeenCalledTimes(1));
    const prompt = vi.mocked(staged.send).mock.calls[0][0];
    expect(prompt).toContain('- "API" (`api`)');
    expect(prompt).toContain('- "Database" (`db`)');
    expect(allThreads()[0]).toMatchObject({ root: "/repo", view: "ui:arch", viewTitle: "Architecture" });

    // It shows on both parts; opening it on one lights up the other.
    expect(screen.getByRole("button", { name: "1 open of 1 thread on API" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 open of 1 thread on API" }));
    fireEvent.click(screen.getByRole("button", { name: "1 open of 1 thread on API" }));
    fireEvent.click(screen.getByRole("button", { name: "1 open of 1 thread on Database" }));
    expect(screen.getByText("How do these talk?")).toBeInTheDocument();
    expect(document.querySelector('[data-part="api"]')).toHaveClass("linked");

    act(() => void replyToThread(allThreads()[0].id, "Claude", "Over HTTP.", false));
    expect(await screen.findByText("Over HTTP.")).toBeInTheDocument();
  });

  it("draws the parts without comments where there is no repository to keep them with", () => {
    draw(null);
    expect(screen.getByText("The API")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comment on API" })).not.toBeInTheDocument();
  });
});
