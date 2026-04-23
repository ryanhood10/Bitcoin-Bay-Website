# Admin Roles & Auth

Two roles, one shared login cookie, backwards-compatible with the original
single-admin setup.

## Roles

| Role | Access |
|---|---|
| `full` | `/admin/messages` (player tickets) + `/admin/dashboard` + `/auth/instagram/*` |
| `dashboard` | `/admin/dashboard` only |

Role is determined at login and baked into the signed cookie. Middleware
`adminAuth.requireAdmin('full')` returns 403 for `dashboard` users. The
dashboard UI additionally hides buttons that link into `/admin/messages`
(via the `canAccessMessages()` helper).

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
- Payload: `{ user, role, iat, exp }` (older cookies without `role` default to `full` for back-compat)
- Signing: HMAC-SHA256 with `ADMIN_SESSION_SECRET` (must be ≥24 chars)

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
```

Username is stored lowercase; lookups are case-insensitive. Passwords are
bcrypt'd at cost 12.

## Current roster (as of last check)

```
Env admin:      @admin          role=full
Mongo admins:
  @bitcoinbay     role=full
  @goadma         role=dashboard
  @palmbeachpete  role=full
```

## Login redirect behavior

After successful POST to `/admin/login`:
- role=`full`      → `/admin/messages`  (lands on tickets)
- role=`dashboard` → `/admin/dashboard` (lands on analytics)

Either role can navigate to the other page (if allowed) via UI links:
- messages page has a `Dashboard →` link in the header (full admins always)
- dashboard's tickets modal has `Open admin →` / per-thread `Reply ↗`, both
  conditionally rendered via `canAccessMessages()` (only for full role)

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
