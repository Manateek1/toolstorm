import React from "react";
import ReactDOM from "react-dom/client";
import { initBotId } from "botid/client/core";
import App from "./App.tsx";
import "./styles.css";

if (import.meta.env.PROD && import.meta.env.VITE_PUBLIC_SCRIPTED_PREVIEW !== "true") {
  initBotId({ protect: [{ path: "/api/run", method: "POST" }] });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
