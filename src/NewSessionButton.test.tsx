import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewSessionButton } from "./NewSessionButton";

describe("the agent picker", () => {
  it("says why it has no agents, instead of looking for them forever", async () => {
    render(
      <NewSessionButton
        projects={[]}
        openNew={vi.fn()}
        pickingProjectFor={null}
        cancelProjectPick={vi.fn()}
        pickProjectForNewSession={vi.fn()}
        attachNewProjectForNewSession={vi.fn()}
        agents={null}
        agentsError={"unknown command: agents\nroer — session host for agent terminals"}
        pickerOpen
      />,
    );
    expect(await screen.findByText("Could not list agents: unknown command: agents")).toBeInTheDocument();
    expect(screen.queryByText("Looking for agents…")).not.toBeInTheDocument();
  });
});
