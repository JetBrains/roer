// Runs one extension's `server.ts`: `bun extension_server.ts <id> <entry>`.
// Started by `extension_servers.rs` with the Bun that builds extensions,
// never by hand.
//
// It speaks JSON-RPC to the app, one object per line: requests come in on
// stdin as `{ id, method, params }`, and each answer goes out on stdout as
// `{ "roer-rpc": id, result }` or `{ "roer-rpc": id, error }`. Anything else
// on stdout is the extension's own output and lands in its log, as stderr
// does. stdin closing means the app is gone, and so is this.

const [id, entry] = process.argv.slice(2);

type Handler = (params: any) => unknown;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const handlers = new Map<string, Handler>();

const roer = {
  id,
  rpc: {
    handle(method: string, fn: Handler): () => void {
      handlers.set(method, fn);
      return () => {
        if (handlers.get(method) === fn) handlers.delete(method);
      };
    },
  },
  /** Runs a program to completion. Never throws for a non-zero exit: read `code`. */
  async exec(argv: string[], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  },
};

// `import { defineServer } from "roer/server"` in the extension.
Bun.plugin({
  name: "roer-server-host",
  setup(build) {
    build.module("roer/server", () => ({
      exports: { defineServer: (setup: (r: typeof roer) => unknown) => ({ setup }) },
      loader: "object",
    }));
  },
});

// stdout carries the protocol: the extension's console goes to stderr.
console.log = console.info = console.debug = console.error;

const send = (message: object) => process.stdout.write(JSON.stringify(message) + "\n");

const describe = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);

const module = await import(entry);
const server = module.default;
if (!server || typeof server.setup !== "function") {
  console.error("server.ts must `export default defineServer(...)`");
  process.exit(1);
}
await server.setup(roer);

let buffered = "";
for await (const chunk of process.stdin) {
  buffered += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  let newline: number;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line) as { id: number; method: string; params?: unknown };
    const handler = handlers.get(request.method);
    if (!handler) {
      send({ "roer-rpc": request.id, error: `${id} has no rpc method ${JSON.stringify(request.method)}` });
      continue;
    }
    // Requests run concurrently: one slow command doesn't hold up the rest.
    Promise.resolve()
      .then(() => handler(request.params ?? {}))
      .then(
        (result) => send({ "roer-rpc": request.id, result: result ?? null }),
        (error) => {
          // The caller gets the message; the log gets the stack.
          console.error(`${request.method} threw: ${describe(error)}`);
          send({ "roer-rpc": request.id, error: error instanceof Error ? error.message : String(error) });
        },
      );
  }
}
process.exit(0);
