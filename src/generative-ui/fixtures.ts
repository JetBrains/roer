/**
 * A hand-written stand-in for what a generative model would draft.
 *
 * This is the one piece the research draft flagged as unproven: whether a
 * generated surface feels native next to Roer's own UI. Hardcoding the
 * messages here lets the renderer and the approval-gate scenario be built
 * and judged now, without first wiring a model call — swapping this fixture
 * for a real drafting call is the next step, not this one.
 */
import type { A2uiMessage } from "./schema";

export const SURFACE_ID = "approval-gate";

export const approvalGateMessages: readonly A2uiMessage[] = [
  {
    kind: "surfaceUpdate",
    surfaceId: SURFACE_ID,
    root: "card",
    components: [
      { id: "card", type: "Card", children: ["heading", "sub", "divider", "list", "row"] },
      { id: "heading", type: "Text", text: "Apply 3 pending changes?" },
      {
        id: "sub",
        type: "Text",
        muted: true,
        text: "The agent is ready to run `cargo fmt`, then commit. Uncheck anything to leave it out.",
      },
      { id: "divider", type: "Divider" },
      { id: "list", type: "Card", children: ["c1", "c2", "c3"] },
      {
        id: "c1",
        type: "Checkbox",
        label: "src-tauri/src/watch.rs — batch window widened to 300ms",
        checkedPath: "changes.watch",
      },
      {
        id: "c2",
        type: "Checkbox",
        label: "src/lib/tabs.ts — evict least-recently-used file tab",
        checkedPath: "changes.tabs",
      },
      {
        id: "c3",
        type: "Checkbox",
        label: "README.md — document the new eviction rule",
        checkedPath: "changes.readme",
      },
      { id: "row", type: "ButtonRow", children: ["reject", "approve"] },
      { id: "reject", type: "Button", label: "Cancel", action: "reject" },
      { id: "approve", type: "Button", label: "Apply selected", action: "approve", primary: true },
    ],
  },
  {
    kind: "dataModelUpdate",
    surfaceId: SURFACE_ID,
    patch: { changes: { watch: true, tabs: true, readme: true } },
  },
  { kind: "beginRendering", surfaceId: SURFACE_ID },
];
