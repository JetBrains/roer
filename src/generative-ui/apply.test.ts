import { describe, expect, it } from "vitest";

import { applyAll, applyMessage } from "./apply";
import { approvalGateMessages, SURFACE_ID } from "./fixtures";
import {
  A2UI_VERSION,
  emptyState,
  isA2uiMessage,
  readPointer,
  resolvePointer,
  writePointer,
  type A2uiMessage,
} from "./schema";

const v = A2UI_VERSION;
const create = (surfaceId: string, extra: object = {}): A2uiMessage => ({
  version: v,
  createSurface: { surfaceId, ...extra },
});

describe("applyMessage", () => {
  it("creates a surface with its components and data model inline", () => {
    const state = applyMessage(
      emptyState,
      create("s", { components: [{ id: "root", component: "Text", text: "hi" }], dataModel: { a: 1 } }),
    );
    expect(state.surfaces.s.catalogId).toBe("roer:catalog/1");
    expect(state.surfaces.s.components.root.component).toBe("Text");
    expect(state.dataModels.s).toEqual({ a: 1 });
  });

  it("upserts updateComponents onto the existing tree component-by-component", () => {
    const first = applyAll([
      create("s"),
      {
        version: v,
        updateComponents: {
          surfaceId: "s",
          components: [
            { id: "root", component: "Card", child: "b" },
            { id: "b", component: "Text", text: "streaming…" },
          ],
        },
      },
    ]);
    const patched = applyMessage(first, {
      version: v,
      updateComponents: { surfaceId: "s", components: [{ id: "b", component: "Text", text: "done" }] },
    });
    expect(patched.surfaces.s.components.root.component).toBe("Card");
    expect((patched.surfaces.s.components.b as { text: string }).text).toBe("done");
  });

  it("sets a value at a path, and replaces the whole model without one", () => {
    const base = applyMessage(emptyState, create("s", { dataModel: { changes: { a: true, b: false } } }));
    const set = applyMessage(base, { version: v, updateDataModel: { surfaceId: "s", path: "/changes/b", value: true } });
    expect(set.dataModels.s).toEqual({ changes: { a: true, b: true } });

    const replaced = applyMessage(set, { version: v, updateDataModel: { surfaceId: "s", value: { fresh: 1 } } });
    expect(replaced.dataModels.s).toEqual({ fresh: 1 });
  });

  it("deletes the key when the value is null", () => {
    const base = applyMessage(emptyState, create("s", { dataModel: { a: 1, b: 2 } }));
    const next = applyMessage(base, { version: v, updateDataModel: { surfaceId: "s", path: "/a", value: null } });
    expect(next.dataModels.s).toEqual({ b: 2 });
  });

  it("ignores updates for a surface that was never created", () => {
    const state = applyAll([
      { version: v, updateComponents: { surfaceId: "ghost", components: [{ id: "root", component: "Divider" }] } },
      { version: v, updateDataModel: { surfaceId: "ghost", value: {} } },
    ]);
    expect(state).toEqual(emptyState);
  });

  it("deleteSurface drops the surface and its data", () => {
    const state = applyAll([create("s", { dataModel: { a: 1 } }), { version: v, deleteSurface: { surfaceId: "s" } }]);
    expect(state).toEqual(emptyState);
  });
});

describe("isA2uiMessage", () => {
  it("accepts a v1.0 envelope and nothing older", () => {
    expect(isA2uiMessage({ version: "v1.0", createSurface: { surfaceId: "s" } })).toBe(true);
    expect(isA2uiMessage({ kind: "surfaceUpdate", surfaceId: "s", root: "a", components: [] })).toBe(false);
    expect(isA2uiMessage({ version: "v0.9", createSurface: { surfaceId: "s" } })).toBe(false);
  });

  it("requires updateDataModel to carry a value, even a null one", () => {
    expect(isA2uiMessage({ version: "v1.0", updateDataModel: { surfaceId: "s", path: "/a" } })).toBe(false);
    expect(isA2uiMessage({ version: "v1.0", updateDataModel: { surfaceId: "s", path: "/a", value: null } })).toBe(true);
  });

  it("rejects two message bodies in one envelope", () => {
    expect(
      isA2uiMessage({ version: "v1.0", createSurface: { surfaceId: "s" }, deleteSurface: { surfaceId: "s" } }),
    ).toBe(false);
  });
});

describe("JSON Pointer", () => {
  it("round-trips a path without disturbing siblings", () => {
    const model = writePointer({ changes: { watch: true } }, "/changes/tabs", false);
    expect(readPointer(model, "/changes/watch")).toBe(true);
    expect(readPointer(model, "/changes/tabs")).toBe(false);
  });

  it("unescapes ~1 and ~0", () => {
    expect(readPointer({ "a/b": { "c~d": 1 } }, "/a~1b/c~0d")).toBe(1);
  });

  it("keeps arrays as arrays", () => {
    const model = writePointer({ files: [{ on: false }, { on: false }] }, "/files/1/on", true);
    expect(model).toEqual({ files: [{ on: false }, { on: true }] });
  });

  it("never reaches the prototype", () => {
    expect(readPointer({}, "/__proto__/polluted")).toBeUndefined();
    const model = writePointer({}, "/__proto__/polluted", true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(model).toEqual({});
  });

  it("resolves a relative path against the template item", () => {
    expect(resolvePointer("name", "/files/2")).toBe("/files/2/name");
    expect(resolvePointer("/top", "/files/2")).toBe("/top");
    expect(resolvePointer("name")).toBe("/name");
  });
});

describe("the approval-gate fixture", () => {
  it("renders with every change checked by default", () => {
    const state = applyAll(approvalGateMessages);
    expect(state.surfaces[SURFACE_ID].components.root.component).toBe("Card");
    expect(readPointer(state.dataModels[SURFACE_ID], "/changes/watch")).toBe(true);
  });
});
