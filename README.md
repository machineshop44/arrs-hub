# Arr's Hub

A simple, all-in-one dashboard for your Plex and *arr stack. Launch Sonarr, Radarr, Prowlarr, Tautulli, Ombi, qBittorrent, SABnzbd, and more from one place — plus a Windows tray app with port watchdog, live Tautulli streams, TRaSH sync, and workouts.

## Install on Plex PC (recommended)

Like Sonarr/Radarr: download the installer, click Next, run. **No Node.js or Git required.**

1. Open the latest [GitHub Release](https://github.com/machineshop44/arrs-hub/releases/latest)
2. Download **`Arrs Hub-*-x64.exe`** (NSIS installer) — or the **portable** build if you prefer no install
3. Run the installer → Next → Finish
4. Launch **Arrs Hub** from the Start Menu or Desktop shortcut
5. Open **Settings** in the hub and enter Home URLs for each app (e.g. `http://localhost:8989`)
6. Optional: **Watch** → enable Monitor + Auto-restart; confirm Windows service names

The app lives in the system tray (close the window = still running). Tray → **Quit** to fully stop.

Dashboard: [http://localhost:3000](http://localhost:3000) (default). If port 3000 is already in use, set `ARRS_HUB_PORT` or `PORT` before launching (e.g. `set ARRS_HUB_PORT=3001` in a Command Prompt, then start Arrs Hub). Match that port in Arrs Hub Mobile → Settings → Network → Arrs Hub port.

Settings, Recyclarr binaries, and API keys are stored under:

`%APPDATA%\Arrs Hub\data\`

(not inside the install folder — safe across updates). Migrating from an old folder install? Copy your old `data\` contents into that AppData path.

Windows may show a SmartScreen warning on first run (unsigned installer). Choose **More info** → **Run anyway** if you trust the build from this repo’s Releases.

### Optional: Recyclarr / TRaSH sync

In the hub header, open **Sync**, paste Sonarr/Radarr API keys, pick a profile, **Download Recyclarr**, then **Sync now**. Recyclarr downloads into `%APPDATA%\Arrs Hub\data\recyclarr\`. Git for Windows is only needed if Recyclarr’s guide clone requires it on your machine.

### Optional: Tautulli Streams

In the hub header, open **Streams**. Paste your Tautulli base URL (same as the Tautulli Home URL, e.g. `http://localhost:8181`) and API key from **Tautulli → Settings → Web Interface → API**. The panel shows live sessions with posters, progress, and Direct Play / Transcode details (auto-refreshes). Settings are stored in `%APPDATA%\Arrs Hub\data\tautulli-settings.json` (or `./data/` in dev) — never commit that file.

Get Streams on the Plex PC via the latest [GitHub Release](https://github.com/machineshop44/arrs-hub/releases/latest) installer (or `npm run dev` on `main` for development).

---

## Developers

Local UI + sync helper (needs [Node.js LTS](https://nodejs.org)):

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) → **Settings**.

### Desktop tray (dev machine)

```bash
npm run build
npm run desktop
```

Or double-click **`Start Arrs Hub.bat`** (runs install/build if needed, then Electron). Optional: **`install-startup.bat`** for Desktop + Startup shortcuts. See **`SETUP-AT-HOME.txt`** for the older folder-based Plex PC path.

### Build the Windows installer

```bash
npm install
npm run dist:win
```

Artifacts land in **`release/`** (gitignored):

- `Arrs Hub-<version>-x64.exe` — NSIS installer
- `Arrs Hub-<version>-portable.exe` — portable

Upload those to a [GitHub Release](https://github.com/machineshop44/arrs-hub/releases). Do not commit `.exe` files to the repo.

If Electron’s download fails TLS on Windows, retry with:

```bash
set NODE_OPTIONS=--use-system-ca
npm run dist:win
```

Alias: `npm run build:win` (same as `dist:win`). Dir-only unpackaged build: `npm run pack:win`.

---

## Example

| App | Home URL | Remote URL |
|-----|----------|------------|
| Sonarr | `http://192.168.1.50:8989` | `https://sonarr.mydomain.com` |
| Radarr | `http://192.168.1.50:7878` | `https://radarr.mydomain.com` |
| Plex | `http://192.168.1.50:32400/web` | `https://app.plex.tv` |

Use **Auto** (default) to pick Home vs Remote from your network. Remote URLs are optional.

## Included services

Sonarr, Radarr, Lidarr, Readarr, Whisparr, Prowlarr, qBittorrent, SABnzbd, Ombi, Overseerr, Tautulli, FileFlows, Bazarr, and Plex — each with the correct default port pre-filled. Toggle unused apps off in Settings.

## Tips

- **Bookmark it** — set as your browser homepage for one-click access to your whole stack
- **Same network** — Home URLs use your server's local IP (or `localhost` on the Plex PC)
- **Away from home** — switch to Remote and use your domain, VPN address, or port-forwarded public IP

## Tech

React + Vite UI, Express sync/watchdog server, Electron tray shell. Packaged Windows builds bundle Electron’s Node — no system Node install for end users.
