/** Quick sanity: index.mjs named imports from plex-update.mjs must exist. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = fs.readFileSync(path.join(root, "server", "index.mjs"), "utf8");
const mod = await import(
  pathToFileURL(path.join(root, "server", "plex-update.mjs")).href
);

const match = indexSrc.match(
  /import\s*\{([^}]+)\}\s*from\s*["']\.\/plex-update\.mjs["']/
);
if (!match) {
  console.error("No plex-update import found in index.mjs");
  process.exit(1);
}

const needed = match[1]
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const missing = needed.filter((name) => !(name in mod));

console.log("index needs:", needed.join(", "));
console.log("plex-update exports:", Object.keys(mod).sort().join(", "));
if (missing.length) {
  console.error("MISSING:", missing.join(", "));
  process.exit(1);
}
console.log("All plex-update imports satisfied.");
