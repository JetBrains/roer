import { describe, expect, it } from "vitest";

import { applyAll, applyMessage } from "./apply";
import { approvalGateMessages, SURFACE_ID } from "./fixtures";
import { emptyState, readPath, writePath } from "./schema";

describe("applyMessage", () => {
  it("does not render until beginRendering arrives", () => {
    const afterUpdate = applyMessage(emptyState, {
      kind: "surfaceUpdate",
      surfaceId: "s",
      root: "a",
      components: [{ id: "a", type: "Text", text: "hi" }],
    });
    expect(afterUpdate.surfaces.s.rendering).toBe(false);

    const afterBegin = applyMessage(afterUpdate, { kind: "beginRendering", surfaceId: "s" });
    expect(afterBegin.surfaces.s.rendering).toBe(true);
  });

  it("merges a second surfaceUpdate onto the first component-by-component", () => {
    const first = applyMessage(emptyState, {
      kind: "surfaceUpdate",
      surfaceId: "s",
      root: "a",
      components: [
        { id: "a", type: "Card", children: ["b"] },
        { id: "b", type: "Text", text: "streaming…" },
      ],
    });
    const patched = applyMessage(first, {
      kind: "surfaceUpdate",
      surfaceId: "s",
      root: "a",
      components: [{ id: "b", type: "Text", text: "done" }],
    });
    expect(patched.surfaces.s.components.a.type).toBe("Card");
    expect((patched.surfaces.s.components.b as { text: string }).text).toBe("done");
  });

  it("merges dataModelUpdate patches instead of replacing the model", () => {
    const first = applyMessage(emptyState, {
      kind: "dataModelUpdate",
      surfaceId: "s",
      patch: { changes: { a: true, b: false } },
    });
    const second = applyMessage(first, {
      kind: "dataModelUpdate",
      surfaceId: "s",
      patch: { changes: { b: true } },
    });
    expect(second.dataModels.s).toEqual({ changes: { a: true, b: true } });
  });

  it("ignores beginRendering for a surface that was never updated", () => {
    const state = applyMessage(emptyState, { kind: "beginRendering", surfaceId: "ghost" });
    expect(state.surfaces.ghost).toBeUndefined();
  });
});

describe("readPath / writePath", () => {
  it("round-trips a dotted path without disturbing siblings", () => {
    const model = writePath({ changes: { watch: true } }, "changes.tabs", false);
    expect(readPath(model, "changes.watch")).toBe(true);
    expect(readPath(model, "changes.tabs")).toBe(false);
  });
});

describe("the approval-gate fixture", () => {
  it("renders with every change checked by default", () => {
    const state = applyAll(approvalGateMessages);
    const surface = state.surfaces[SURFACE_ID];
    expect(surface.rendering).toBe(true);
    expect(surface.root).toBe("card");
    expect(readPath(state.dataModels[SURFACE_ID], "changes.watch")).toBe(true);
  });
});
