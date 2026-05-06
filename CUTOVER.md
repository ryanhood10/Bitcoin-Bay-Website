# Bitcoin Bay Redesign — Cutover Status

> **Status: historical artifact.** The 2025 redesign cutover is long-merged
> and deployed. This doc is kept for reference; the URL table below
> reflects the state right before the cut, not the current site. For the
> live architecture, see [CLAUDE.md](CLAUDE.md).

## Current state — CUTOVER COMPLETE LOCALLY (not yet deployed)

The new design is now wired to the live URLs. Old pages are kept on disk and reachable via `/legacy/*` for rollback. Heroku has not been touched.

| URL | Serves | File |
|---|---|---|
| `/` | **NEW** | `index.new.html` |
| `/leaderboard` | **NEW** | `leaderboard.new.html` |
| `/register` | **NEW** | `register.new.html` |
| `/HowTo` | old (unchanged) | `howto.html` |
| `/termsandcond.html` | old (unchanged static) | `termsandcond.html` |
| `/legacy` | old | `index.html` (rollback) |
| `/legacy/leaderboard` | old | `leaderboard.html` (rollback) |
| `/preview` | **NEW** | `index.new.html` (link-share alias) |
| `/preview/leaderboard` | **NEW** | `leaderboard.new.html` (link-share alias) |
| `/preview/register` | **NEW** | `register.new.html` (link-share alias) |
| anything else | 404 | branded 404 page |

All internal links inside the new pages now point at the live URLs (`/`, `/leaderboard`, `/register`), not `/preview/*`.

## What was verified end-to-end

Smoke test against `node server.js` running locally:

```
  /                         200
  /leaderboard              200
  /register                 200
  /HowTo                    200
  /legacy                   200
  /legacy/leaderboard       200
  /preview                  200
  /preview/leaderboard      200
  /preview/register         200
  /not-a-real-page          404
```

Static checks:

- `server.js` parses clean (`node --check`)
- All inline `<script>` blocks in the 3 new HTML files parse clean
- HTML tag open/close counts balance in all 3 files
- Zero leftover `/preview` references in any href on the live pages
- `/api/leaderboard` returns `{leaderboard, volumeNeeded, subheading, userDate}` — exactly the keys `leaderboard.new.html` consumes
- Login form: `action=https://wager.bitcoinbay.com/redirectlogin.php`, `name="username"` + `name="password"`
- Signup form: `action=https://wager.bitcoinbay.com/sites/bitcoinbay.ag/createAccount.php`, `target="iframecreate"`, all 6 wager field names match (`firstname`, `lastname`, `email`, `password`, `phone`, `promo`)
- Password-reveal button has `type="button"` (no accidental submits)
- reCAPTCHA v2 site key unchanged
- `/send-email` fetch payload uses camelCase keys matching what `server.js` destructures

## Local testing — your turn

```bash
cd ~/Projects/BitcoinBay/Bitcoin-Bay-Website
node server.js
```

Then in Chrome (open DevTools, toggle device toolbar to switch desktop ↔ mobile):

1. **http://localhost:8800/** — new sign-in landing.
   - Confirm vertical spacing is no longer congested at top/bottom.
   - Try a real wager login. Should redirect into the wager backend exactly like before.
2. **http://localhost:8800/leaderboard** — new VIP top 10.
   - Should auto-fetch real leaderboard data and render rows.
   - The "Join Bitcoin Bay" CTA should land on `/register`.
3. **http://localhost:8800/register** — new create-account form.
   - reCAPTCHA widget should render.
   - Submit a throwaway test account. Confirm:
     - Hidden iframe response from `createAccount.php` (DevTools → Network)
     - Email arrives at `bitcoinbaynotifications@gmail.com` with all 5 fields
     - Success panel appears
4. **http://localhost:8800/not-a-real-page** — branded 404.
5. **http://localhost:8800/legacy** — old design still reachable for rollback diffing.

## Rollback (if anything's wrong)

Edit `server.js`, swap the live route handlers back to the old filenames:

```js
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));   // <- was index.new.html
});
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'leaderboard.html'));  // <- was leaderboard.new.html
});
// optionally remove the /register route
```

That's it — three lines and you're back on the old design. The old files are still on disk.

## What's left (you handle these)

- **Heroku deploy** — not done, per your request. When you're ready, just `git add . && git commit && git push heroku main` (or however your deploy is configured). The Procfile already says `web: node server.js`.
- **Heroku env vars** — confirm `EMAIL` and `PASSWORD` are set in Heroku config vars so `/send-email` works in production.
- **reCAPTCHA domain whitelist** — site key is unchanged from the old site, so it should already be whitelisted for `bitcoinbay.com`. Don't assume it works on a new staging subdomain without checking the reCAPTCHA admin console.
- **Decisions still pending from earlier audit:**
  - Sendlane marketing pixel — not ported (old code comment said to delete; tell me if you actually still want it)
  - "Forgot password?" link on the new login form — not added; tell me where it should go if you want one
  - `howto.html` and `termsandcond.html` redesign — not ported (new repo didn't include them); decide later
  - Analytics (GA, Facebook Pixel, etc.) — none found in old `index.html`; tell me what to add if needed
  - Nav link to `/HowTo` — new pages don't surface it; tell me if you want it added

## Files changed in this session

- `server.js` — flipped `/`, `/leaderboard`; added `/register`; added `/legacy/*` rollback routes; kept `/preview/*` as link-share aliases; added 404 catch-all
- `index.new.html` — ported from `btccb-updated-final`; spacing fix; form wiring; OG/Twitter tags; live-URL internal links; terms link normalized
- `leaderboard.new.html` — ported; OG/Twitter tags; live-URL internal links
- `register.new.html` — ported with all old-form parity (extra fields, reCAPTCHA, phone format, validation, send-email payload); OG/Twitter tags; live-URL internal links
- `bb-logo.png`, `favicon.png` — copied from `btccb-updated-final`
- `CUTOVER.md` — this file
