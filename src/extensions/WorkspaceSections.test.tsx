import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { defineExtension, type Scope } from "./api";
import { useScope } from "./context";
import { registry } from "./registry";
import { WorkspaceSections } from "./WorkspaceSections";

const work: Scope = {
  kind: "workspace",
  id: "w1",
  name: "work",
  projects: [
    { name: "api", path: "/work/api" },
    { name: "web", path: "/work/web" },
  ],
  folder: "/work",
};
const api: Scope = { kind: "project", id: "p1", name: "api", projects: [{ name: "api", path: "/work/api" }], folder: null };

function Repos() {
  const scope = useScope();
  const [clicks, setClicks] = useState(0);
  return (
    <div>
      <p>
        {scope?.kind} {scope?.name}: {scope?.projects.map((project) => project.path).join(", ")} in {scope?.folder ?? "no folder"}
      </p>
      <button type="button" onClick={() => setClicks((n) => n + 1)}>
        clicked {clicks}
      </button>
    </div>
  );
}

function Broken(): null {
  throw new Error("no data");
}

const sections = (scope: Scope) => (
  <WorkspaceSections scope={scope} session={null} active openFile={() => undefined} activateTab={() => undefined} />
);

describe("Workspace tab sections", () => {
  afterEach(() => {
    registry.unload("repos");
    registry.unload("broken");
  });

  it("tells a section which Workspace or Project it is about, and starts it over for another", () => {
    registry.load("repos", defineExtension((roer) => void roer.workspace.registerSection({ id: "list", title: "Repositories", component: Repos })));
    const { rerender } = render(sections(work));

    expect(screen.getByRole("region", { name: "Repositories" })).toHaveTextContent("Repositories");
    expect(screen.getByText("workspace work: /work/api, /work/web in /work")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "clicked 0" }));
    expect(screen.getByRole("button", { name: "clicked 1" })).toBeInTheDocument();

    rerender(sections(api));
    expect(screen.getByText("project api: /work/api in no folder")).toBeInTheDocument();
    // What it held for the Workspace is not the Project's.
    expect(screen.getByRole("button", { name: "clicked 0" })).toBeInTheDocument();
  });

  it("keeps a section that fails to itself", () => {
    registry.load("broken", defineExtension((roer) => void roer.workspace.registerSection({ id: "x", title: "Broken", component: Broken })));
    registry.load("repos", defineExtension((roer) => void roer.workspace.registerSection({ id: "list", title: "Repositories", component: Repos })));
    render(sections(work));

    expect(screen.getByRole("region", { name: "Broken" })).toHaveTextContent("broken failed: no data");
    expect(screen.getByText(/workspace work/)).toBeInTheDocument();
  });
});
