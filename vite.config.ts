import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      // What an extension imports the host's own code as; bundled extensions
      // too, so their source builds unchanged as somebody's fork.
      { find: /^roer$/, replacement: path.resolve(import.meta.dirname, "./src/extensions/sdk.ts") },
      { find: /^roer\/ui$/, replacement: path.resolve(import.meta.dirname, "./src/extensions/ui.ts") },
      // Mermaid's ELK layout, which the app does not ship: elkjs is 1.5 MB and
      // EPL-2.0. Mermaid.tsx pins diagrams to dagre, so this is never called.
      { find: /^elkjs\/lib\/elk\.bundled\.js$/, replacement: path.resolve(import.meta.dirname, "./src/generative-ui/noElk.ts") },
    ],
  },
  // Tauri expects a fixed port and serves the built assets from dist/.
  server: {
    port: 1420,
    strictPort: true,
    // A plain browser tab talks to `roer-server` for everything under
    // `/api`; Tauri's own webview never makes these requests, since its
    // `invoke`/`listen` go over the native IPC bridge instead.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // claude-plugin/ tests import claude-code/testing, which only exists under
    // `claude plugin test`; e2e/ is node:test driving the built app, run by
    // its own package (e2e/README.md).
    exclude: [...configDefaults.exclude, "claude-plugin/**", "e2e/**"],
  },
});
