import { beforeEach, describe, expect, it } from "vitest";

import {
  agentCommand,
  blankAgent,
  defaultAgentSettings,
  loadAgentSettings,
  newSessionArgs,
  saveAgentSettings,
  type SavedAgent,
} from "./agents";

const agent = (patch: Partial<SavedAgent>): SavedAgent => ({ ...blankAgent(), ...patch });

describe("agentCommand", () => {
  it("is the bare CLI when nothing is set", () => {
    expect(agentCommand(agent({ kind: "codex" }))).toBe("codex");
  });

  it("uses each CLI's own flags for model and reasoning", () => {
    expect(agentCommand(agent({ kind: "claude", model: "opus", effort: "high" }))).toBe(
      "claude --model opus --effort high",
    );
    expect(agentCommand(agent({ kind: "codex", model: "gpt-5-codex", effort: "xhigh" }))).toBe(
      "codex -m gpt-5-codex -c model_reasoning_effort=xhigh",
    );
    expect(agentCommand(agent({ kind: "junie", model: "sonnet", effort: "low" }))).toBe(
      "junie --model sonnet --effort low",
    );
    expect(agentCommand(agent({ kind: "pi", model: "openai/gpt-4o", effort: "off" }))).toBe(
      "pi --model openai/gpt-4o --thinking off",
    );
  });

  it("drops a reasoning level the CLI cannot take", () => {
    expect(agentCommand(agent({ kind: "gemini", model: "gemini-2.5-pro", effort: "high" }))).toBe(
      "gemini -m gemini-2.5-pro",
    );
  });

  it("quotes only what the shell would split", () => {
    expect(agentCommand(agent({ kind: "claude", model: "my model's" }))).toBe(
      `claude --model 'my model'\\''s'`,
    );
  });

  it("takes a command of its own, and extra flags as typed", () => {
    expect(
      agentCommand(agent({ kind: "claude", command: "~/bin/claude", extraArgs: "--permission-mode plan" })),
    ).toBe("~/bin/claude --permission-mode plan");
    expect(agentCommand(agent({ kind: "custom", command: "aider --no-git" }))).toBe("aider --no-git");
  });
});

describe("newSessionArgs", () => {
  it("passes the command to the shim, or asks for a shell", () => {
    expect(newSessionArgs(agent({ kind: "codex", model: "o3" }))).toEqual(["new", "--agent", "codex -m o3"]);
    expect(newSessionArgs(null)).toEqual(["new", "--shell"]);
  });
});

describe("agent settings", () => {
  beforeEach(() => localStorage.clear());

  it("starts with one of each CLI, Claude Code the default", () => {
    const settings = loadAgentSettings();
    expect(settings.agents.map((each) => each.kind)).toEqual(["claude", "codex", "junie", "gemini", "pi"]);
    expect(settings.defaultId).toBe("claude");
  });

  it("keeps what was saved, and a default that still exists", () => {
    const saved = defaultAgentSettings();
    saved.agents = [agent({ id: "deep", name: "Deep", kind: "codex", effort: "high" })];
    saved.defaultId = "gone";
    saveAgentSettings(saved);
    expect(loadAgentSettings()).toEqual({ agents: saved.agents, defaultId: "deep" });
  });

  it("falls back to the defaults on a corrupt entry", () => {
    localStorage.setItem("roer:agents", "{");
    expect(loadAgentSettings()).toEqual(defaultAgentSettings());
  });
});
