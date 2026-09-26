import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { applyAll } from "./apply";
import { GenerativeSurface } from "./GenerativeSurface";
import { approvalGateMessages, SURFACE_ID } from "./fixtures";
import { A2UI_VERSION, type Component, type DataModel } from "./schema";

function draw(components: Component[], dataModel: DataModel = {}) {
  const state = applyAll([{ version: A2UI_VERSION, createSurface: { surfaceId: "s", components, dataModel } }]);
  const onSetValue = vi.fn();
  const onAction = vi.fn();
  render(
    <GenerativeSurface surface={state.surfaces.s} dataModel={state.dataModels.s} onSetValue={onSetValue} onAction={onAction} />,
  );
  return { onSetValue, onAction };
}

describe("GenerativeSurface", () => {
  it("waits for a root component", () => {
    draw([{ id: "other", component: "Divider" }] as Component[]);
    expect(screen.getByText(/Waiting for the surface's root/)).toBeInTheDocument();
  });

  it("binds text to the data model", () => {
    draw([{ id: "root", component: "Text", text: { path: "/user/name" } }], { user: { name: "Ada" } });
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("renders one template child per list element, with relative paths and @index", () => {
    draw(
      [
        { id: "root", component: "List", children: { componentId: "row", path: "/files" } },
        { id: "row", component: "Row", children: ["n", "name"] },
        { id: "n", component: "Text", text: { call: "@index", args: { offset: 1 } } },
        { id: "name", component: "Text", text: { path: "name" } },
      ],
      { files: [{ name: "a.ts" }, { name: "b.ts" }] },
    );
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("writes a templated checkbox back to its own element", () => {
    const { onSetValue } = draw(
      [
        { id: "root", component: "Column", children: { componentId: "box", path: "/files" } },
        { id: "box", component: "CheckBox", label: { path: "name" }, value: { path: "on" } },
      ],
      { files: [{ name: "a.ts", on: false }, { name: "b.ts", on: false }] },
    );
    fireEvent.click(screen.getByLabelText("b.ts"));
    expect(onSetValue).toHaveBeenCalledWith("/files/1/on", true);
  });

  it("resolves a button's event context at click time", () => {
    const { onAction } = draw(
      [
        { id: "root", component: "Button", child: "label", action: { event: { name: "go", context: { who: { path: "/user" }, n: 3 } } } },
        { id: "label", component: "Text", text: "Go" },
      ],
      { user: "ada" },
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onAction).toHaveBeenCalledWith({ name: "go", userMessage: undefined, context: { who: "ada", n: 3 } }, "root");
  });

  it("shows an unknown component as a placeholder", () => {
    draw([{ id: "root", component: "Script" } as unknown as Component]);
    expect(screen.getByText("[unsupported component: Script]")).toBeInTheDocument();
  });

  it("cuts a cycle instead of recursing", () => {
    draw([{ id: "root", component: "Card", child: "root" }]);
    expect(screen.getByText("[cyclic component: root]")).toBeInTheDocument();
  });

  it("passes accessibility through to ARIA", () => {
    draw([{ id: "root", component: "Text", text: "x", accessibility: { label: "Status", hidden: true } }]);
    const text = screen.getByText("x");
    expect(text).toHaveAttribute("aria-label", "Status");
    expect(text).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the approval-gate fixture", () => {
    const state = applyAll(approvalGateMessages);
    render(
      <GenerativeSurface
        surface={state.surfaces[SURFACE_ID]}
        dataModel={state.dataModels[SURFACE_ID]}
        onSetValue={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Apply 3 pending changes?")).toBeInTheDocument();
    expect(screen.getByLabelText(/watch\.rs/)).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply selected" })).toBeInTheDocument();
  });
});
