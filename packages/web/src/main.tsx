import React from "react";
import ReactDOM from "react-dom/client";
import "virtual:pwa-register";
import { App } from "./App";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
