// A stand-in for `claude` that the e2e tests put first on PATH: Roer finds
// it as Claude Code, types its command line into a session as it would the
// real one, and nothing ever reaches a model.
//
// It answers a few lines typed at its prompt, so a test can drive it through
// the app's terminal:
//   /ui       shows a surface in the Generative UI panel, via `roer plugin-ui`
//   /actions  prints the clicks read back from it, via `roer plugin-ui-actions`
//   /exit     quits, leaving the session's shell
//   anything else is echoed back as `echo: <line>`
//
// `claude mcp …`, which `roer mcp` runs, succeeds and prints nothing.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "mcp") process.exit(0);

// The roer the harness built; the wrapper that starts this sets it.
const roer = process.env.ROER_E2E_ROER || "roer";

const surface = [
  {
    version: "v1.0",
    createSurface: { surfaceId: "e2e", catalogId: "roer:catalog/1", dataModel: {} },
  },
  {
    version: "v1.0",
    updateComponents: {
      surfaceId: "e2e",
      components: [
        { id: "root", component: "Card", child: "body" },
        { id: "body", component: "Column", children: ["heading", "press"] },
        { id: "heading", component: "Text", text: "E2E surface" },
        { id: "press-label", component: "Text", text: "Press me" },
        { id: "press", component: "Button", child: "press-label", action: { event: { name: "pressed" } } },
      ],
    },
  },
];

function run(argv, input) {
  const out = spawnSync(roer, argv, { input, encoding: "utf8" });
  if (out.error) return `could not run ${roer}: ${out.error.message}`;
  return `${out.stdout}${out.stderr}`.trim() || `exit ${out.status}`;
}

// OSC 2, as Claude Code titles its terminal with the task.
process.stdout.write("\x1b]2;Fake task\x07");
console.log(`fake-claude ready (${args.length} args)`);

const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
lines.prompt();
lines.on("line", (line) => {
  const text = line.trim();
  if (text === "/exit") {
    lines.close();
    return;
  }
  if (text === "/ui") {
    for (const message of surface) run(["plugin-ui"], JSON.stringify(message));
    console.log("ui shown");
  } else if (text === "/actions") {
    console.log(`actions: ${run(["plugin-ui-actions"], "")}`);
  } else if (text) {
    console.log(`echo: ${text}`);
  }
  lines.prompt();
});
lines.on("close", () => process.exit(0));
