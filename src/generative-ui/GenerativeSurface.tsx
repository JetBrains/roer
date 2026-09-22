/**
 * The trusted catalog and renderer — the half of A2UI that matters for
 * safety. It switches on `Component["type"]`, a closed union; a component id
 * the switch does not recognise renders as a visible placeholder rather than
 * being skipped silently, so a catalog gap is a bug you can see, not one an
 * agent can quietly exploit into running something else.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

import type { Component, ComponentId, DataModel, SurfaceState, TextFieldType } from "./schema";
import { readPath } from "./schema";

interface Props {
  surface: SurfaceState;
  dataModel: DataModel;
  onSetValue: (path: string, value: unknown) => void;
  onAction: (action: string, sourceComponentId: ComponentId) => void;
}

export function GenerativeSurface({ surface, dataModel, onSetValue, onAction }: Props) {
  if (!surface.rendering || !surface.root) {
    return <p className="gen-text muted">Waiting for the surface to begin rendering…</p>;
  }
  return (
    <div className="gen-surface">
      {renderNode(surface.root, surface.components, dataModel, onSetValue, onAction, new Set())}
    </div>
  );
}

function renderNode(
  id: ComponentId,
  components: Record<ComponentId, Component>,
  dataModel: DataModel,
  onSetValue: Props["onSetValue"],
  onAction: Props["onAction"],
  ancestors: ReadonlySet<ComponentId>,
): ReactNode {
  const node = components[id];
  if (!node) return <p key={id} className="gen-text muted">[missing component: {id}]</p>;
  // Child ids are agent-provided; a self-referential Card/Row would recurse
  // forever without this, so a cycle renders as a placeholder instead of
  // overflowing the stack and taking the whole panel down.
  if (ancestors.has(id)) {
    return <p key={id} className="gen-text muted">[cyclic component: {id}]</p>;
  }
  const seen = new Set(ancestors).add(id);

  const child = (childId: ComponentId) =>
    renderNode(childId, components, dataModel, onSetValue, onAction, seen);
  const children = (ids: ComponentId[]) => ids.map(child);

  switch (node.type) {
    case "Row":
      return (
        <div
          key={node.id}
          className="gen-row"
          style={justifyAlignStyle(node.justify, node.align)}
        >
          {children(node.children)}
        </div>
      );
    case "Column":
      return (
        <div
          key={node.id}
          className="gen-column"
          style={justifyAlignStyle(node.justify, node.align)}
        >
          {children(node.children)}
        </div>
      );
    case "List":
      return (
        <div
          key={node.id}
          className={node.direction === "horizontal" ? "gen-list horizontal" : "gen-list"}
        >
          {children(node.children)}
        </div>
      );
    case "Text":
      return (
        <p key={node.id} className={node.muted ? "gen-text muted" : "gen-text"}>
          {node.text}
        </p>
      );
    case "Image":
      return <img key={node.id} className="gen-image" src={node.url} alt={node.alt ?? ""} />;
    case "Icon":
      return (
        <span key={node.id} className="gen-icon" aria-hidden="true">
          {node.name}
        </span>
      );
    case "Divider":
      return <hr key={node.id} className="gen-divider" />;
    case "Arrow":
      return (
        <div
          key={node.id}
          className={node.direction === "vertical" ? "gen-arrow vertical" : "gen-arrow horizontal"}
        >
          {node.label ? <span className="gen-arrow-label">{node.label}</span> : null}
          <span className="gen-arrow-line" />
        </div>
      );
    case "Button":
      return (
        <button
          key={node.id}
          type="button"
          className={node.primary ? "gen-button primary" : "gen-button"}
          onClick={() => onAction(node.action, node.id)}
        >
          {node.label}
        </button>
      );
    case "TextField": {
      const value = String(readPath(dataModel, node.valuePath) ?? "");
      return (
        <label key={node.id} className="gen-field">
          <span className="gen-field-label">{node.label}</span>
          {node.textFieldType === "longText" ? (
            <textarea
              value={value}
              onChange={(e) => onSetValue(node.valuePath, e.target.value)}
            />
          ) : (
            <input
              type={inputTypeFor(node.textFieldType)}
              value={value}
              onChange={(e) => onSetValue(node.valuePath, e.target.value)}
            />
          )}
        </label>
      );
    }
    case "Checkbox": {
      const checked = Boolean(readPath(dataModel, node.checkedPath));
      return (
        <label key={node.id} className="gen-checkbox">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onSetValue(node.checkedPath, e.target.checked)}
          />
          {node.label}
        </label>
      );
    }
    case "Slider": {
      const value = Number(readPath(dataModel, node.valuePath) ?? node.minValue);
      return (
        <label key={node.id} className="gen-slider">
          <input
            type="range"
            min={node.minValue}
            max={node.maxValue}
            value={value}
            onChange={(e) => onSetValue(node.valuePath, Number(e.target.value))}
          />
          <span className="gen-slider-value">{value}</span>
        </label>
      );
    }
    case "DateTimeInput": {
      const value = String(readPath(dataModel, node.valuePath) ?? "");
      // Both flags default to enabled, per the catalog's contract — only an
      // explicit `false` narrows the input.
      const type =
        node.enableDate === false ? "time" : node.enableTime === false ? "date" : "datetime-local";
      return (
        <input
          key={node.id}
          type={type}
          className="gen-datetime"
          value={value}
          onChange={(e) => onSetValue(node.valuePath, e.target.value)}
        />
      );
    }
    case "ChoicePicker": {
      const selected = new Set(
        (readPath(dataModel, node.selectionsPath) as string[] | undefined) ?? [],
      );
      const toggle = (value: string) => {
        const next = new Set(selected);
        if (next.has(value)) next.delete(value);
        else if (node.maxAllowedSelections === undefined || next.size < node.maxAllowedSelections)
          next.add(value);
        onSetValue(node.selectionsPath, Array.from(next));
      };
      return (
        <div key={node.id} className="gen-choice-picker">
          {node.options.map((option) => (
            <label key={option.value} className="gen-choice-option">
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={() => toggle(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      );
    }
    case "Card":
      return (
        <div key={node.id} className="gen-card">
          {children(node.children)}
        </div>
      );
    case "ButtonRow":
      return (
        <div key={node.id} className="gen-button-row">
          {children(node.children)}
        </div>
      );
    case "Modal":
      return (
        <ModalNode
          key={node.id}
          entry={child(node.entryPointChild)}
          content={child(node.contentChild)}
        />
      );
    case "Expandable":
      return (
        <ExpandableNode
          key={node.id}
          title={node.title}
          defaultExpanded={node.defaultExpanded}
          content={child(node.child)}
        />
      );
    case "Tabs":
      return (
        <TabsNode
          key={node.id}
          tabItems={node.tabItems}
          renderChild={child}
        />
      );
    default: {
      // Exhaustiveness check: a new Component variant fails the build here
      // instead of silently falling through the switch.
      const neverNode: never = node;
      return <p key={(neverNode as Component).id}>[unsupported component]</p>;
    }
  }
}

function inputTypeFor(kind: TextFieldType | undefined) {
  switch (kind) {
    case "number":
      return "number";
    case "obscured":
      return "password";
    case "date":
      return "date";
    default:
      return "text";
  }
}

function justifyAlignStyle(
  justify?: "start" | "center" | "end" | "spaceBetween",
  align?: "start" | "center" | "end",
): CSSProperties {
  const justifyMap = { start: "flex-start", center: "center", end: "flex-end", spaceBetween: "space-between" };
  const alignMap = { start: "flex-start", center: "center", end: "flex-end" };
  return {
    justifyContent: justify ? justifyMap[justify] : undefined,
    alignItems: align ? alignMap[align] : undefined,
  };
}

/** Local, client-only state: which A2UI message would open this is not part
 * of the protocol, so the trigger and the open flag both live here. */
function ModalNode({ entry, content }: { entry: ReactNode; content: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="gen-modal-trigger" onClick={() => setOpen(true)}>
        {entry}
      </span>
      {open ? (
        <div className="gen-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="gen-modal" onClick={(e) => e.stopPropagation()}>
            {content}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Same reasoning as `ModalNode`: whether a node is expanded is client-only
 * state, never part of the data model an agent reads or writes. */
function ExpandableNode({
  title,
  defaultExpanded,
  content,
}: {
  title: string;
  defaultExpanded?: boolean;
  content: ReactNode;
}) {
  const [open, setOpen] = useState(defaultExpanded ?? false);
  return (
    <div className="gen-expandable">
      <button
        type="button"
        className="gen-expandable-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={open ? "gen-expandable-chevron open" : "gen-expandable-chevron"}>▶</span>
        {title}
      </button>
      {open ? <div className="gen-expandable-body">{content}</div> : null}
    </div>
  );
}

/** Same reasoning as `ModalNode`: which tab is active is client-only state,
 * never part of the data model an agent reads or writes. */
function TabsNode({
  tabItems,
  renderChild,
}: {
  tabItems: { title: string; child: ComponentId }[];
  renderChild: (id: ComponentId) => ReactNode;
}) {
  const [active, setActive] = useState(0);
  return (
    <div className="gen-tabs">
      <div className="gen-tabs-bar" role="tablist">
        {tabItems.map((item, i) => (
          <button
            key={item.child}
            type="button"
            role="tab"
            aria-selected={active === i}
            className={active === i ? "gen-tabs-btn on" : "gen-tabs-btn"}
            onClick={() => setActive(i)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div className="gen-tabs-panel">
        {tabItems[active] ? renderChild(tabItems[active].child) : null}
      </div>
    </div>
  );
}
