// The page `roer mcp` serves to apps that draw MCP Apps (src/mcp-app/main.tsx): React, the `roer` SDK and
// `roer/ui`, with the backend swapped for one that talks to `roer mcp` through the app. One JS file and one CSS
// file in dist-mcp-app/, which the CLI inlines into the page it serves: an app's iframe fetches nothing else.
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import app from "./vite.config";

const src = (file: string) => path.resolve(import.meta.dirname, "src", file);

/** Every import of `lib/backend`, from wherever, gets `mcp-app/backend` instead. */
const backend = (): Plugin => ({
  name: "roer-mcp-app-backend",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!/(^|\/)backend$/.test(source) || !importer || importer === src("mcp-app/backend.ts")) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved?.id === src("lib/backend.ts") ? src("mcp-app/backend.ts") : null;
  },
});

export default defineConfig({
  plugins: [backend(), react(), tailwindcss()],
  resolve: app.resolve,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist-mcp-app",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: src("mcp-app/main.tsx"),
      output: {
        format: "es",
        inlineDynamicImports: true,
        entryFileNames: "runtime.js",
        assetFileNames: "runtime.[ext]",
      },
    },
  },
});
