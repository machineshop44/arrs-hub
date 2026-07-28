import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "./config.mjs";

export const WORKOUT_SETTINGS_PATH = path.join(DATA_DIR, "workout-settings.json");

export function defaultWorkoutSettings() {
  return {
    plexBaseUrl: "http://localhost:32400",
    plexToken: "",
    librarySectionId: "",
    /** "episode" = TV show S/E mapping; "title" = match video titles */
    matchMode: "episode",
    showTitle: "Fit With the Force",
    seasonNumber: 1,
    /** Episode number used as the warm-up (Fit With the Force = 2) */
    warmupEpisode: 2,
    /** Episode number for Day 1 (episodes after warm-up) */
    firstDayEpisode: 3,
    warmupTitle: "Warm Up",
    dayTitlePattern: "Day {n}",
    clientMachineId: "",
    clientName: "",
    dayCount: 30,
  };
}

export function loadWorkoutSettings() {
  ensureDataDirs();
  if (!fs.existsSync(WORKOUT_SETTINGS_PATH)) {
    const defaults = defaultWorkoutSettings();
    saveWorkoutSettings(defaults);
    return defaults;
  }
  const raw = fs
    .readFileSync(WORKOUT_SETTINGS_PATH, "utf8")
    .replace(/^\uFEFF/, "")
    .trim();
  const start = raw.indexOf("{");
  const jsonText = start >= 0 ? raw.slice(start) : raw;
  const parsed = JSON.parse(jsonText);
  return { ...defaultWorkoutSettings(), ...parsed };
}

export function saveWorkoutSettings(settings) {
  ensureDataDirs();
  fs.writeFileSync(
    WORKOUT_SETTINGS_PATH,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

export function normalizePlexBaseUrl(url) {
  let value = String(url || "").trim();
  if (!value) return "http://localhost:32400";
  value = value.replace(/\/web(?:\/index\.html)?\/?$/i, "");
  value = value.replace(/\/$/, "");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value;
}
