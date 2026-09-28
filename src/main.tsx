import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { logLine, logUncaught } from "./lib/log";
import { applyTheme, storedChoice } from "./lib/theme";

applyTheme(storedChoice());
logUncaught();
logLine(`webview: ${navigator.userAgent}, devicePixelRatio ${window.devicePixelRatio}`);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
