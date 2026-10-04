import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitCommitAll } from "../../lib/git";
import { onCommitDraft, type PrDraftRecord } from "../../lib/github";
import { CommitBox } from "./CommitBox";

vi.mock("../../lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git")>()),
  gitCommitAll: vi.fn(),
}));
vi.mock("../../lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/github")>()),
  onCommitDraft: vi.fn(),
}));

let drafted: ((record: PrDraftRecord) => void) | null = null;

beforeEach(() => {
  vi.mocked(gitCommitAll).mockReset().mockResolvedValue("abc1234");
  vi.mocked(onCommitDraft).mockImplementation(async (handler) => {
    drafted = handler;
    return () => {
      drafted = null;
    };
  });
});

const box = (over: Partial<React.ComponentProps<typeof CommitBox>> = {}) => {
  const props = {
    root: "/repo",
    pane: "%1",
    send: vi.fn().mockResolvedValue(undefined),
    agent: "Claude",
    unsent: 0,
    onCommitted: vi.fn(),
    onSent: vi.fn(),
    ...over,
  };
  render(<CommitBox {...props} />);
  return props;
};

describe("CommitBox", () => {
  it("asks the agent for a message when there is none, and commits only once it has been read", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const props = box({ send });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toContain("roer commit-draft --pane %1");
    expect(send.mock.calls[0][0]).toContain("under 72 characters");
    expect(props.onSent).toHaveBeenCalled();
    expect(gitCommitAll).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Waiting for Claude…" })).toBeDisabled();

    act(() => drafted?.({ pane: "%9", kind: "commit", draft: { title: "Someone else's", body: "" } }));
    expect(screen.getByLabelText("Commit message")).toHaveValue("");
    act(() => drafted?.({ pane: "%1", kind: "commit", draft: { title: "Fold the PR tab in", body: "Why, briefly." } }));
    expect(screen.getByLabelText("Commit message")).toHaveValue("Fold the PR tab in\n\nWhy, briefly.");

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(props.onCommitted).toHaveBeenCalledWith("abc1234"));
    expect(gitCommitAll).toHaveBeenCalledWith("/repo", "Fold the PR tab in\n\nWhy, briefly.");
    expect(screen.getByLabelText("Commit message")).toHaveValue("");
  });

  it("asks before committing over comments that have not been sent", async () => {
    const props = box({ unsent: 2 });
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "Fix it" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(screen.getByText(/2 comments on these changes have not been sent/)).toBeInTheDocument();
    expect(gitCommitAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Commit anyway" }));
    await waitFor(() => expect(props.onCommitted).toHaveBeenCalled());
  });

  it("shows what a hook said and keeps the message", async () => {
    vi.mocked(gitCommitAll).mockRejectedValue("lint failed: 3 problems");
    const props = box();
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "Fix it" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("lint failed");
    expect(screen.getByLabelText("Commit message")).toHaveValue("Fix it");
    expect(props.onCommitted).not.toHaveBeenCalled();
  });

  it("needs a message typed when there is no agent to write one", () => {
    box({ send: undefined });
    expect(screen.queryByRole("button", { name: /Draft with/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });
});
