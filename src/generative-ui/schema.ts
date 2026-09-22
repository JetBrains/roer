/**
 * A minimal, A2UI-shaped wire format: enough to prototype one scenario, not
 * the full spec. Components are flat and id-referenced (A2UI's own choice,
 * for the same reason — an agent streams and patches a list more easily than
 * it edits a nested tree), and the client's catalog is a closed union: a
 * component type the catalog does not know is data the renderer refuses to
 * act on, never code it runs.
 */

export type ComponentId = string;

export type Justify = "start" | "center" | "end" | "spaceBetween";
export type Align = "start" | "center" | "end";
export type TextFieldType = "shortText" | "longText" | "number" | "obscured" | "date";

export type Component =
  // Layout
  | { id: ComponentId; type: "Row"; children: ComponentId[]; justify?: Justify; align?: Align }
  | { id: ComponentId; type: "Column"; children: ComponentId[]; justify?: Justify; align?: Align }
  | {
      id: ComponentId;
      type: "List";
      children: ComponentId[];
      direction?: "vertical" | "horizontal";
    }
  // Display
  | { id: ComponentId; type: "Text"; text: string; muted?: boolean }
  | { id: ComponentId; type: "Image"; url: string; alt?: string }
  | { id: ComponentId; type: "Icon"; name: string }
  | { id: ComponentId; type: "Divider" }
  | {
      id: ComponentId;
      type: "Arrow";
      direction?: "horizontal" | "vertical";
      label?: string;
    }
  // Interactive
  | { id: ComponentId; type: "Button"; label: string; action: string; primary?: boolean }
  | {
      id: ComponentId;
      type: "TextField";
      label: string;
      valuePath: string;
      textFieldType?: TextFieldType;
    }
  | { id: ComponentId; type: "Checkbox"; label: string; checkedPath: string }
  | { id: ComponentId; type: "Slider"; valuePath: string; minValue: number; maxValue: number }
  | {
      id: ComponentId;
      type: "DateTimeInput";
      valuePath: string;
      enableDate?: boolean;
      enableTime?: boolean;
    }
  | {
      id: ComponentId;
      type: "ChoicePicker";
      options: { label: string; value: string }[];
      selectionsPath: string;
      maxAllowedSelections?: number;
    }
  // Container
  | { id: ComponentId; type: "Card"; children: ComponentId[] }
  | { id: ComponentId; type: "ButtonRow"; children: ComponentId[] }
  | { id: ComponentId; type: "Modal"; entryPointChild: ComponentId; contentChild: ComponentId }
  | {
      id: ComponentId;
      type: "Expandable";
      title: string;
      child: ComponentId;
      defaultExpanded?: boolean;
    }
  | {
      id: ComponentId;
      type: "Tabs";
      tabItems: { title: string; child: ComponentId }[];
    };

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

/**
 * Runtime guard for a message read off the wire (a watcher event, a saved
 * bundle) — `A2uiMessage` is only a compile-time promise about that data,
 * never checked once it crosses an `invoke`/`listen`/JSON boundary. Checks
 * just enough shape (`kind` plus the fields every consumer indexes into) to
 * keep a malformed message from reaching the reducer or renderer.
 */
export function isA2uiMessage(value: unknown): value is A2uiMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.surfaceId !== "string") return false;
  switch (v.kind) {
    case "surfaceUpdate":
      return typeof v.root === "string" && Array.isArray(v.components);
    case "dataModelUpdate":
      return typeof v.patch === "object" && v.patch !== null;
    case "beginRendering":
      return true;
    default:
      return false;
  }
}

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
