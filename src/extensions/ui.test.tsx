import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import types from "../../cli/src/ext/roer.d.ts?raw";
import * as ui from "./ui";

vi.mock("../lib/github", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

describe("roer/ui", () => {
  it("exports every component its declarations promise", () => {
    const module = types.slice(types.indexOf('declare module "roer/ui"'));
    const declared = [...module.matchAll(/export function (\w+)/g)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(20);
    for (const name of declared) expect(ui, name).toHaveProperty(name);
  });

  it("draws the components a surface is made of, from JSX", () => {
    const retry = vi.fn();
    render(
      <ui.StatusCard
        title="Proxy"
        status="running"
        footer={
          <ui.Button variant="primary" onClick={retry}>
            Retry
          </ui.Button>
        }
      />,
    );
    expect(screen.getByText("running")).toHaveClass("gen-status-card-status", "doing");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });

  it("names a bare text field by its placeholder and submits it on Enter", () => {
    const submit = vi.fn();
    render(<ui.TextField variant="search" placeholder="City" value="Amsterdam" onChange={vi.fn()} onSubmit={submit} />);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "City" }), { key: "Enter" });
    expect(submit).toHaveBeenCalled();
  });

  it("draws JSX cells in a table", () => {
    render(
      <ui.Table
        columns={[{ key: "name", title: "Name" }, { key: "state", title: "State" }]}
        rows={[{ name: "Proxy", state: <ui.Badge tone="success">running</ui.Badge> }]}
      />,
    );
    expect(screen.getByText("running")).toHaveClass("gen-badge", "success");
  });

  it("draws catalog JSON in a Surface and hands its events to the tab", () => {
    const onAction = vi.fn();
    const onDataChange = vi.fn();
    render(
      <ui.Surface
        components={[
          { id: "root", component: "Column", children: ["name", "field", "go"] },
          { id: "name", component: "Text", text: { path: "/name" } },
          { id: "field", component: "TextField", label: "Name", value: { path: "/name" } },
          { id: "go", component: "Button", child: "go-label", action: { event: { name: "greet", context: { who: { path: "/name" } } } } },
          { id: "go-label", component: "Text", text: "Greet" },
        ]}
        data={{ name: "Ada" }}
        onAction={onAction}
        onDataChange={onDataChange}
      />,
    );
    expect(screen.getByText("Ada")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grace" } });
    expect(onDataChange).toHaveBeenCalledWith({ name: "Grace" });
    expect(screen.getByText("Grace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Greet" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ name: "greet", context: { who: "Grace" } }));
  });
});
