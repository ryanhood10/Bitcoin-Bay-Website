# Admin Dashboard — what & where

Internal analytics dashboard at `/admin/dashboard`. Ported from the Flask
`bcbay_reports_server.py` that used to run on the Pi and exposed via a
cloudflared tunnel. Now lives inside the bitcoinbay.com Express app and
shares its admin auth.

## The 4 files

| File | Role |
|---|---|
| `adminAuth.js` | Shared auth module — cookie signing/verifying, `requireAdmin(role)` middleware factory, Mongo admin lookup, bcrypt password compare. Used by both `/admin/messages` and `/admin/dashboard`. |
| `adminDashboard.js` | Express router: serves the HTML at `/admin/dashboard`, all `/api/admin/dashboard/*` JSON endpoints, plus `/api/admin/dashboard/me` (identity). |
| `authInstagram.js` | Express router for IG OAuth (`/auth/instagram/connect`, `/callback`, `/status`) and the scrape-session cookie install page (`/auth/instagram/scrape-session`). |
| `views/admin-dashboard.html` | Single-page dashboard. All HTML + CSS + JS inline. Talks only to `/api/admin/dashboard/*` and `/auth/instagram/status`. |

Plus `scripts/manage-admins.js` — CLI to add/list/remove/set-password/set-role
on Mongo-stored admins. See [ADMIN_ROLES.md](ADMIN_ROLES.md).

## Data flow (at 10,000 ft)

```
Raspberry Pi (cron)                Heroku (this app)            User's browser
─────────────────────              ─────────────────            ──────────────
bcbay_daily_report.py      ─┐
bcbay_twitter_engagement.py ─┼─► Mongo Atlas ◄──── adminDashboard.js ───► admin-dashboard.html
bcbay_instagram_engagement.py ─┘  (bcbay_automation db)     (Express routes)     (fetch /api/admin/dashboard/*)
bcbay_run_jobs_poller.py   ◄── drains bcb_run_jobs ◄── POST /.../run
```

Pi writes. Heroku reads. Dashboard UI renders. One Mongo cluster
(`bcbay_automation` database) is the contract between them.

## Mongo collections

All in the `bcbay_automation` database.

| Collection | Schema (high points) | Written by |
|---|---|---|
| `daily_reports` | one doc per date; `twitter`, `instagram`, `ga4`, `gsc`, `mongodb_users`, `tickets` sub-objects | `bcbay_daily_report.py` (Pi, nightly) |
| `bcb_engagement_drafts` | Twitter reply drafts | `bcbay_twitter_engagement.py` (Pi, 3×/day) |
| `bcb_instagram_drafts` | IG comment drafts | `bcbay_instagram_engagement.py` (Pi, 3×/day) |
| `bcb_signups` | signup attempt audit log | `server.js` (bitcoinbay.com registrations) |
| `bcb_auth_tokens` | IG OAuth token + scraping session cookie | `authInstagram.js` (Heroku) |
| `bcb_admin_users` | additional admin accounts | `scripts/manage-admins.js` CLI |
| `bcb_run_jobs` | "Run now" job queue | `adminDashboard.js` POSTs, Pi poller consumes |
| `bcb_messages` / `bcb_thread_state` / `bcb_player_info` | player messaging | `messagesSync.js` (separate subsystem) |

Passwords are projected OUT of `bcb_signups` reads. Never logged.

## Endpoint map (all require admin auth)

```
GET  /admin/dashboard                                 — HTML (any admin)
GET  /api/admin/dashboard/me                          — { user, role }
GET  /api/admin/dashboard/report?date=...             — latest or specific daily report
GET  /api/admin/dashboard/reports?days=N&fields=...   — historical slice for charts
GET  /api/admin/dashboard/dates                       — list of report dates
GET  /api/admin/dashboard/signups?status=...          — signup audit rows (passwords stripped)
GET  /api/admin/dashboard/tickets/live                — open-thread summary + row list
GET  /api/admin/dashboard/engagement-drafts           — Twitter drafts
PATCH /api/admin/dashboard/engagement-drafts/:id      — update status
GET  /api/admin/dashboard/engagement-drafts/stats     — counts
POST /api/admin/dashboard/engagement-drafts/run       — queue Twitter finder on Pi
GET  /api/admin/dashboard/instagram-drafts            — (same shape, IG drafts)
PATCH /api/admin/dashboard/instagram-drafts/:id
GET  /api/admin/dashboard/instagram-drafts/stats
POST /api/admin/dashboard/instagram-drafts/run

GET  /auth/instagram/connect            — role: full  → 302 to Instagram OAuth
GET  /auth/instagram/callback           — public (IDP redirects here); state-checked
GET  /auth/instagram/status             — any admin, returns token state
GET  /auth/instagram/scrape-session     — role: full  → HTML cookie-refresh form
POST /auth/instagram/scrape-session     — role: full  → validate + save cookie
```

## How to extend

### Add a new metric to an existing platform (e.g. Twitter)

1. **Pi side** (`bcbay_daily_report.py`'s `collect_twitter`): compute it, add to
   the returned dict.
2. **Client side** (`views/admin-dashboard.html`):
   - Add the field name to `HISTORY_FIELDS` array so `/api/admin/dashboard/reports`
     includes it.
   - Add to `TWITTER_METRICS` dict (label, pick function, color, fmt).
   - Add a kmetric box to `renderTwitterAnalytics()`.

No Node changes needed — the server just forwards Mongo docs.

### Add a new platform

1. **Pi**: new `collect_<platform>(date_info)` in `bcbay_daily_report.py`,
   add to `collectors` list + `CRED_CHECKS`.
2. **Client**: new `<PLATFORM>_STATE` + `<PLATFORM>_METRICS` + `render<Platform>Analytics`.
3. **Social Media section**: add a `socialCard` call in the layout grid.

### Add a role-gated feature

Wrap the Express route with `adminAuth.requireAdmin('full')` (full-only) or
`adminAuth.requireAdmin()` (any admin). Client-side: call
`canAccessMessages()` from the dashboard's inline JS — it returns true iff
`CURRENT_ADMIN.role === 'full'`.

## Common gotchas

- **Cookie secret mismatch**: both servers (adminMessages + adminDashboard)
  read `ADMIN_SESSION_SECRET` from env. A mismatch means every cookie is rejected.
- **Mongo URI**: we read `MONGO_AUTOMATION_URI` first, fall back to `MONGO_URI`.
  They point at the same Atlas cluster in this app, so either works. On the
  Pi, `MONGO_AUTOMATION_URI` is always set.
- **Path collision**: the dashboard router adds `/api/admin/dashboard/*` —
  NEVER `/api/admin/*` catch-all — so it doesn't shadow `/api/admin/threads`
  etc. from the messaging dashboard. There's a unit test for this
  (`tests/admin-dashboard-api.test.js → 'does not shadow'`).
- **Run Now latency**: `POST /.../run` queues a Mongo job. Pi polls once a
  minute (`bcbay_run_jobs_poller.py`). So the user waits up to 60s before
  the Python script even starts.
