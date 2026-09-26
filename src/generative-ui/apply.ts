/**
 * Pure reducer over `A2uiMessage`s, kept apart from the renderer so the
 * protocol handling is testable without mounting anything — the same split
 * `lib/tabs.ts` makes for the same reason.
 */
import {
  ROER_CATALOG_ID,
  emptyState,
  writePointer,
  type A2uiMessage,
  type Component,
  type RenderState,
} from "./schema";

const byId = (components: readonly Component[] = []) =>
  Object.fromEntries(components.map((c) => [c.id, c]));

export function applyMessage(state: RenderState, message: A2uiMessage): RenderState {
  if ("createSurface" in message) {
    const { surfaceId, catalogId, sendDataModel, components, dataModel } = message.createSurface;
    // v1.0 calls re-creating a live surface an error, but Roer has no error
    // channel back to the agent yet, so an ignored message would just look
    // like a UI that never updates. Replacing it is the reading that an
    // agent re-sending its whole UI actually means.
    return {
      surfaces: {
        ...state.surfaces,
        [surfaceId]: {
          catalogId: catalogId ?? ROER_CATALOG_ID,
          components: byId(components),
          sendDataModel: sendDataModel ?? false,
        },
      },
      dataModels: { ...state.dataModels, [surfaceId]: dataModel ?? {} },
    };
  }
  if ("updateComponents" in message) {
    const { surfaceId, components } = message.updateComponents;
    const surface = state.surfaces[surfaceId];
    if (!surface) return state;
    return {
      ...state,
      surfaces: {
        ...state.surfaces,
        // Upsert by id, so a surface can be drafted incrementally — this is
        // what lets a renderer draw while the model is still streaming the
        // rest of the tree.
        [surfaceId]: { ...surface, components: { ...surface.components, ...byId(components) } },
      },
    };
  }
  if ("updateDataModel" in message) {
    const { surfaceId, path, value } = message.updateDataModel;
    if (!state.surfaces[surfaceId]) return state;
    const current = state.dataModels[surfaceId] ?? {};
    return {
      ...state,
      dataModels: { ...state.dataModels, [surfaceId]: writePointer(current, path ?? "/", value) },
    };
  }
  if ("deleteSurface" in message) {
    const { surfaceId } = message.deleteSurface;
    const { [surfaceId]: _surface, ...surfaces } = state.surfaces;
    const { [surfaceId]: _data, ...dataModels } = state.dataModels;
    return { surfaces, dataModels };
  }
  // The union is only compile-time-exhaustive — this is raw JSON off the
  // wire, so an unrecognized message is a real runtime possibility. Ignore it
  // rather than crash the reducer.
  return state;
}

export function applyAll(messages: readonly A2uiMessage[]): RenderState {
  return messages.reduce(applyMessage, emptyState);
}
