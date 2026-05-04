# Bitcoin Bay — CLAUDE.md

Context for Claude (or any dev) working in this repo. The short version: this is a small Node/Express app that acts as the customer-facing marketing site for **bitcoinbay.com**, sitting in front of a third-party price-per-head betting backend at **wager.bitcoinbay.com** (Bitcoin Bay resells the backend under its own brand).

## What this app does

Four broad capabilities:

1. **Public marketing site** — `/`, `/leaderboard`, `/register`, `/forgot-password`, `/reset-password`, `/blog`, `/blog/:slug`, static assets. All served from `server.js` with inline HTML templates or static files.

2. **Account creation & password reset proxy** — `/api/register` and `/api/forgot-password` + `/api/reset-password`. We validate + reCAPTCHA-check on our side, then call the wager backend's endpoints via [agentClient.js](agentClient.js) using a persistent auth chain (see "Agent auth" below).

3. **Private admin messaging dashboard** — `/admin/login`, `/admin/messages`. The operator (Ryan's brother) gets Pushover push notifications when a player messages the agent account, then replies from our dashboard. The reply posts back into the wager backend's `mailAgentNew` endpoint.

4. **Internal analytics dashboard** — `/admin/dashboard` + `/api/admin/dashboard/*`. Shared login with #3. Surfaces GA4, Search Console, signups, support tickets, Twitter, and Instagram metrics with over-time charts, plus AI-drafted engagement replies from the Pi's cron jobs. Also hosts the **Bonus Calculator** (`/admin/dashboard/bonus-calculator`, full-role only) — a stand-alone tool that takes weekly XLSX activity exports, computes the volume-weighted top-10 bonus leaderboard client-side via SheetJS, and upserts the result into the `weekly_leaderboard` collection that the public `/leaderboard` page reads from. See **[docs/ADMIN_DASHBOARD.md](docs/ADMIN_DASHBOARD.md)** and **[docs/ADMIN_ROLES.md](docs/ADMIN_ROLES.md)** for file tour + endpoint map + extension guides.

## Files that matter

```
server.js            ← Express bootstrap, all non-admin routes, email templates,
                       blog rendering, sitemap, 404 handler.
agentClient.js       ← Self-healing auth to wager.bitcoinbay.com. Handles JWT
                       refresh AND full fresh-login via TOTP when the chain
                       dies. Public helpers: updatePlayerPassword, getPlayerInfo,
                       listMessages, sendMessageToCustomer, sendOpsAlert.
messagesSync.js      ← Background poll of the wager inbox (every 3 min). Pulls
                       both inbox (type=0) and sent (type=1) buckets. Diffs
                       against Mongo, inserts new, fires operator alerts via
                       Pushover (falls back to Twilio if configured).
adminMessages.js     ← Express router for /admin/messages/*. Signed-cookie auth
                       (shared with dashboard), per-IP login rate limit, thread
                       list + resolve state, player-info cache, reply API.
adminAuth.js         ← Shared auth module — cookie sign/verify, role-aware
                       requireAdmin(role) middleware, Mongo admin lookup.
adminDashboard.js    ← Express router for /admin/dashboard + /api/admin/dashboard/*.
                       Reads analytics & engagement data from Mongo.
authInstagram.js     ← Express router for /auth/instagram/* (OAuth + scraping
                       cookie refresh page).
views/admin-dashboard.html ← Full SPA for the analytics dashboard. All inline.
views/bonus-calculator.html ← Stand-alone weekly-leaderboard tool. Drag-drop
                       XLSX, compute top-10 client-side via SheetJS, POST to
                       /api/admin/dashboard/bonus-report. Full-role admins only.
scripts/manage-admins.js ← CLI (heroku run) to add/list/update Mongo admins.
tests/*.test.js      ← node:test suite — auth module, dashboard API, IG OAuth,
                       bonus calculator. Run: npm test (48 tests).
package.json         ← Dependencies. node_modules is checked in (yes, really).
Procfile             ← web: node server.js for Heroku.
.env                 ← Local-only secrets. NEVER commit.
docs/                ← Deeper references for future work:
                       - ADMIN_DASHBOARD.md (architecture + extension points)
                       - ADMIN_ROLES.md     (auth/role model + CLI usage)
```

## Agent auth — the critical piece

`wager.bitcoinbay.com` hands out a short-lived JWT (~21 min). We maintain that JWT for **indefinite uptime** via the auth chain in [agentClient.js](agentClient.js):

1. **In-memory cache** → fast path on repeated calls.
2. **Mongo-persisted token** (`bcb_agent_token` collection) → survives dyno restart.
3. **`AGENT_TOKEN` env var seed** → manual override for emergencies.
4. **Fresh login** via POST `/authenticateCustomer` + POST `/OTPLoginWithCode`. We generate our own 2FA TOTP code from `AGENT_TOTP_SECRET` using RFC 6238. This is what makes us self-healing — no human needed with a phone.

The wager backend enforces a ~9-hour lifetime on the whole JWT refresh chain, so every ~9h we silently mint a brand-new chain via fresh login. If fresh login fails 3x in a row, `sendOpsAlert` emails `OPS_ALERT_EMAIL` (falls back to `EMAIL`).

**Background refresh loop** runs every 14 minutes so the token stays warm even on a low-traffic day — otherwise a user would hit a cold token on their first password reset of the morning.

## Message sync + alerts

`messagesSync.js` polls the wager inbox every 3 minutes. Two buckets are fetched in parallel:

- `type=0` = **inbox** (messages received, including from MY AGENT upstream + from players)
- `type=1` = **sent** (our agent's outbound messages)

Each is tagged with `direction: 'inbound' | 'outbound'` and inserted into Mongo. A message is flagged `is_player_message: true` when `direction === 'inbound' && FromType === 'C'` — this is the alert trigger.

**Alert pipeline** (`processAlertQueue`):
1. Query: unalerted player messages from the last 24h, excluding backfill.
2. Group by sender — 5 messages from one player collapse into one alert.
3. Send via Pushover if configured, else Twilio SMS, else skip.
4. Mark `alerted_at` only on success. Failed sends stay null and retry on the next sync cycle — 3-min Twilio/Pushover outages are invisible to the operator.

**Auto-reopen:** when a fresh inbound player message arrives for a thread previously marked "Done," the sync clears `resolved_at` in `bcb_thread_state`. The brother doesn't miss anything.

**First-run backfill:** on an empty Mongo, every existing message is inserted with `is_backfill: true, alerted_at: null`. No alerts fire. Only messages arriving **after** first sync trigger alerts.

## Mongo collections (db: `bcbay_automation`)

| Collection | Purpose | Key |
|---|---|---|
| `bcb_messages`       | Synced wager inbox + sent messages + our outbound replies | `wager_id` (unique) |
| `bcb_player_info`    | Cached `getPlayerInfo` result — name, email, phone | `_id` = player ID |
| `bcb_thread_state`   | Per-player resolved/completed state | `_id` = player ID |
| `bcb_agent_token`    | Persisted wager JWT + expiry | `_id = 'current'` |
| `bcb_signups`        | Signup audit log (success + failure) | auto |
| `bcb_reset_tokens`   | Password-reset tokens (single-use, 1h TTL) | `token` |
| `bcb_reset_log`      | Every password-reset attempt (rate-limit + audit) | auto |
| `bcb_admin_log`      | Every admin dashboard action (login, reply, resolve) | auto |
| `bcb_blog_posts`     | Blog content (pre-existing, separate admin flow) | `slug` |
| `weekly_leaderboard` | Weekly bonus leaderboard — top 10 `{rank, account}` per `{week_start, week_end}`. Public `/leaderboard` page reads from here. | `{week_start, week_end}` |

Indexes on `bcb_messages` are ensured on boot by `messagesSync.ensureIndexes()` — `wager_id` is unique.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `MONGO_URI` | yes | Connection string for MongoDB Atlas. |
| `EMAIL` / `EMAIL_PASSWORD` | yes | Gandi mailbox — welcome emails, reset emails, ops alerts are SENT from here. |
| `OPS_ALERT_EMAIL` | no | Where ops alerts are **delivered**. Falls back to `EMAIL` if unset. |
| `GoogleCaptchaSecretKey` / `RECAPTCHA_SECRET` | yes | reCAPTCHA v2 server secret. Either name works. |
| `AGENT_USERNAME` / `AGENT_PASSWORD` / `AGENT_TOTP_SECRET` | yes | Wager-backend credentials. TOTP secret is the base32 2FA seed from the portal. |
| `AGENT_TOKEN` | no | Optional JWT seed to skip one fresh login on first boot. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` | yes for /admin | bcrypt hash, 32+ char secret for HMAC cookie signing. Always resolves to role=`full`. Additional Mongo admins live in `bcb_admin_users` — see [docs/ADMIN_ROLES.md](docs/ADMIN_ROLES.md). |
| `MONGO_AUTOMATION_URI` / `MONGO_AUTOMATION_DB` | yes for /admin/dashboard | Usually same cluster as `MONGO_URI` (db `bcbay_automation`). Dashboard falls back to `MONGO_URI` if unset. |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` / `INSTAGRAM_REDIRECT_URI` / `INSTAGRAM_SCOPES` / `INSTAGRAM_ACCOUNT_HANDLE` | yes for /auth/instagram | Meta Developer app config for the IG Login OAuth flow. See [docs/ADMIN_DASHBOARD.md](docs/ADMIN_DASHBOARD.md). |
| `PUSHOVER_USER_KEY` / `PUSHOVER_APP_TOKEN` | preferred | Operator alerts. No US compliance overhead. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` / `TWILIO_FROM_NUMBER` / `OPERATOR_PHONE_NUMBER` | optional | SMS fallback. US 10DLC registration required for carrier delivery. |
| `SMS_QUIET_HOURS` | no | e.g. `"22-8"` → no alerts from 10pm–8am in `SMS_TIMEZONE`. |
| `SMS_TIMEZONE` | no | IANA name, default `America/Chicago`. |
| `NODE_ENV` | yes in prod | `production` turns on `secure` cookie flag. |
| `PORT` | no | Defaults to 8800 locally; Heroku provides this automatically. |

## Deploy

```bash
git push heroku <branch>:main    # Heroku builds from package.json, runs Procfile.
git push origin <branch>:main    # Keep GitHub origin/main in sync.
```

Heroku buildpack does `npm install --production` on every push, so the committed `node_modules/` is ignored in build — it's committed only because it was committed historically; no need to update it.

## Operator handoff

When ownership transfers to a new operator (or from Ryan to his brother):

- **Admin logins** are now multi-user (as of the dashboard port). The env-var admin still exists and stays role=`full`. Add new admins via `heroku run node scripts/manage-admins.js add <user> <pass> <full|dashboard>`. Details in [docs/ADMIN_ROLES.md](docs/ADMIN_ROLES.md).
- **Pushover** — each operator installs the Pushover app on their phone, grabs their User Key, and updates the single `PUSHOVER_USER_KEY` env var on Heroku. The `PUSHOVER_APP_TOKEN` stays the same (it identifies the app sending, not the person receiving).
- **Twilio** (if we switch back) — the `OPERATOR_PHONE_NUMBER` env var holds the destination. Change to the new operator's number.

## Debug tips

- **Token chain broken:** `heroku logs -a bitcoin-bay --tail` → look for `[agent]` lines. `performFreshLogin` succeeds when you see "fresh login succeeded, token exp in 20 min".
- **Operator not getting alerts:** first check `heroku logs` for `[sync] pushover alert sent` or failure messages. Then check Pushover's own dashboard → Application → Logs. Then check `bcb_messages` in Mongo for `is_player_message: true, alerted_at: null` — those are stuck in the queue.
- **Dashboard empty:** sync may not have run yet (3-min interval), or the inbox really is empty. Click **Refresh** in the top-right to force a sync from the UI.
- **Mongo full of test data:** `db.bcb_messages.deleteMany({})` resets the sync. Next boot will silent-backfill from the wager inbox.

## What NOT to touch

- **Form field names** on `register.html` / `forgot-password.html` — they have to match what the wager backend accepts. Changing `firstname` → `first_name` will silently break signup.
- **reCAPTCHA site key** in HTML — must match whitelist at Google's admin console.
- **`/legacy` and `/legacy/leaderboard`** — these are the pre-redesign rollback paths. Don't delete.
- **`bcb_agent_token` collection** — deleting the doc there forces a fresh login on next call, which is fine, but don't do it casually; if fresh login also fails (wrong TOTP secret etc.), password resets break.
