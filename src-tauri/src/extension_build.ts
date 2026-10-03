// Builds one extension's app entry for the webview: `bun extension_build.ts
// <entry> <outdir>`. Run by `extensions.rs` with the Bun that ships with the
// app, never by hand.
//
// React and the `roer` SDK are the host's own, handed over at run time
// rather than bundled: each import of one is a CommonJS module that reads
// it from `globalThis.__roerHost`, which `src/extensions/host.ts` fills in
// before any extension loads. Bun's interop then turns `import { useState }
// from "react"` into a property read on the host's React, so there is no
// list of export names to keep in step with the host.
//
// Prints one line of JSON: `{ ok, logs }`.

const [entry, outdir] = process.argv.slice(2);

const HOST = /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime|roer|roer\/ui)$/;

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  format: "esm",
  naming: "app.[ext]",
  jsx: { runtime: "automatic", importSource: "react", development: false },
  plugins: [
    {
      name: "roer-host",
      setup(build) {
        build.onResolve({ filter: HOST }, (args) => ({ path: args.path, namespace: "roer-host" }));
        build.onLoad({ filter: /.*/, namespace: "roer-host" }, (args) => ({
          contents: `module.exports = globalThis.__roerHost[${JSON.stringify(args.path)}];`,
          loader: "js",
        }));
      },
    },
  ],
  // A failed build throws an AggregateError with one entry per message.
}).catch((error: { errors?: unknown[] }) => ({ success: false, logs: error.errors ?? [error], outputs: [] }));

type Message = { message?: string; level?: string; position?: { file: string; line: number; column: number; lineText: string } | null };

/** `file:line:column: message`, and the line itself: what an agent needs to fix it. */
const describe = (log: unknown): string => {
  const { message, position } = (log ?? {}) as Message;
  if (!message) return String(log);
  if (!position) return message;
  return `${position.file}:${position.line}:${position.column}: ${message}\n    ${position.lineText.trim()}`;
};

console.log(JSON.stringify({ ok: result.success, logs: result.logs.map(describe) }));
