import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
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
  },
});
