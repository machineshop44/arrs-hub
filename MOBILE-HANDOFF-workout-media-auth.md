# Hub handoff — workout media auth for VLC (from Mobile agent)

## Change already applied in this repo
`server/hub-auth.mjs` → `readHubApiToken` now also accepts query:
- `hubToken` (preferred)
- `token` (fallback)

Needed so external VLC / libVLC can play `/api/workouts/media/:ratingKey` remotely
(they cannot send `X-Arrs-Hub-Token`).

## Mobile
Arrs Hub Mobile appends `hubToken` on VLC direct URLs and sends the header on
media probes. Restart Hub (or rebuild exe) so this auth change is live.

Do not merge photo-dump key with Hub API token.
