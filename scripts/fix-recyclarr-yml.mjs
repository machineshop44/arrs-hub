import fs from "node:fs";
import {
  loadSyncSettings,
  buildRecyclarrYaml,
  CONFIG_PATH,
} from "../server/config.mjs";
import { SYNC_PRESETS } from "../server/presets.mjs";

const settings = loadSyncSettings();
const selected = new Set(settings.selectedPresets ?? []);
const presets = SYNC_PRESETS.filter((p) => selected.has(p.id));
const yaml = buildRecyclarrYaml(settings, presets);
fs.writeFileSync(CONFIG_PATH, yaml, "utf8");
console.log("Wrote", CONFIG_PATH);
console.log(yaml.replace(/api_key: ".*?"/g, 'api_key: "***"'));
