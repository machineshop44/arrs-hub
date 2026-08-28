const fs = require("node:fs");
const path = require("node:path");

/**
 * Windows login-at-startup helper for Electron tray apps.
 * @param {import("electron").App} app
 * @param {string} settingsFileName e.g. "desktop-settings.json"
 */
function readOpenAtLogin(app, settingsFileName, defaultValue = true) {
  try {
    const file = path.join(app.getPath("userData"), settingsFileName);
    if (!fs.existsSync(file)) return defaultValue;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw.openAtLogin === "boolean") return raw.openAtLogin;
  } catch {
    // default
  }
  return defaultValue;
}

function saveOpenAtLogin(app, settingsFileName, openAtLogin) {
  const file = path.join(app.getPath("userData"), settingsFileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ openAtLogin: Boolean(openAtLogin) }, null, 2)}\n`,
    "utf8",
  );
}

function applyOpenAtLogin(app, openAtLogin, appName) {
  if (process.platform !== "win32") return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(openAtLogin),
      name: appName,
      path: process.execPath,
    });
  } catch {
    // ignore
  }
}

function syncOpenAtLogin(app, settingsFileName, appName, defaultValue = true) {
  const enabled = readOpenAtLogin(app, settingsFileName, defaultValue);
  applyOpenAtLogin(app, enabled, appName);
  return enabled;
}

function toggleOpenAtLogin(app, settingsFileName, appName) {
  const next = !readOpenAtLogin(app, settingsFileName, true);
  saveOpenAtLogin(app, settingsFileName, next);
  applyOpenAtLogin(app, next, appName);
  return next;
}

module.exports = {
  readOpenAtLogin,
  saveOpenAtLogin,
  applyOpenAtLogin,
  syncOpenAtLogin,
  toggleOpenAtLogin,
};
