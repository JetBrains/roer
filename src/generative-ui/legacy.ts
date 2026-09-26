/**
 * One-shot upgrade for plugin-UI bundles saved before A2UI v1.0: a v0.8-era
 * `surfaceUpdate` (plus its optional `dataModelUpdate`) becomes the single
 * `createSurface` that builds the same UI now. It runs when a bundle is read
 * and the result is written back, so the old shape never lives on beside the
 * new one (docs/pluginsspec.md §0).
 *
 * Only bundles go through here. A live message in the old shape is simply
 * not a message any more.
 */
import { A2UI_VERSION, ROER_CATALOG_ID, type A2uiMessage, type Component, type DataModel } from "./schema";

export interface LegacyBundle {
  surfaceUpdate: unknown;
  dataModelUpdate?: unknown;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `"changes.watch"` → `"/changes/watch"`, escaped per RFC 6901. */
export const dotToPointer = (path: string): string =>
  `/${path
    .split(".")
    .map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;

const bind = (path: unknown) => ({ path: dotToPointer(String(path ?? "")) });

/** Returns `undefined` when `legacy` isn't a v0.8 bundle at all. */
export function upgradeBundle(legacy: LegacyBundle): Extract<A2uiMessage, { createSurface: unknown }> | undefined {
  const surface = legacy.surfaceUpdate;
  if (!isRecord(surface) || typeof surface.surfaceId !== "string" || !Array.isArray(surface.components)) {
    return undefined;
  }
  const old = surface.components.filter(isRecord);
  const oldRoot = typeof surface.root === "string" ? surface.root : undefined;

  // v1.0's surface always starts at "root", so the old root takes that id,
  // and whatever was already called "root" steps aside.
  const taken = new Set(old.map((c) => String(c.id)));
  const fresh = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  const rename = new Map<string, string>();
  if (oldRoot && oldRoot !== "root") {
    if (taken.has("root")) rename.set("root", fresh("root-old"));
    rename.set(oldRoot, "root");
  }
  const ref = (id: unknown) => rename.get(String(id)) ?? String(id);
  const refs = (ids: unknown) => (Array.isArray(ids) ? ids.map(ref) : []);

  const components: Component[] = [];
  const add = (component: Raw) => components.push(component as unknown as Component);

  for (const c of old) {
    const id = ref(c.id);
    switch (c.type) {
      case "Row":
      case "Column":
      case "List":
        add({ id, component: c.type, children: refs(c.children), ...pick(c, ["justify", "align", "direction"]) });
        break;
      case "Text":
        add({ id, component: "Text", text: String(c.text ?? ""), ...(c.muted ? { variant: "caption" } : {}) });
        break;
      case "Image":
        add({ id, component: "Image", url: String(c.url ?? ""), ...(c.alt ? { description: String(c.alt) } : {}) });
        break;
      case "Icon":
        add({ id, component: "Icon", name: String(c.name ?? "") });
        break;
      case "Divider":
        add({ id, component: "Divider" });
        break;
      case "Arrow":
        add({ id, component: "Arrow", ...pick(c, ["direction", "label"]) });
        break;
      case "Button": {
        const label = fresh(`${id}-label`);
        add({ id: label, component: "Text", text: String(c.label ?? "") });
        add({
          id,
          component: "Button",
          child: label,
          action: { event: { name: String(c.action ?? "") } },
          ...(c.primary ? { variant: "primary" } : {}),
        });
        break;
      }
      case "TextField":
        if (c.textFieldType === "date") {
          add({ id, component: "DateTimeInput", label: String(c.label ?? ""), value: bind(c.valuePath), enableDate: true });
        } else {
          add({
            id,
            component: "TextField",
            label: String(c.label ?? ""),
            value: bind(c.valuePath),
            ...(c.textFieldType ? { variant: c.textFieldType } : {}),
          });
        }
        break;
      case "Checkbox":
        add({ id, component: "CheckBox", label: String(c.label ?? ""), value: bind(c.checkedPath) });
        break;
      case "Slider":
        add({ id, component: "Slider", value: bind(c.valuePath), min: c.minValue ?? 0, max: c.maxValue ?? 100 });
        break;
      case "DateTimeInput":
        // Both flags used to default to on; in v1.0 they default to off.
        add({
          id,
          component: "DateTimeInput",
          value: bind(c.valuePath),
          enableDate: c.enableDate !== false,
          enableTime: c.enableTime !== false,
        });
        break;
      case "ChoicePicker":
        add({
          id,
          component: "ChoicePicker",
          options: Array.isArray(c.options) ? c.options : [],
          value: bind(c.selectionsPath),
          variant: c.maxAllowedSelections === 1 ? "mutuallyExclusive" : "multipleSelection",
        });
        break;
      case "Card": {
        // A v1.0 Card holds one child; several become a Column inside it.
        const kids = refs(c.children);
        if (kids.length === 1) {
          add({ id, component: "Card", child: kids[0] });
        } else {
          const column = fresh(`${id}-column`);
          add({ id: column, component: "Column", children: kids });
          add({ id, component: "Card", child: column });
        }
        break;
      }
      case "ButtonRow":
        add({ id, component: "Row", children: refs(c.children), justify: "end" });
        break;
      case "Modal":
        add({ id, component: "Modal", trigger: ref(c.entryPointChild), content: ref(c.contentChild) });
        break;
      case "Expandable":
        add({ id, component: "Expandable", title: String(c.title ?? ""), child: ref(c.child), ...pick(c, ["defaultExpanded"]) });
        break;
      case "Tabs":
        add({
          id,
          component: "Tabs",
          tabs: (Array.isArray(c.tabItems) ? c.tabItems.filter(isRecord) : []).map((tab) => ({
            title: String(tab.title ?? ""),
            child: ref(tab.child),
          })),
        });
        break;
      default: {
        // Kept, so the renderer shows it as the placeholder it always was.
        const { type, id: _id, ...rest } = c;
        add({ ...rest, id, component: String(type) });
      }
    }
  }

  const data = isRecord(legacy.dataModelUpdate) && isRecord(legacy.dataModelUpdate.patch)
    ? (legacy.dataModelUpdate.patch as DataModel)
    : undefined;

  return {
    version: A2UI_VERSION,
    createSurface: {
      surfaceId: surface.surfaceId,
      catalogId: ROER_CATALOG_ID,
      // v0.8-era clicks reported the whole data model; keep doing that for
      // the plugins that were written against it.
      sendDataModel: true,
      components,
      ...(data ? { dataModel: data } : {}),
    },
  };
}

function pick(from: Raw, keys: string[]): Raw {
  return Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));
}
