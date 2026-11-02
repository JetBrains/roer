// A saved copy of a tab (src/copy/main.tsx): React, the `roer` SDK, `roer/ui` and the bundled extensions, with the
// backend swapped for one that only records reads and plays them back. One JS and one CSS file in public/roer-copy/,
// so the app serves them as its own assets and "Save as HTML…" inlines them into the file it writes.
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import app from "./vite.config";

const src = (file: string) => path.resolve(import.meta.dirname, "src", file);

/** Every import of `lib/backend`, from wherever, gets `copy/backend` instead. */
const backend = (): Plugin => ({
  name: "roer-copy-backend",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!/(^|\/)backend$/.test(source) || !importer || importer === src("copy/backend.ts")) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved?.id === src("lib/backend.ts") ? src("copy/backend.ts") : null;
  },
});

export default defineConfig({
  plugins: [backend(), react(), tailwindcss()],
  resolve: app.resolve,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  publicDir: false,
  build: {
    outDir: "public/roer-copy",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: src("copy/main.tsx"),
      output: {
        format: "es",
        inlineDynamicImports: true,
        entryFileNames: "runtime.js",
        assetFileNames: "runtime.[ext]",
      },
    },
  },
});
