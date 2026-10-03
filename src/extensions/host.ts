/**
 * Hands the host's own modules to extensions. An extension's build reads
 * `react`, `react-dom`, `roer` and `roer/ui` from `globalThis.__roerHost` instead of
 * bundling copies (see `src-tauri/src/extension_build.ts`), so it renders
 * with the app's one React and calls the app's own code.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxDevRuntime from "react/jsx-dev-runtime";
import * as JsxRuntime from "react/jsx-runtime";

import * as sdk from "./sdk";
import * as ui from "./ui";

declare global {
  var __roerHost: Record<string, unknown> | undefined;
}

/**
 * A module namespace marked as compiled ESM, so the bundler's interop takes
 * `import React from "react"` to mean the module's default export rather
 * than the namespace itself.
 */
const esm = (namespace: object): object => ({ __esModule: true, ...namespace });

/**
 * The development JSX runtime, which a production React leaves empty. A
 * build that asks for it anyway gets the production calls under its names.
 */
const jsxDev = (): object =>
  typeof JsxDevRuntime.jsxDEV === "function"
    ? esm(JsxDevRuntime)
    : {
        __esModule: true,
        Fragment: JsxRuntime.Fragment,
        jsxDEV: (type: React.ElementType, props: object, key?: React.Key) => JsxRuntime.jsx(type, props, key),
      };

export function installHost(): void {
  globalThis.__roerHost = {
    react: esm(React),
    "react-dom": esm(ReactDOM),
    "react-dom/client": esm(ReactDOMClient),
    "react/jsx-runtime": esm(JsxRuntime),
    "react/jsx-dev-runtime": jsxDev(),
    roer: esm(sdk),
    "roer/ui": esm(ui),
  };
}
