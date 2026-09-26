import { describe, expect, it } from "vitest";

import { applyAll } from "./apply";
import { dotToPointer, upgradeBundle } from "./legacy";

describe("upgradeBundle", () => {
  it("is undefined for something that isn't a v0.8 bundle", () => {
    expect(upgradeBundle({ surfaceUpdate: { version: "v1.0" } })).toBeUndefined();
  });

  it("turns the old approval gate into one createSurface", () => {
    const upgraded = upgradeBundle({
      surfaceUpdate: {
        kind: "surfaceUpdate",
        surfaceId: "gate",
        root: "card",
        components: [
          { id: "card", type: "Card", children: ["heading", "c1", "row"] },
          { id: "heading", type: "Text", text: "Apply?", muted: true },
          { id: "c1", type: "Checkbox", label: "watch.rs", checkedPath: "changes.watch" },
          { id: "row", type: "ButtonRow", children: ["ok"] },
          { id: "ok", type: "Button", label: "Apply", action: "approve", primary: true },
        ],
      },
      dataModelUpdate: { kind: "dataModelUpdate", surfaceId: "gate", patch: { changes: { watch: true } } },
    });
    expect(upgraded).toEqual({
      version: "v1.0",
      createSurface: {
        surfaceId: "gate",
        catalogId: "roer:catalog/1",
        sendDataModel: true,
        dataModel: { changes: { watch: true } },
        components: [
          { id: "root-column", component: "Column", children: ["heading", "c1", "row"] },
          { id: "root", component: "Card", child: "root-column" },
          { id: "heading", component: "Text", text: "Apply?", variant: "caption" },
          { id: "c1", component: "CheckBox", label: "watch.rs", value: { path: "/changes/watch" } },
          { id: "row", component: "Row", children: ["ok"], justify: "end" },
          { id: "ok-label", component: "Text", text: "Apply" },
          { id: "ok", component: "Button", child: "ok-label", action: { event: { name: "approve" } }, variant: "primary" },
        ],
      },
    });
    // And the result is something the v1.0 reducer takes as it is.
    expect(applyAll([upgraded!]).surfaces.gate.components.root.component).toBe("Card");
  });

  it("moves an existing 'root' out of the way of the old root", () => {
    const upgraded = upgradeBundle({
      surfaceUpdate: {
        kind: "surfaceUpdate",
        surfaceId: "s",
        root: "top",
        components: [
          { id: "top", type: "Column", children: ["root"] },
          { id: "root", type: "Text", text: "confusingly named" },
        ],
      },
    });
    expect(upgraded?.createSurface.components).toEqual([
      { id: "root", component: "Column", children: ["root-old"] },
      { id: "root-old", component: "Text", text: "confusingly named" },
    ]);
  });

  it("keeps date-and-time pickers picking both, now that both default off", () => {
    const upgraded = upgradeBundle({
      surfaceUpdate: {
        kind: "surfaceUpdate",
        surfaceId: "s",
        root: "d",
        components: [{ id: "d", type: "DateTimeInput", valuePath: "when", enableTime: false }],
      },
    });
    expect(upgraded?.createSurface.components?.[0]).toEqual({
      id: "root",
      component: "DateTimeInput",
      value: { path: "/when" },
      enableDate: true,
      enableTime: false,
    });
  });
});

describe("dotToPointer", () => {
  it("escapes what JSON Pointer reserves", () => {
    expect(dotToPointer("a.b/c.d~e")).toBe("/a/b~1c/d~0e");
  });
});
