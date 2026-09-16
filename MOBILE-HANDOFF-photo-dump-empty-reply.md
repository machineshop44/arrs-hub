# Hub handoff — photo dump empty reply on duplicate/auth

## Bug
`rejectPhotoDumpBody` called `req.destroy()` **before** sending JSON. Mobile then saw HTTP 0 / empty reply.

Symptoms: retry after a partial dump shows e.g. **1 verified, 9 failed** — the 9 were already on Hub (duplicate skip) but the socket was killed before the duplicate JSON arrived.

## Fix (applied in this repo)
`server/index.mjs`:
- Replaced destroy with `drainPhotoDumpBody` (`req.resume()` only)
- Always **send the response first**, then drain
- Version bump → **1.3.65**

## Required on Hub PC
Rebuild/restart Arrs Hub so remote `http://67.84.101.14:3000/api/health` reports **1.3.65+**.

Quick check after restart:
```bash
curl -s -o - -w "\nHTTP=%{http_code}\n" -X POST \
  -H "Content-Type: application/octet-stream" \
  --data-binary "hi" \
  http://127.0.0.1:3000/api/photo-dump/upload
```
Expect **HTTP=401** with JSON error (not empty reply / HTTP 000).
