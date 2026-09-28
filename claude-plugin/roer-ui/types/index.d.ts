// The A2UI v1.0 surfaces this mod keeps, as the model sent them through its
// `show` tool: flat, id-referenced components and one data model each, the
// same shape Roer's own panel holds (src/generative-ui/schema.ts).
export type RoerUiComponent = { id: string; component: string; [prop: string]: unknown }
export type RoerUiSurface = {
  components: Record<string, RoerUiComponent>
  dataModel: Record<string, unknown>
  sendDataModel: boolean
  /** The tab each Tabs shows, by component id and scope; the first when
   * unset. The pane's own state: a new createSurface starts it over. */
  tabs?: Record<string, number>
}
export type RoerUiSurfaces = { order: string[]; bySurface: Record<string, RoerUiSurface> }

declare module 'claude-code' {
  interface PluginState {
    'roer-ui': { surfaces: RoerUiSurfaces }
  }
}
