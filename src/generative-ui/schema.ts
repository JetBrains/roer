/**
 * A2UI v1.0 — the snapshot documented today, frozen (docs/pluginsspec.md §0).
 * Roer is both the agent side and the renderer, so there is nobody else's
 * build to track; a later revision would be a deliberate change here.
 *
 * Components are flat and id-referenced (A2UI's own choice, for the same
 * reason — an agent streams and patches a list more easily than it edits a
 * nested tree), and the catalog is a closed union: a component type the
 * catalog does not know is data the renderer refuses to act on, never code
 * it runs.
 */

import type { DiffNote } from "../lib/diff";

export const A2UI_VERSION = "v1.0";

/** Every surface's default catalog: A2UI's basic catalog plus Roer's own. */
export const ROER_CATALOG_ID = "roer:catalog/1";

export type ComponentId = string;
/** RFC 6901. Absolute from the data model's root, or — without the leading
 * `/` — relative to the current template item. */
export type JsonPointer = string;

export interface DataBinding {
  path: JsonPointer;
}

export interface FunctionCall {
  call: string;
  args?: Record<string, DynamicValue>;
  catalogId?: string;
}

export type DynamicValue =
  | string
  | number
  | boolean
  | unknown[]
  | Record<string, unknown>
  | DataBinding
  | FunctionCall;
export type DynamicString = string | DataBinding | FunctionCall;
export type DynamicNumber = number | DataBinding | FunctionCall;
export type DynamicBoolean = boolean | DataBinding | FunctionCall;
export type DynamicStringList = string[] | DataBinding | FunctionCall;
/** A list of records: literal, or bound to one in the data model. */
export type DynamicList = Record<string, unknown>[] | DataBinding;

/** A fixed list of child ids, or one template child per element of a list. */
export type ChildList = ComponentId[] | { componentId: ComponentId; path: JsonPointer };

export type Action =
  | {
      event: {
        name: string;
        userMessage?: DynamicString;
        context?: Record<string, DynamicValue>;
      };
    }
  | { functionCall: FunctionCall };

export interface CheckRule {
  condition: DataBinding | FunctionCall;
  message?: string;
}

export interface AccessibilityAttributes {
  label?: DynamicString;
  description?: DynamicString;
  live?: "off" | "polite" | "assertive";
  /** Hides from assistive technologies only — never from the screen. */
  hidden?: DynamicBoolean;
}

interface ComponentCommon {
  id: ComponentId;
  catalogId?: string;
  accessibility?: AccessibilityAttributes;
  metadata?: { extensions?: Record<string, unknown> };
  /** flex-grow inside a Row or Column. */
  weight?: number;
}

export type Justify =
  | "start"
  | "center"
  | "end"
  | "spaceBetween"
  | "spaceAround"
  | "spaceEvenly"
  | "stretch";
export type Align = "start" | "center" | "end" | "stretch";

type Variant<C extends string, P> = ComponentCommon & { component: C } & P;

export type Component =
  // A2UI basic catalog — layout
  | Variant<"Row", { children: ChildList; justify?: Justify; align?: Align }>
  | Variant<"Column", { children: ChildList; justify?: Justify; align?: Align }>
  | Variant<"List", { children: ChildList; direction?: "vertical" | "horizontal"; align?: Align }>
  | Variant<"Card", { child: ComponentId }>
  | Variant<"Tabs", { tabs: { title: DynamicString; child: ComponentId }[] }>
  | Variant<"Modal", { trigger: ComponentId; content: ComponentId }>
  | Variant<"Divider", { axis?: "horizontal" | "vertical" }>
  // A2UI basic catalog — display
  | Variant<"Text", { text: DynamicString; variant?: "caption" | "body" }>
  | Variant<
      "Image",
      {
        url: DynamicString;
        description?: DynamicString;
        fit?: "contain" | "cover" | "fill" | "none" | "scaleDown";
        variant?: "icon" | "avatar" | "smallFeature" | "mediumFeature" | "largeFeature" | "header";
      }
    >
  | Variant<"Icon", { name: DynamicString | { svgPath: DynamicString } }>
  | Variant<"Video", { url: DynamicString; posterUrl?: DynamicString }>
  | Variant<"AudioPlayer", { url: DynamicString; description?: DynamicString }>
  // A2UI basic catalog — input
  | Variant<
      "Button",
      { child: ComponentId; action: Action; variant?: "default" | "primary" | "borderless"; checks?: CheckRule[] }
    >
  | Variant<
      "TextField",
      {
        label: DynamicString;
        value?: DynamicString;
        placeholder?: DynamicString;
        variant?: "shortText" | "longText" | "number" | "obscured";
        checks?: CheckRule[];
      }
    >
  | Variant<"CheckBox", { label: DynamicString; value: DynamicBoolean; checks?: CheckRule[] }>
  | Variant<
      "ChoicePicker",
      {
        label?: DynamicString;
        variant?: "multipleSelection" | "mutuallyExclusive";
        options: { label: DynamicString; value: string }[];
        value: DynamicStringList;
        displayStyle?: "checkbox" | "chips";
        filterable?: boolean;
        checks?: CheckRule[];
      }
    >
  | Variant<
      "Slider",
      { label?: DynamicString; min?: number; max: number; value: DynamicNumber; steps?: number; checks?: CheckRule[] }
    >
  | Variant<
      "DateTimeInput",
      {
        value: DynamicString;
        enableDate?: boolean;
        enableTime?: boolean;
        min?: DynamicString;
        max?: DynamicString;
        label?: DynamicString;
        checks?: CheckRule[];
      }
    >
  // Roer's additions
  | Variant<"Arrow", { direction?: "horizontal" | "vertical"; label?: DynamicString }>
  | Variant<"Expandable", { title: DynamicString; child: ComponentId; defaultExpanded?: boolean }>
  /** Roer's own diff viewer, fed a whole `git diff` as text. */
  | Variant<
      "DiffView",
      {
        diff: DynamicString;
        title?: DynamicString;
        layout?: "unified" | "split";
        emptyText?: DynamicString;
        /** `{ path, line?, side?, text }[]`, drawn under the lines they are about. */
        notes?: DataBinding | DiffNote[];
      }
    >
  /** One task from any tracker — a GitHub issue, a YouTrack ticket, a Notion
   * card, or a personal task from Roer's own store — drawn the same way, so
   * a board can mix them. */
  | Variant<
      "WorkItem",
      {
        title: DynamicString;
        /** Where it lives: `github`, `youtrack`, `notion`, `jira`,
         * `personal`, or any other name, shown as it is. */
        source?: DynamicString;
        /** The tracker's own id: `#21`, `RO-12`, `T-3`. */
        key?: DynamicString;
        status?: DynamicString;
        /** An https link to the item; the title opens it in the browser. */
        url?: DynamicString;
        assignee?: DynamicString;
        labels?: DynamicStringList;
        /** One line of secondary text, e.g. when it last changed. */
        meta?: DynamicString;
        /** Controls under the item, e.g. a Row of Buttons that move it. */
        footer?: ComponentId;
        /** `card` (the default) for a board; `detail` opens the item up with
         * the fields below, which a card ignores. */
        variant?: "card" | "detail";
        goal?: DynamicString;
        /** `{ id, text, met }[]` — a checklist the user can tick. */
        requirements?: DynamicList;
        /** `{ kind: ticket | slack | doc | file, label, url?, path? }[]`. */
        sources?: DynamicList;
        /** `{ id, author, text, at? }[]`, read-only, oldest first. */
        comments?: DynamicList;
        /** `{ id, title, patch, notes? }[]`, each drawn with `DiffView`. */
        changes?: DynamicList;
        /** `{ id, severity: info | warn | error, text, at?, state? }[]`;
         * `at` is `{ changeId, path, line, side? }`. */
        findings?: DynamicList;
        /** `{ id, question, options: { label, value }[], answer? }[]`. */
        decisions?: DynamicList;
      }
    >
  // A work item's sections on their own, each `items` read as above.
  | Variant<"Requirements", { items: DynamicList }>
  | Variant<"Findings", { items: DynamicList }>
  | Variant<"Decisions", { items: DynamicList }>
  | Variant<"Sources", { items: DynamicList }>
  | Variant<"Comments", { items: DynamicList }>;

export interface SurfaceState {
  catalogId: string;
  components: Record<ComponentId, Component>;
  /** Echo the whole data model back with every action. */
  sendDataModel: boolean;
}

export type DataModel = Record<string, unknown>;

export interface CreateSurface {
  surfaceId: string;
  catalogId?: string;
  sendDataModel?: boolean;
  components?: Component[];
  dataModel?: DataModel;
  metadata?: { extensions?: Record<string, unknown> };
}

/** The agent-to-renderer messages this renderer acts on. The function-call
 * RPCs (`callRendererFunction`, `agentFunctionResponse`) are valid v1.0 but
 * come with the first renderer functions — until then they are dropped. */
export type A2uiMessage =
  | { version: typeof A2UI_VERSION; createSurface: CreateSurface }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: Component[] } }
  | {
      version: typeof A2UI_VERSION;
      updateDataModel: { surfaceId: string; path?: JsonPointer; value: unknown };
    }
  | { version: typeof A2UI_VERSION; deleteSurface: { surfaceId: string } };

export interface RenderState {
  surfaces: Record<string, SurfaceState>;
  dataModels: Record<string, DataModel>;
}

export const emptyState: RenderState = { surfaces: {}, dataModels: {} };

/** The surface a message is about. */
export function surfaceIdOf(message: A2uiMessage): string {
  if ("createSurface" in message) return message.createSurface.surfaceId;
  if ("updateComponents" in message) return message.updateComponents.surfaceId;
  if ("updateDataModel" in message) return message.updateDataModel.surfaceId;
  return message.deleteSurface.surfaceId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Runtime guard for a message read off the wire (a watcher event, a saved
 * bundle) — `A2uiMessage` is only a compile-time promise about that data,
 * never checked once it crosses an `invoke`/`listen`/JSON boundary. Checks
 * the envelope and just enough of the body (the fields every consumer
 * indexes into) to keep a malformed message from reaching the reducer.
 */
export function isA2uiMessage(value: unknown): value is A2uiMessage {
  if (!isRecord(value) || value.version !== A2UI_VERSION) return false;
  const keys = Object.keys(value).filter((key) => key !== "version");
  if (keys.length !== 1) return false;
  const body = value[keys[0]];
  if (!isRecord(body) || typeof body.surfaceId !== "string") return false;
  switch (keys[0]) {
    case "createSurface":
      return (
        (body.components === undefined || Array.isArray(body.components)) &&
        (body.dataModel === undefined || isRecord(body.dataModel))
      );
    case "updateComponents":
      return Array.isArray(body.components);
    case "updateDataModel":
      return "value" in body && (body.path === undefined || typeof body.path === "string");
    case "deleteSurface":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// JSON Pointer (RFC 6901)

/** Keys that would reach an object's prototype rather than its own data. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** The unescaped segments of a pointer. `""` and `"/"` are both the root. */
export function pointerSegments(pointer: JsonPointer): string[] {
  if (pointer === "" || pointer === "/") return [];
  const body = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  return body.split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A relative pointer resolved against the current template item, the way
 * A2UI's own data model does it; an absolute one is returned as is. */
export function resolvePointer(pointer: JsonPointer, scope?: JsonPointer): JsonPointer {
  if (pointer.startsWith("/")) return pointer;
  if (!scope || scope === "/") return `/${pointer}`;
  if (pointer === "") return scope;
  return `${scope.endsWith("/") ? scope : `${scope}/`}${pointer}`;
}

/** Reads a pointer (`"/files/0/include"`) out of a data model. */
export function readPointer(model: unknown, pointer: JsonPointer): unknown {
  let value: unknown = model;
  for (const key of pointerSegments(pointer)) {
    if (FORBIDDEN.has(key) || value === undefined || value === null || typeof value !== "object") {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Writes a pointer without mutating the model it was given. `null` (or
 * `undefined`) deletes the key, as `updateDataModel` defines it. Arrays stay
 * arrays; a missing container is created as an object.
 */
export function writePointer(model: DataModel, pointer: JsonPointer, value: unknown): DataModel {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return isRecord(value) ? value : {};
  if (segments.some((key) => FORBIDDEN.has(key))) return model;
  return writeAt(model, segments, value) as DataModel;
}

function writeAt(container: unknown, [head, ...rest]: string[], value: unknown): unknown {
  const remove = value === null || value === undefined;
  if (Array.isArray(container)) {
    const index = head === "-" ? container.length : Number(head);
    if (!Number.isInteger(index) || index < 0) return container;
    const next = [...container];
    if (rest.length > 0) next[index] = writeAt(next[index], rest, value);
    else if (remove) next.splice(index, 1);
    else next[index] = value;
    return next;
  }
  const base = isRecord(container) ? container : {};
  if (rest.length > 0) return { ...base, [head]: writeAt(base[head], rest, value) };
  if (remove) {
    const { [head]: _gone, ...kept } = base;
    return kept;
  }
  return { ...base, [head]: value };
}
