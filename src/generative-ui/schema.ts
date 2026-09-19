/**
 * A minimal, A2UI-shaped wire format: enough to prototype one scenario, not
 * the full spec. Components are flat and id-referenced (A2UI's own choice,
 * for the same reason — an agent streams and patches a list more easily than
 * it edits a nested tree), and the client's catalog is a closed union: a
 * component type the catalog does not know is data the renderer refuses to
 * act on, never code it runs.
 */

export type ComponentId = string;

export type Component =
  | { id: ComponentId; type: "Card"; children: ComponentId[] }
  | { id: ComponentId; type: "Text"; text: string; muted?: boolean }
  | { id: ComponentId; type: "Divider" }
  | { id: ComponentId; type: "Checkbox"; label: string; checkedPath: string }
  | { id: ComponentId; type: "ButtonRow"; children: ComponentId[] }
  | { id: ComponentId; type: "Button"; label: string; action: string; primary?: boolean };

export interface SurfaceState {
  root?: ComponentId;
  components: Record<ComponentId, Component>;
  rendering: boolean;
}

export type DataModel = Record<string, unknown>;

/** The three message kinds this prototype speaks — A2UI's own names. */
export type A2uiMessage =
  | { kind: "surfaceUpdate"; surfaceId: string; root: ComponentId; components: Component[] }
  | { kind: "dataModelUpdate"; surfaceId: string; patch: DataModel }
  | { kind: "beginRendering"; surfaceId: string };

export interface RenderState {
  surfaces: Record<string, SurfaceState>;
  dataModels: Record<string, DataModel>;
}

export const emptyState: RenderState = { surfaces: {}, dataModels: {} };

/** Reads a dot path (`"files.0.include"`) out of a data model. */
export function readPath(model: DataModel, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === undefined || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, model);
}

/** Writes a dot path, without mutating the model it was given. */
export function writePath(model: DataModel, path: string, value: unknown): DataModel {
  const [head, ...rest] = path.split(".");
  if (rest.length === 0) return { ...model, [head]: value };
  const child = (model[head] as DataModel | undefined) ?? {};
  return { ...model, [head]: writePath(child, rest.join("."), value) };
}
