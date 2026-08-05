import packageJson from "../package.json";

/** Display major generation (folder / product line). */
export const APP_MAJOR = "v1";

export const APP_NAME = "Arrs Hub";

export const APP_VERSION = packageJson.version;

/** Short tagline for window title (matches Settings default subtitle). */
export const APP_TAGLINE = "Your Plex & *arr stack in one place";

export const APP_VERSION_LABEL = `${APP_NAME} ${APP_MAJOR} (${APP_VERSION})`;

/** OS / Electron window title bar — same shape as Market Advisor. */
export const APP_WINDOW_TITLE = `${APP_NAME} v${APP_VERSION} — ${APP_TAGLINE}`;
