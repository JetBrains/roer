/**
 * Pure reducer over `A2uiMessage`s, kept apart from the renderer so the
 * protocol handling is testable without mounting anything — the same split
 * `lib/tabs.ts` makes for the same reason.
 */
import { emptyState, type A2uiMessage, type DataModel, type RenderState } from "./schema";

export function applyMessage(state: RenderState, message: A2uiMessage): RenderState {
  switch (message.kind) {
    case "surfaceUpdate": {
      const components = Object.fromEntries(message.components.map((c) => [c.id, c]));
      const existing = state.surfaces[message.surfaceId];
      return {
        ...state,
        surfaces: {
          ...state.surfaces,
          [message.surfaceId]: {
            root: message.root,
            // A patch merges into what is already known, so a surface can be
            // drafted incrementally — this is what lets a client render while
            // the model is still streaming the rest of the tree.
            components: { ...existing?.components, ...components },
            rendering: existing?.rendering ?? false,
          },
        },
      };
    }
    case "dataModelUpdate": {
      const surfaceId = message.surfaceId;
      const current = state.dataModels[surfaceId] ?? {};
      return {
        ...state,
        dataModels: { ...state.dataModels, [surfaceId]: mergeDeep(current, message.patch) },
      };
    }
    case "beginRendering": {
      const surface = state.surfaces[message.surfaceId];
      if (!surface) return state;
      return {
        ...state,
        surfaces: { ...state.surfaces, [message.surfaceId]: { ...surface, rendering: true } },
      };
    }
    default:
      // `message.kind` is only compile-time-exhaustive — this is raw JSON off
      // the wire (a watcher event, a bundle load), so an unrecognized kind is
      // a real runtime possibility. Ignore it rather than crash the reducer.
      return state;
  }
}

export function applyAll(messages: readonly A2uiMessage[]): RenderState {
  return messages.reduce(applyMessage, emptyState);
}

function mergeDeep(base: DataModel, patch: DataModel): DataModel {
  const merged: DataModel = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeDeep(existing, value)
        : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is DataModel {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
