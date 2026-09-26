#!/usr/bin/env node
// Shows the vitest suite as a Generative UI surface in Roer's Plugin UI tab,
// with a "Run tests" button that actually re-runs vitest and refreshes the
// surface with the new results. See cli/src/mcp-guide.md for the message
// shapes and the plugin-ui-actions read-back protocol.

import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const SURFACE_ID = "test-runner";
const REPORT_PATH = path.join(os.tmpdir(), "roer-visualize-tests", "output.json");
const POLL_MS = 1000;

function send(message) {
  const result = spawnSync("roer", ["plugin-ui"], {
    input: JSON.stringify(message),
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    const kind = Object.keys(message).find((key) => key !== "version");
    console.error(`roer plugin-ui failed for ${kind} (exit ${result.status})`);
  }
  return result.status === 0;
}

function runVitest() {
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  spawnSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${REPORT_PATH}`], {
    stdio: "inherit",
  });
  return JSON.parse(readFileSync(REPORT_PATH, "utf8"));
}

function buildSurface(report) {
  const components = [];
  let nextRow = 0;
  const push = (component) => (components.push(component), component.id);

  const fileIds = report.testResults.map((file, fileIndex) => {
    const relPath = path.relative(process.cwd(), file.name);
    const passed = file.assertionResults.filter((a) => a.status === "passed").length;
    const total = file.assertionResults.length;
    const mark = file.status === "passed" ? "✓" : "✗";

    const rowIds = file.assertionResults.map((assertion) => {
      const rowMark = assertion.status === "passed" ? "✓" : "✗";
      const label = [...assertion.ancestorTitles, assertion.title].join(" > ");
      const ms = Math.round(assertion.duration ?? 0);
      const rowId = `t-${nextRow++}`;
      push({ id: rowId, component: "Text", text: `${rowMark} ${label} (${ms}ms)` });

      if (assertion.failureMessages?.length > 0) {
        const msgId = `${rowId}-msg`;
        push({ id: msgId, component: "Text", variant: "caption", text: assertion.failureMessages.join("\n") });
        return [rowId, msgId];
      }
      return [rowId];
    });

    const listId = `file-${fileIndex}-list`;
    push({ id: listId, component: "List", children: rowIds.flat() });

    const expandableId = `file-${fileIndex}`;
    push({
      id: expandableId,
      component: "Expandable",
      title: `${mark} ${relPath} (${passed}/${total})`,
      child: listId,
      defaultExpanded: file.status !== "passed",
    });
    return expandableId;
  });

  push({ id: "heading", component: "Text", text: "Test Runner" });
  push({
    id: "subtitle",
    component: "Text",
    variant: "caption",
    text: `${report.numPassedTests}/${report.numTotalTests} tests passed · ${report.numTotalTestSuites} files`,
  });
  push({ id: "divider", component: "Divider" });
  push(...runButton());
  push({ id: "divider2", component: "Divider" });
  push({ id: "files", component: "List", children: fileIds, direction: "vertical" });
  push({
    id: "body",
    component: "Column",
    children: ["heading", "subtitle", "divider", "runRow", "divider2", "files"],
  });
  push({ id: "root", component: "Card", child: "body" });

  return [
    { version: "v1.0", updateComponents: { surfaceId: SURFACE_ID, components } },
    {
      version: "v1.0",
      updateDataModel: {
        surfaceId: SURFACE_ID,
        path: "/summary",
        value: {
          total: report.numTotalTests,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
        },
      },
    },
  ];
}

function runButton() {
  return [
    { id: "runRow", component: "Row", justify: "end", children: ["run"] },
    { id: "run-label", component: "Text", text: "Run tests" },
    { id: "run", component: "Button", child: "run-label", variant: "primary", action: { event: { name: "run" } } },
  ];
}

function buildEmptyShell() {
  return {
    version: "v1.0",
    createSurface: {
      surfaceId: SURFACE_ID,
      catalogId: "roer:catalog/1",
      components: [
        { id: "heading", component: "Text", text: "Test Runner" },
        { id: "subtitle", component: "Text", variant: "caption", text: "Not run yet." },
        { id: "divider", component: "Divider" },
        ...runButton(),
        { id: "body", component: "Column", children: ["heading", "subtitle", "divider", "runRow"] },
        { id: "root", component: "Card", child: "body" },
      ],
    },
  };
}

function showReport(report) {
  for (const message of buildSurface(report)) send(message);
}

function pollActions() {
  const result = spawnSync("roer", ["plugin-ui-actions"], { encoding: "utf8" });
  if (!result.stdout) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Initial render: an empty shell, no results until "Run tests" is clicked.
send(buildEmptyShell());
console.log("Sent test-runner surface to Roer's Plugin UI tab. Watching for \"Run tests\" clicks (Ctrl+C to stop)...");

// Watch loop: a click on "Run tests" re-runs vitest for real and refreshes
// the surface with the new results.
for (;;) {
  for (const action of pollActions()) {
    if (action.message?.action?.name !== "run") continue;
    send({
      version: "v1.0",
      updateComponents: {
        surfaceId: SURFACE_ID,
        components: [{ id: "subtitle", component: "Text", variant: "caption", text: "Running tests…" }],
      },
    });
    showReport(runVitest());
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
