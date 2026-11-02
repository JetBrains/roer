// The A2UI v1.0 surfaces this mod keeps, as the model sent them through its
// `show` tool: flat, id-referenced components and one data model each, the
// same shape Roer's own panel holds (src/generative-ui/schema.ts).
export type RoerUiComponent = { id: string; component: string; [prop: string]: unknown }
export type RoerUiSurface = {
  components: Record<string, RoerUiComponent>
  dataModel: Record<string, unknown>
  sendDataModel: boolean
  /** Kept but not drawn, until a press's `action.local.open` names it. */
  hidden?: boolean
  /** The pane's own state, by what it is about: which tab a Tabs shows,
   * which Expandable and Modal are open, a picker's filter, the person's
   * answers in a work item. Nothing the agent sent says any of it, so it is
   * never written to the data model, and a new createSurface starts over. */
  view?: Record<string, unknown>
}
export type RoerUiSurfaces = { order: string[]; bySurface: Record<string, RoerUiSurface> }
/** A live load: a command (or a file, as `cat -- <file>`) the pane runs again every `every` seconds with no turn of
 * the model's, writing `path` of its surface when what it prints changes; `pick` takes part of a JSON output. */
export type LiveLoad = { surfaceId: string; path: string; as: 'text' | 'json'; pick?: string; run: string[]; every: number }

declare module 'claude-code' {
  interface PluginState {
    'roer-ui': { surfaces: RoerUiSurfaces; live: Shaped<LiveLoad[]> }
  }
}
