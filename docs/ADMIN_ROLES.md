# Admin Roles & Auth

Two roles + a per-user capability layer (Phase 10), one shared login
cookie, backwards-compatible with the original single-admin setup.

## Roles

| Role | Default sections (effective access) |
|---|---|
| `full` | messaging · analytics · users · tickets · engagement · social_metrics · content_drafter · bonus_calculator |
| `dashboard` | analytics · users · tickets · engagement · social_metrics |

Role is determined at login and baked into the signed cookie. Middleware
`adminAuth.requireAdmin('full')` returns 403 for `dashboard` users.

Cost-bearing routes that hit paid APIs (Anthropic, Replicate) — content
drafter, AI scene generation — are gated by the `content_drafter` section
(see capability layer below). Bonus calculator stays `full`-role-only
since it touches a public-leaderboard write that we want to keep narrow.

## Per-user capability layer (Phase 10)

The 2-role system was too coarse for a social-media manager who needs the
content drafter (`full`-only by default) but should NOT see Support
Tickets (visible to all admins by default). Two arrays on each Mongo
admin doc layer on top of the role:

- `granted_sections` — capabilities beyond the role default (e.g. give a
  dashboard-role user `content_drafter` access)
- `denied_sections` — subtractions from the role default (e.g. hide
  `tickets` from a specific admin)

Effective access = `(role_default ∪ granted) − denied`.

Section keys (from `adminAuth.SECTIONS`):

| Key | What it controls |
|---|---|
| `messaging`        | `/admin/messages` player-reply UI |
| `analytics`        | GA4 + signups + Twitter/IG metrics on `/admin/dashboard` |
| `users`            | signups panel |
| `tickets`          | open-thread support panel + `/api/admin/dashboard/tickets/live` |
| `engagement`       | engagement-drafts (Pi-suggested replies) panels + endpoints |
| `social_metrics`   | Twitter+IG analytics widgets |
| `content_drafter`  | `/admin/dashboard/content` + all `/post-drafts/*` endpoints |
| `bonus_calculator` | `/admin/dashboard/bonus-calculator` (currently still role-gated to `full`; section grant has no effect) |

Server-side enforcement: the `requireSection(name)` middleware sits AFTER
`requireAdmin()` on each gated endpoint. Returns 403 with
`"section X not accessible by this admin"` if the user doesn't have it.

Client-side: `/api/admin/dashboard/me` returns `effective_sections`. The
analytics dashboard hides the Tickets panel + Content Drafts nav card
based on this. Defense-in-depth — the server still gates the data.

## Login redirect

After successful POST to `/admin/login`, in priority order:

1. **`admin.landing_page`** (per-user, if set) — explicit override
2. **role default**: `full` → `/admin/messages`, `dashboard` → `/admin/dashboard`

## Where admins live

Two tiers, checked in this order at login:

1. **Env-var admin** — `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` in Heroku
   config. Always role `full`. This is the bootstrap account — Ryan's
   original admin. Can't be removed by CLI.
2. **Mongo collection** `bcbay_automation.bcb_admin_users` — additional
   admins. Each doc: `{ username (lowercase), password_hash, role, created_at, last_login_at }`.

Login code:
```js
// adminMessages.js POST /admin/login
const admin = await adminAuth.findAdmin(username);   // env → mongo
const passOk = await adminAuth.verifyPassword(password, admin.passwordHash);
if (passOk) adminAuth.setSessionCookie(res, admin.username, admin.role);
```

## Cookie

- Name: `bcb_admin`
- TTL: 30 days
- Payload: `{ user, role, granted_sections, denied_sections, landing_page, iat, exp }`
  (older cookies without these fields default to `full` role / empty arrays / null landing for back-compat)
- Signing: HMAC-SHA256 with `ADMIN_SESSION_SECRET` (must be ≥24 chars)
- After any capability change via the CLI, the affected admin must log out
  and back in for the cookie to refresh.

## Managing accounts — `scripts/manage-admins.js`

Run via `heroku run` so Mongo connectivity + Node deps are available:

```bash
# List all
heroku run -a bitcoin-bay node scripts/manage-admins.js list

# Add
heroku run -a bitcoin-bay node scripts/manage-admins.js add <username> <password> <full|dashboard>

# Remove
heroku run -a bitcoin-bay node scripts/manage-admins.js remove <username>

# Change password (password ≥ 8 chars)
heroku run -a bitcoin-bay node scripts/manage-admins.js set-password <username> <password>

# Change role
heroku run -a bitcoin-bay node scripts/manage-admins.js set-role <username> <full|dashboard>

# ── Per-user capability commands (Phase 10) ──

# Grant a capability beyond the role default (operator must re-login to refresh cookie)
heroku run -a bitcoin-bay node scripts/manage-admins.js grant-section <username> <section>

# Revoke a previously-granted capability
heroku run -a bitcoin-bay node scripts/manage-admins.js ungrant-section <username> <section>

# Subtract a capability from the role default (operator must re-login)
heroku run -a bitcoin-bay node scripts/manage-admins.js deny-section <username> <section>

# Remove a denial
heroku run -a bitcoin-bay node scripts/manage-admins.js undeny-section <username> <section>

# Set login redirect target (use "" to clear back to role default)
heroku run -a bitcoin-bay node scripts/manage-admins.js set-landing-page <username> <path>

# Print full admin doc + resolved effective sections
heroku run -a bitcoin-bay node scripts/manage-admins.js show <username>
```

Section keys: `messaging`, `analytics`, `users`, `tickets`, `engagement`,
`social_metrics`, `content_drafter`, `bonus_calculator`. Note that
`bonus_calculator` is gated by `requireAdmin(ROLE_FULL)` directly —
granting/denying it has no effect on access.

Username is stored lowercase; lookups are case-insensitive. Passwords are
bcrypt'd at cost 12.

## Current roster (as of last check)

```
Env admin:        @admin          role=full
Mongo admins:
  @bitcoinbay     role=full
  @palmbeachpete  role=full
  @goadma         role=dashboard
                  granted_sections: [content_drafter]
                  denied_sections:  [tickets]
                  landing_page:     /admin/dashboard
                  → effective: analytics, content_drafter, engagement, social_metrics, users
                  (Goadma is the social-media manager — Twitter + IG. He
                   reviews + approves the daily content drafts and watches
                   the social metrics that show how those posts convert
                   to signups. He does NOT touch player support tickets
                   or the weekly bonus leaderboard.)
```

## Recipe: add a new content-team admin

```bash
# 1. Create with dashboard role (no full-admin spend exposure by default)
heroku run -a bitcoin-bay node scripts/manage-admins.js add jane Hunter1! dashboard

# 2. Grant content drafter access
heroku run -a bitcoin-bay node scripts/manage-admins.js grant-section jane content_drafter

# 3. (optional) Hide tickets if they shouldn't see player support
heroku run -a bitcoin-bay node scripts/manage-admins.js deny-section jane tickets

# 4. (optional) Land them on the analytics dashboard, not messages
heroku run -a bitcoin-bay node scripts/manage-admins.js set-landing-page jane /admin/dashboard

# 5. Verify resolved state
heroku run -a bitcoin-bay node scripts/manage-admins.js show jane
```

## Rate limiting

Per-IP login attempts: 5 per 15 min. Hit the limit → 429 + 15-min cooldown.
Counter is in-memory in `adminMessages.js` `_loginAttempts` map — wiped on
dyno restart, which is acceptable (attacker has to start over too).

## Security notes

- `ADMIN_SESSION_SECRET` must be ≥24 chars. A placeholder triggers a
  console warning and defaults to an insecure dev string.
- Cookie: `httpOnly`, `sameSite=lax`, `secure` only when `NODE_ENV=production`.
- Cookie tamper triggers constant-time HMAC mismatch → null session.
- bcrypt compare is constant-time. On "user not found" we run a dummy bcrypt
  to keep login timing uniform (prevents username enumeration).

## Tests

`tests/admin-auth.test.js` (18 tests):
- Cookie round-trip, tamper, expiry, malformed input
- `setSessionCookie` cookie shape
- `requireAdmin` middleware: unauth → 401/redirect based on Accept header,
  full-only routes reject dashboard users, back-compat for role-less legacy cookies
- `findAdmin` env fallback + lowercase + trim
- `verifyPassword` bcrypt wrapper

Run: `npm test`
