import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { markPlatform } from "./lib/desktop";
import { followKeyboard } from "./lib/keyboard";

// Before the first render, not inside an effect: this decides whether the
// sidebar reserves the top-left corner for the macOS traffic lights, and
// applying it a frame later would show the brand jumping down the sidebar.
markPlatform();
// Before the first render too: the keyboard can come up on the very first
// field the page focuses.
followKeyboard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
