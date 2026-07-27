# Arr's Hub

A simple, all-in-one dashboard for your Plex and *arr stack. No Docker, no backend — just open the page, enter your IPs and ports, and click to launch Sonarr, Radarr, Prowlarr, Tautulli, Ombi, qBittorrent, SABnzbd, and more.

## Setup (3 steps)

1. Install and run:
   ```bash
   npm install
   npm run dev
   ```
2. Open [http://localhost:3000](http://localhost:3000) and click **Settings**
3. For each app, enter:
   - **Home** — your local network address, e.g. `http://192.168.1.50:8989`
   - **Remote** (optional) — your external address, e.g. `https://sonarr.yourdomain.com`

That's it. Settings save automatically in your browser.

Use the **Home / Remote** toggle at the top to switch which addresses the dashboard links to.

## Example

| App | Home URL | Remote URL |
|-----|----------|------------|
| Sonarr | `http://192.168.1.50:8989` | `https://sonarr.mydomain.com` |
| Radarr | `http://192.168.1.50:7878` | `https://radarr.mydomain.com` |
| Plex | `http://192.168.1.50:32400/web` | `https://app.plex.tv` |

You can use a full URL (`http://192.168.1.50:8989`) or whatever format your apps use. Remote URLs are optional — leave them blank if you only use the dashboard at home.

## Included services

Sonarr, Radarr, Lidarr, Readarr, Whisparr, Prowlarr, qBittorrent, SABnzbd, Ombi, Overseerr, Tautulli, FileFlows, Bazarr, and Plex — each with the correct default port pre-filled.

Toggle off any apps you don't use in Settings.

## Running without `npm run dev`

Build once and open the static files anytime:

```bash
npm run build
```

Then open `dist/index.html` in your browser, or serve the `dist` folder with any simple web server. No install needed after the build.

## Tips

- **Bookmark it** — set as your browser homepage for one-click access to your whole stack
- **Same network** — Home URLs use your server's local IP (find it in your router or NAS settings)
- **Away from home** — switch to Remote and use your domain, VPN address, or port-forwarded public IP

## Tech

React + Vite. All config lives in your browser's local storage. No accounts, no server-side setup.
