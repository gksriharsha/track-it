import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { markPlatform } from "./lib/desktop";

// Before the first render, not inside an effect: this decides whether the
// sidebar reserves the top-left corner for the macOS traffic lights, and
// applying it a frame later would show the brand jumping down the sidebar.
markPlatform();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
