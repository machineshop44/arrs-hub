import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { APP_WINDOW_TITLE } from "./version";
import "./index.css";

document.title = APP_WINDOW_TITLE;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
