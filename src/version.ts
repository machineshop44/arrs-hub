import packageJson from "../package.json";

/** Display major generation (folder / product line). */
export const APP_MAJOR = "v1";

export const APP_NAME = "Arrs Hub";

export const APP_VERSION = packageJson.version;

export const APP_VERSION_LABEL = `${APP_NAME} ${APP_MAJOR} (${APP_VERSION})`;
