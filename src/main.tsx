import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AppLite from "./AppLite";
import { IS_LITE_VARIANT } from "./variant";
import { APP_WINDOW_TITLE } from "./version";
import "./index.css";

document.title = APP_WINDOW_TITLE;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {IS_LITE_VARIANT ? <AppLite /> : <App />}
  </StrictMode>,
);
