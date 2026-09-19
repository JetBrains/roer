/**
 * The trusted catalog and renderer — the half of A2UI that matters for
 * safety. It switches on `Component["type"]`, a closed union; a component id
 * the switch does not recognise renders as a visible placeholder rather than
 * being skipped silently, so a catalog gap is a bug you can see, not one an
 * agent can quietly exploit into running something else.
 */
import type { ReactNode } from "react";

import type { Component, ComponentId, DataModel, SurfaceState } from "./schema";
import { readPath } from "./schema";

interface Props {
  surface: SurfaceState;
  dataModel: DataModel;
  onToggle: (path: string, value: boolean) => void;
  onAction: (action: string) => void;
}

export function GenerativeSurface({ surface, dataModel, onToggle, onAction }: Props) {
  if (!surface.rendering || !surface.root) {
    return <p className="gen-text muted">Waiting for the surface to begin rendering…</p>;
  }
  return (
    <div className="gen-surface">
      {renderNode(surface.root, surface.components, dataModel, onToggle, onAction)}
    </div>
  );
}

function renderNode(
  id: ComponentId,
  components: Record<ComponentId, Component>,
  dataModel: DataModel,
  onToggle: Props["onToggle"],
  onAction: Props["onAction"],
): ReactNode {
  const node = components[id];
  if (!node) return <p key={id} className="gen-text muted">[missing component: {id}]</p>;

  const children = (ids: ComponentId[]) =>
    ids.map((childId) => renderNode(childId, components, dataModel, onToggle, onAction));

  switch (node.type) {
    case "Card":
      return (
        <div key={node.id} className="gen-card">
          {children(node.children)}
        </div>
      );
    case "Text":
      return (
        <p key={node.id} className={node.muted ? "gen-text muted" : "gen-text"}>
          {node.text}
        </p>
      );
    case "Divider":
      return <hr key={node.id} className="gen-divider" />;
    case "Checkbox": {
      const checked = Boolean(readPath(dataModel, node.checkedPath));
      return (
        <label key={node.id} className="gen-checkbox">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(node.checkedPath, e.target.checked)}
          />
          {node.label}
        </label>
      );
    }
    case "ButtonRow":
      return (
        <div key={node.id} className="gen-button-row">
          {children(node.children)}
        </div>
      );
    case "Button":
      return (
        <button
          key={node.id}
          type="button"
          className={node.primary ? "gen-button primary" : "gen-button"}
          onClick={() => onAction(node.action)}
        >
          {node.label}
        </button>
      );
    default: {
      // Exhaustiveness check: a new Component variant fails the build here
      // instead of silently falling through the switch.
      const neverNode: never = node;
      return <p key={(neverNode as Component).id}>[unsupported component]</p>;
    }
  }
}
