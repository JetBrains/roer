import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewTabDialog, SECTION_IDEAS, TAB_IDEAS, newSectionPrompt, newTabPrompt } from "./NewTabDialog";
import { resetAskAgent, useAskAgent, type AgentState } from "./lib/askAgent";
import { sendToSession } from "./lib/github";

vi.mock("./lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/github")>()),
  sendToSession: vi.fn().mockResolvedValue(undefined),
}));

/** The dialog the way App holds it: the asking outlives the dialog. */
function Host({ agentState, pane = "%3", kind }: { agentState?: AgentState; pane?: string; kind?: "tab" | "section" }) {
  const agent = useAskAgent(pane, agentState);
  const [open, setOpen] = useState(true);
  return open ? <NewTabDialog agent={agent} agentState={agentState} kind={kind} onClose={() => setOpen(false)} /> : null;
}

describe("NewTabDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAskAgent();
  });

  it("asks the waiting agent for a tab, from an idea or the person's own words", async () => {
    render(<Host agentState="done" />);
    fireEvent.click(screen.getByRole("button", { name: TAB_IDEAS[0] }));
    expect(screen.getByRole("textbox", { name: "What the tab shows" })).toHaveValue(TAB_IDEAS[0]);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%3", newTabPrompt(TAB_IDEAS[0]!)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(newTabPrompt("x")).toContain("roer-extension-authoring");
  });

  it("asks for a section of the Workspace tab, with ideas about all of its projects", async () => {
    render(<Host agentState="done" kind="section" />);
    expect(screen.getByRole("dialog", { name: "New section" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: SECTION_IDEAS[0] }));
    expect(screen.getByRole("textbox", { name: "What the section shows" })).toHaveValue(SECTION_IDEAS[0]);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%3", newSectionPrompt(SECTION_IDEAS[0]!)));
    expect(newSectionPrompt("x")).toContain("roer.workspace.registerSection");
    expect(newSectionPrompt("x")).toContain("useScope()");
  });

  it("holds the request while the agent works and sends it once it waits, after the dialog is closed", async () => {
    const { rerender } = render(<Host agentState="working" />);
    expect(screen.getByText(/The agent is busy, so this waits/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "What the tab shows" }), { target: { value: "the weather" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask when it is ready" }));
    expect(await screen.findByText(/gets this as soon as it is waiting/)).toBeInTheDocument();
    // What waits is listed, with a way to send it now or drop it.
    expect(screen.getByText("a tab that shows the weather")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send now" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(sendToSession).not.toHaveBeenCalled();

    rerender(<Host agentState="done" />);
    await waitFor(() => expect(sendToSession).toHaveBeenCalledWith("%3", newTabPrompt("the weather")));
  });

  it("cannot ask with no agent in the session", () => {
    render(<Host />);
    fireEvent.change(screen.getByRole("textbox", { name: "What the tab shows" }), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Ask the agent" })).toBeDisabled();
    expect(screen.getByText(/No agent here to ask/)).toBeInTheDocument();
  });
});
