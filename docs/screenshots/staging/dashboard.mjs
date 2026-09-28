// The checkout-service dashboard, sent as one A2UI v1.0 createSurface.
const btn = (id, label, name, variant) => [
  { id, component: "Button", child: `${id}-l`, variant, action: { event: { name, context: {} } } },
  { id: `${id}-l`, component: "Text", text: label },
];
const runs = [
  { title: "main · build & test", subtitle: "#1482 · Merge PR #219", meta: "Passed in 6m 12s", status: "success" },
  { title: "PR #221 · retry idempotency keys", subtitle: "#1483 · 3 of 5 jobs", meta: "Running for 4m", status: "running", progress: 64 },
  { title: "nightly · e2e", subtitle: "#1479 · refund-flow.spec.ts", meta: "Failed 2h ago", status: "failed" },
  { title: "PR #218 · bump stripe-node", subtitle: "#1477 · lint, test", meta: "Passed in 5m 48s", status: "success" },
];
const components = [
  { id: "root", component: "Column", weight: 1, children: ["title", "sub", "stats", "d1", "ci-h", "ci", "d2", "dep-h", "deps"] },
  { id: "title", component: "Text", text: "checkout-service" },
  { id: "sub", component: "Text", variant: "caption", text: "main · refreshed 12:04 · 20 runs, 6 open PRs" },
  { id: "stats", component: "Grid", columns: 4, children: ["s1", "s2", "s3", "s4"] },
  { id: "s1", component: "StatTile", label: "Tests passing", value: { path: "/stats/tests" }, trend: { delta: "+42", direction: "up" } },
  { id: "s2", component: "StatTile", label: "Coverage", value: { path: "/stats/coverage" }, trend: { delta: "+1.4%", direction: "up" } },
  { id: "s3", component: "StatTile", label: "Open PRs", value: { path: "/stats/prs" } },
  { id: "s4", component: "StatTile", label: "Deploys", value: { path: "/stats/deploys" }, trend: { delta: "+3", direction: "up" } },
  { id: "d1", component: "Divider" },
  { id: "ci-h", component: "Text", text: "CI runs" },
  { id: "ci", component: "Grid", minItemWidth: 230, children: { path: "/runs", componentId: "run" } },
  { id: "run", component: "StatusCard", title: { path: "title" }, subtitle: { path: "subtitle" }, meta: { path: "meta" }, status: { path: "status" }, progress: { path: "progress" } },
  { id: "d2", component: "Divider" },
  { id: "dep-h", component: "Text", text: "Deploys" },
  { id: "deps", component: "Grid", minItemWidth: 230, children: ["staging", "prod"] },
  { id: "staging", component: "StatusCard", title: "staging", subtitle: "v2.18.0 · a41c9e2", meta: "Deployed 9 min ago", status: "deployed" },
  { id: "prod", component: "StatusCard", title: "production", subtitle: "v2.18.0 · a41c9e2", meta: "Waiting for approval", status: "waiting", footer: "prod-actions" },
  { id: "prod-actions", component: "Row", children: ["approve", "hold"] },
  ...btn("approve", "Approve", "approveDeploy", "primary"),
  ...btn("hold", "Hold", "holdDeploy", "default"),
];
const dataModel = {
  runs,
  stats: { tests: "1,284", coverage: "87.2%", prs: 6, deploys: 14 },
};
process.stdout.write(JSON.stringify({ version: "v1.0", createSurface: { surfaceId: "checkout-dashboard", catalogId: "roer:catalog/1", components, dataModel } }));
