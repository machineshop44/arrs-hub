import { IS_LITE_VARIANT } from "./variant";
import packageJson from "../package.json";

/** Display major generation (folder / product line). */
export const APP_MAJOR = "v1";

export const APP_NAME = IS_LITE_VARIANT ? "Arrs Hub Lite" : "Arrs Hub";

export const APP_VERSION = packageJson.version;

export const APP_TAGLINE = IS_LITE_VARIANT
  ? "qBit & SAB port watch for downloaders"
  : "Your Plex & *arr stack in one place";

export const APP_VERSION_LABEL = `${APP_NAME} ${APP_MAJOR} (${APP_VERSION})`;

/** OS / Electron window title bar — same shape as Market Advisor. */
export const APP_WINDOW_TITLE = `${APP_NAME} v${APP_VERSION} — ${APP_TAGLINE}`;
