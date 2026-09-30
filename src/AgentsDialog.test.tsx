import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsDialog, joinArgs, splitArgs } from "./AgentsDialog";
import {
  agentCommand,
  agentModels,
  blankAgent,
  saveAgent,
  setDefaultAgent,
  type AgentList,
} from "./lib/agents";

vi.mock("./lib/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/agents")>()),
  agentCommand: vi.fn(),
  agentModels: vi.fn(),
  saveAgent: vi.fn(),
  removeAgent: vi.fn(),
  setDefaultAgent: vi.fn(),
}));

const cli = (id: string, efforts: string[], instructions: boolean) => ({
  id,
  label: id === "claude" ? "Claude Code" : "Codex",
  bin: id,
  installed: true,
  models: [],
  efforts,
  permissions: ["ask", "auto", "full"],
  instructions,
  resume: true,
});

const list: AgentList = {
  agents: [
    { ...blankAgent("claude"), id: "claude", name: "Claude Code", source: "builtin" },
    { ...blankAgent("codex"), id: "codex", name: "Codex", source: "builtin" },
  ],
  clis: [cli("claude", ["low", "high", "max"], true), cli("codex", ["minimal", "high", "xhigh"], false)],
  default: "claude",
  defaults: { user: null, project: null },
  project: true,
};

beforeEach(() => {
  vi.mocked(agentCommand).mockReset().mockResolvedValue("codex -c model_reasoning_effort=high");
  vi.mocked(agentModels).mockReset().mockResolvedValue(["gpt-5.5"]);
  vi.mocked(saveAgent)
    .mockReset()
    .mockImplementation(async (_cwd, agent, scope) => ({ ...agent, id: "reviewer", source: scope, path: "/p" }));
  vi.mocked(setDefaultAgent).mockReset().mockResolvedValue(undefined);
});

describe("AgentsDialog", () => {
  it("saves a new agent with only what its CLI takes, then starts it", async () => {
    const onStart = vi.fn();
    const onClose = vi.fn();
    render(
      <AgentsDialog
        list={list}
        cwd="/work"
        start={{ mode: "new" }}
        startAfterSave
        onChanged={async () => list}
        onStart={onStart}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/reviewer/), { target: { value: "Reviewer" } });
    fireEvent.click(screen.getByRole("radio", { name: "max" }));
    // Codex has no max effort, so switching to it drops the setting.
    fireEvent.click(screen.getByRole("radio", { name: /^Codex/ }));
    expect(screen.queryByRole("radio", { name: "max" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    fireEvent.click(screen.getByRole("radio", { name: "This project" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Make default" }));
    await screen.findByText("codex -c model_reasoning_effort=high");

    fireEvent.click(screen.getByRole("button", { name: "Save & start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("reviewer"));
    const [cwd, saved, scope] = vi.mocked(saveAgent).mock.calls[0];
    expect(cwd).toBe("/work");
    expect(scope).toBe("project");
    expect(saved).toMatchObject({ name: "Reviewer", cli: "codex", effort: "high" });
    expect(onClose).toHaveBeenCalled();
    // The default for the project it was shared in, not for everyone.
    expect(setDefaultAgent).toHaveBeenCalledWith("/work", "reviewer", "project");
  });

  it("never drops what a hand-written file asks for without being asked", async () => {
    vi.mocked(agentCommand).mockImplementation(async (agent) =>
      agent.effort === "max" ? Promise.reject("Codex takes effort minimal, high, xhigh") : "codex",
    );
    const handWritten = {
      ...blankAgent("codex"),
      id: "old",
      name: "Old",
      effort: "max",
      source: "user" as const,
      path: "/home/.roer/agents/old.md",
    };
    render(
      <AgentsDialog
        list={{ ...list, agents: [handWritten, ...list.agents] }}
        start={{ mode: "edit", id: "old" }}
        onChanged={async () => list}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("Old"), { target: { value: "Older" } });
    await screen.findByText(/takes effort/);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Drop what Codex can't take/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveAgent).toHaveBeenCalled());
    expect(vi.mocked(saveAgent).mock.calls[0][1]).toMatchObject({ name: "Older", effort: "" });
  });

  it("shows what the shim refuses instead of saving", async () => {
    vi.mocked(agentCommand).mockRejectedValue("a custom agent needs a command");
    render(
      <AgentsDialog
        list={list}
        start={{ mode: "new" }}
        onChanged={async () => list}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/reviewer/), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("radio", { name: "Custom…" }));
    await screen.findByText("a custom agent needs a command");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("extra arguments", () => {
  it("split the way a shell would and join back", () => {
    expect(splitArgs(`--search -c 'a b' ""`)).toEqual(["--search", "-c", "a b", ""]);
    expect(joinArgs(["--search", "a b"])).toBe(`--search "a b"`);
  });
});
