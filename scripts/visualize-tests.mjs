#!/usr/bin/env node
// Shows the vitest suite as a Generative UI surface in Roer's Plugin UI tab,
// with a "Run tests" button that actually re-runs vitest and refreshes the
// surface with the new results. See .claude/skills/generative-ui/SKILL.md
// for the message shapes and the plugin-ui-actions read-back protocol.

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
    console.error(`roer plugin-ui failed for kind=${message.kind} (exit ${result.status})`);
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
      push({ id: rowId, type: "Text", text: `${rowMark} ${label} (${ms}ms)` });

      if (assertion.failureMessages?.length > 0) {
        const msgId = `${rowId}-msg`;
        push({ id: msgId, type: "Text", muted: true, text: assertion.failureMessages.join("\n") });
        return [rowId, msgId];
      }
      return [rowId];
    });

    const listId = `file-${fileIndex}-list`;
    push({ id: listId, type: "List", children: rowIds.flat() });

    const expandableId = `file-${fileIndex}`;
    push({
      id: expandableId,
      type: "Expandable",
      title: `${mark} ${relPath} (${passed}/${total})`,
      child: listId,
      defaultExpanded: file.status !== "passed",
    });
    return expandableId;
  });

  push({ id: "heading", type: "Text", text: "Test Runner" });
  push({
    id: "subtitle",
    type: "Text",
    muted: true,
    text: `${report.numPassedTests}/${report.numTotalTests} tests passed · ${report.numTotalTestSuites} files`,
  });
  push({ id: "divider", type: "Divider" });
  push({ id: "runRow", type: "ButtonRow", children: ["run"] });
  push({ id: "run", type: "Button", label: "Run tests", action: "run", primary: true });
  push({ id: "divider2", type: "Divider" });
  push({ id: "files", type: "List", children: fileIds, direction: "vertical" });
  push({
    id: "root",
    type: "Card",
    children: ["heading", "subtitle", "divider", "runRow", "divider2", "files"],
  });

  return {
    surfaceUpdate: { kind: "surfaceUpdate", surfaceId: SURFACE_ID, root: "root", components },
    dataModelUpdate: {
      kind: "dataModelUpdate",
      surfaceId: SURFACE_ID,
      patch: {
        summary: {
          total: report.numTotalTests,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
        },
      },
    },
  };
}

function buildEmptyShell() {
  return {
    kind: "surfaceUpdate",
    surfaceId: SURFACE_ID,
    root: "root",
    components: [
      { id: "heading", type: "Text", text: "Test Runner" },
      { id: "subtitle", type: "Text", muted: true, text: "Not run yet." },
      { id: "divider", type: "Divider" },
      { id: "runRow", type: "ButtonRow", children: ["run"] },
      { id: "run", type: "Button", label: "Run tests", action: "run", primary: true },
      { id: "root", type: "Card", children: ["heading", "subtitle", "divider", "runRow"] },
    ],
  };
}

function showReport(report, { begin }) {
  const { surfaceUpdate, dataModelUpdate } = buildSurface(report);
  send(surfaceUpdate);
  send(dataModelUpdate);
  if (begin) send({ kind: "beginRendering", surfaceId: SURFACE_ID });
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
send({ kind: "beginRendering", surfaceId: SURFACE_ID });
console.log("Sent test-runner surface to Roer's Plugin UI tab. Watching for \"Run tests\" clicks (Ctrl+C to stop)...");

// Watch loop: a click on "Run tests" re-runs vitest for real and refreshes
// the surface with the new results.
for (;;) {
  for (const action of pollActions()) {
    if (action.name !== "run") continue;
    send({
      kind: "surfaceUpdate",
      surfaceId: SURFACE_ID,
      root: "root",
      components: [{ id: "subtitle", type: "Text", muted: true, text: "Running tests…" }],
    });
    const fresh = runVitest();
    showReport(fresh, { begin: false });
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
