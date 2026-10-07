import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeSetup } from "./ClaudeSetup";
import { applyClaudeSetup, dismissClaudeSetup, type SetupStatus } from "./lib/claudeSetup";

vi.mock("./lib/claudeSetup", () => ({
  applyClaudeSetup: vi.fn(),
  dismissClaudeSetup: vi.fn(),
}));

const fresh: SetupStatus = { claudeCode: true, skills: false, sharedSkills: false, mcp: false, shouldPrompt: true };

beforeEach(() => {
  vi.mocked(applyClaudeSetup).mockReset().mockResolvedValue({ ...fresh, shouldPrompt: false });
  vi.mocked(dismissClaudeSetup).mockReset().mockResolvedValue(undefined);
});

const skillBox = () => screen.getByRole("checkbox", { name: /Claude Code skills/ });
const sharedBox = () => screen.getByRole("checkbox", { name: /Roer authoring guidance for Codex/ });
const mcpBox = () => screen.getByRole("checkbox", { name: /MCP server/ });

describe("the first-run setup", () => {
  it("offers all integrations ticked, and says where each one goes", () => {
    render(<ClaudeSetup status={fresh} firstRun onClose={() => undefined} />);

    expect(skillBox()).toBeChecked();
    expect(sharedBox()).toBeChecked();
    expect(mcpBox()).toBeChecked();
    expect(screen.getByRole("dialog")).toHaveTextContent("~/.claude/skills");
    expect(screen.getByRole("dialog")).toHaveTextContent("~/.agents/skills/roer-extension-authoring");
    expect(screen.getByRole("dialog")).toHaveTextContent("--scope user");
  });

  it("sets up only what stays ticked", async () => {
    const onClose = vi.fn();
    render(<ClaudeSetup status={fresh} firstRun onClose={onClose} />);

    fireEvent.click(mcpBox());
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(applyClaudeSetup).toHaveBeenCalledWith(true, true, false);
  });

  it("changes nothing on Not now, only stops asking", async () => {
    const onClose = vi.fn();
    render(<ClaudeSetup status={fresh} firstRun onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(dismissClaudeSetup).toHaveBeenCalled();
    expect(applyClaudeSetup).not.toHaveBeenCalled();
  });

  it("stays open and says why when setting up fails", async () => {
    vi.mocked(applyClaudeSetup).mockRejectedValue("claude mcp add-json: permission denied");
    const onClose = vi.fn();
    render(<ClaudeSetup status={fresh} firstRun onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Set up" }));

    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the setup from the menu", () => {
  const installed: SetupStatus = { claudeCode: true, skills: true, sharedSkills: true, mcp: true, shouldPrompt: false };

  it("shows what is set up now, and takes back what is unticked", async () => {
    const onClose = vi.fn();
    render(<ClaudeSetup status={installed} firstRun={false} onClose={onClose} />);

    expect(skillBox()).toBeChecked();
    expect(sharedBox()).toBeChecked();
    expect(mcpBox()).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    fireEvent.click(skillBox());
    fireEvent.click(mcpBox());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(applyClaudeSetup).toHaveBeenCalledWith(false, true, false);
  });

  it("closes on Cancel without changing anything or marking an answer", () => {
    const onClose = vi.fn();
    render(<ClaudeSetup status={fresh} firstRun={false} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(applyClaudeSetup).not.toHaveBeenCalled();
    expect(dismissClaudeSetup).not.toHaveBeenCalled();
  });

  it("still offers shared authoring without Claude Code", async () => {
    render(
      <ClaudeSetup
        status={{ claudeCode: false, skills: false, sharedSkills: false, mcp: false, shouldPrompt: false }}
        firstRun={false}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Claude Code was not found");
    expect(skillBox()).toBeDisabled();
    expect(mcpBox()).toBeDisabled();
    fireEvent.click(sharedBox());
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applyClaudeSetup).toHaveBeenCalledWith(false, true, false));
  });
});
