/**
 * A hand-written stand-in for what a generative model would draft.
 *
 * This is the one piece the research draft flagged as unproven: whether a
 * generated surface feels native next to Roer's own UI. Hardcoding the
 * messages here lets the renderer and the approval-gate scenario be built
 * and judged now, without first wiring a model call — swapping this fixture
 * for a real drafting call is the next step, not this one.
 */
import { A2UI_VERSION, ROER_CATALOG_ID, type A2uiMessage } from "./schema";

export const SURFACE_ID = "approval-gate";

export const approvalGateMessages: readonly A2uiMessage[] = [
  {
    version: A2UI_VERSION,
    createSurface: {
      surfaceId: SURFACE_ID,
      catalogId: ROER_CATALOG_ID,
      dataModel: { changes: { watch: true, tabs: true, readme: true } },
    },
  },
  {
    version: A2UI_VERSION,
    updateComponents: {
      surfaceId: SURFACE_ID,
      components: [
        { id: "root", component: "Card", child: "body" },
        { id: "body", component: "Column", children: ["heading", "sub", "divider", "list", "row"] },
        { id: "heading", component: "Text", text: "Apply 3 pending changes?" },
        {
          id: "sub",
          component: "Text",
          variant: "caption",
          text: "The agent is ready to run `cargo fmt`, then commit. Uncheck anything to leave it out.",
        },
        { id: "divider", component: "Divider" },
        { id: "list", component: "Column", children: ["c1", "c2", "c3"] },
        {
          id: "c1",
          component: "CheckBox",
          label: "src-tauri/src/watch.rs — batch window widened to 300ms",
          value: { path: "/changes/watch" },
        },
        {
          id: "c2",
          component: "CheckBox",
          label: "src/lib/tabs.ts — evict least-recently-used file tab",
          value: { path: "/changes/tabs" },
        },
        {
          id: "c3",
          component: "CheckBox",
          label: "README.md — document the new eviction rule",
          value: { path: "/changes/readme" },
        },
        { id: "row", component: "Row", justify: "end", children: ["reject", "approve"] },
        { id: "reject-label", component: "Text", text: "Cancel" },
        { id: "reject", component: "Button", child: "reject-label", action: { event: { name: "reject" } } },
        { id: "approve-label", component: "Text", text: "Apply selected" },
        {
          id: "approve",
          component: "Button",
          child: "approve-label",
          variant: "primary",
          action: { event: { name: "approve", context: { changes: { path: "/changes" } } } },
        },
      ],
    },
  },
];
