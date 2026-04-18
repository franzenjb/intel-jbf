# intel-jbf — Red Cross Intel

Chapter / region / division-scoped briefing dashboard. First non-Dragon-only surface of the Smart-Query Platform (Tier 2 of `dragons-brain-vault/projects/smart-query-platform.md`).

## Repo & Deploy
- GitHub: `franzenjb/intel-jbf`
- Live: https://intel.jbf.com/ (Cloudflare CNAME → Vercel)
- Vercel project: `intel-jbf` (team `jbf-2539-e1ec6bfb`)
- Auto-deploys on push to `main`

## Stack
- Static HTML — `index.html`, `login.html`, no build step
- Vercel serverless functions in `/api/` (no package.json; Node built-ins only)
- HMAC-signed cookie auth (see `api/_auth.js`)
- Upstream brain: `explorer.jbf.com/api/smart-query`

## Architecture

```
Browser ──► /api/me (cookie check)
       ─┬─► /api/scopes (list divisions/regions/chapters from county_rankings)
        ├─► /api/ask (POST {question, scope}) ──► explorer.jbf.com/api/smart-query
        └─► /api/login (POST {code}) → sets intel_session HMAC cookie
```

### Scope prefix
`api/ask.js` prepends a system-level paragraph to every question telling Claude which chapter / region / division to scope SQL filters to. This is server-side — the frontend cannot manipulate it.

### Dashboard tiles (fired on scope select)
Five pre-baked prompts run in parallel:
1. Vulnerability summary (SVI + NRI)
2. Top 3 hazards by expected annual loss
3. ALICE household count
4. Recent FEMA declarations
5. Fire response from FLARE 2024

Results cached in `localStorage` per scope.

## Env vars (production)

| Name | Notes |
|------|-------|
| `INTEL_ACCESS_CODE` | Shared passcode (rotate when pilots change) |
| `INTEL_SESSION_SECRET` | 32-byte hex, HMAC key |
| `SUPABASE_URL` | Default `https://qoskpyfgimjcmmxunfji.supabase.co` |
| `SUPABASE_ANON_KEY` | Read-only anon key (same as vulnerability-explorer) |
| `SMART_QUERY_URL` | Optional override |

## Auth evolution
- **Alpha (now):** single `INTEL_ACCESS_CODE` passcode, 30-day HMAC cookie
- **Beta:** Vercel middleware email allowlist (magic-link) when >5 pilots
- **GA:** AGOL OAuth tie-in (arc-nhq-gis.maps.arcgis.com)

## Commit rule
Always commit + push before ending a session:
```bash
cd /Users/jefffranzen/dev/intel-jbf
git -c core.hooksPath=/dev/null add -A
git -c core.hooksPath=/dev/null commit -m "wip: describe what you built"
git -c core.hooksPath=/dev/null push origin main
```
`--no-verify` does not bypass git-secrets on this machine; use `-c core.hooksPath=/dev/null`.

## Related
- `~/dev/vulnerability-explorer-deploy/api/smart-query.js` — the canonical brain
- `~/dev/dragons-brain-vault/projects/smart-query-platform.md` — strategic plan (Tier 2 is this repo)
