import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { TabPage, tabOfPage } from "./TabPage";
import "./index.css";
import { logLine, logUncaught } from "./lib/log";
import { applyTheme, storedChoice } from "./lib/theme";

applyTheme(storedChoice());
logUncaught();
logLine(`webview: ${navigator.userAgent}, devicePixelRatio ${window.devicePixelRatio}`);

// A browser page opened for one tab of the stage draws that tab alone.
const tab = tabOfPage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{tab ? <TabPage tabId={tab} /> : <App />}</React.StrictMode>,
);
