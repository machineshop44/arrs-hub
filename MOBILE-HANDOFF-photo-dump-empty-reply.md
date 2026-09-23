# Hub handoff — photo dump empty reply + rate limit

## Bugs fixed

### 1) Empty reply on duplicate/auth (1.3.65)
`rejectPhotoDumpBody` called `req.destroy()` before sending JSON → Mobile saw HTTP 0.

### 2) Rate limit too low for full phone dumps (1.3.66)
`RATE_MAX_UPLOADS` was **60/min**. Full dumps hit this and fail with:
`Upload rate limit exceeded — try again in a minute.`

Raised to **600/min** in `server/photo-dump.mjs`.

## Required on Hub PC
Rebuild/restart so `/api/health` reports **1.3.66+**.

On Mobile: check a failed item’s message — if it says rate limit, update Hub then retry failed only.
