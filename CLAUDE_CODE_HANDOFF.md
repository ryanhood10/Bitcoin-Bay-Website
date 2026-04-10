# Bitcoin Bay Redesign — Handoff to Claude Code

## Should you move this work to Claude Code? **Yes, for the next phase.**

The Cowork session was a good fit for the *integration* phase: porting HTML files, wiring forms, fixing route handlers, and writing the cutover plan. All of that is done and verified.

The *next* phase (visual polish, content tweaks, mobile QA, deploy) is a tighter loop where you'll want to:

- run `node server.js` continuously and refresh the browser
- diff CSS changes visually
- iterate on copy/spacing/colors
- run `git add` / `git commit` / `git push heroku main` when ready

Cowork's bash sandbox spins up a fresh PID namespace per call, so background dev servers die between calls — that's why I couldn't drive Chrome against my own server during this session and had to hand off visual QA to you. Claude Code runs in your real terminal with a persistent shell, so a `node server.js` started in one turn stays alive across the whole conversation. It also has direct file editing without permission prompts, and a faster grep/edit loop.

**Bottom line:** open Claude Code in `~/Projects/BitcoinBay/Bitcoin-Bay-Website` and pick up from there.

## File locations (everything is on your Mac, no remote state)

```
~/Projects/BitcoinBay/Bitcoin-Bay-Website/
├── server.js                  ← LIVE: routes flipped to new design + 404 + /legacy/* rollback
├── package.json
├── Procfile                   ← web: node server.js (Heroku)
├── .env                       ← local only (EMAIL=, PASSWORD=)
│
├── index.new.html             ← NEW home (served at /)         — 1500+ lines
├── leaderboard.new.html       ← NEW leaderboard (served at /leaderboard) — has Top 20% card now
├── register.new.html          ← NEW signup (served at /register)
│
├── index.html                 ← OLD home (still served at /legacy)
├── leaderboard.html           ← OLD leaderboard (still at /legacy/leaderboard)
├── howto.html                 ← OLD howto, route removed; **delete this file**
├── termsandcond.html          ← OLD terms (still served as static)
├── original.html              ← unrelated old file
│
├── newimages/withdrawalScreenshot.png  ← howto-only asset, **delete**
├── videos/BitcoinBayDeposits.mp4       ← howto-only asset (15 MB), **delete**
│
├── bb-logo.png, favicon.png   ← copied in from new repo
├── images/                    ← shared old assets, leave alone
├── newimages/                 ← shared, leave alone (only the one file above is howto-only)
├── css/, js/, sites/, videos/ ← old static assets, leave alone
│
├── CUTOVER.md                 ← what was done + cutover plan + what's verified
└── CLAUDE_CODE_HANDOFF.md     ← this file
```

The other repo (`~/Downloads/BCB-updated/btccb-updated-final/`) is the source you ported from. Keep it around for reference until the new site is solid in production, then delete.

## What's done

- New design ported into existing repo, side-by-side with old files
- Live routes flipped: `/` → `index.new.html`, `/leaderboard` → `leaderboard.new.html`, `/register` → `register.new.html`
- `express.static` `{index: false}` fix so the route handlers actually run for `/`
- 404 catch-all with branded error page
- `/legacy` and `/legacy/leaderboard` routes for instant rollback diffing
- `/preview/*` aliases kept alive as link-share URLs
- All form wiring verified to match the old wager backend (login `redirectlogin.php`, signup `createAccount.php` + iframe target, exact field names, reCAPTCHA, `/send-email` payload)
- Cross-page links rewritten from `/preview/*` to live URLs
- Open Graph + Twitter card meta tags added to all 3 new pages
- Spacing fix on the new homepage (was clipping top/bottom — was a `position: fixed; overflow: hidden` trap)
- `/HowTo` route removed (file still on disk; needs manual delete)
- New leaderboard now displays `data.volumeNeeded` in a "Enter the Top 20%" card matching the old design's content

All inline JS in the new files parses clean (`node --check`). Tag counts balance. All routes return correct HTTP status (verified via curl against a local server).

## What's NOT done — pick this up in Claude Code

### Immediate cleanup (1 minute)

```bash
cd ~/Projects/BitcoinBay/Bitcoin-Bay-Website
rm howto.html newimages/withdrawalScreenshot.png videos/BitcoinBayDeposits.mp4
```

(Cowork file deletion needed permission you didn't grant — easier to just `rm` them yourself.)

### Visual QA (15-30 minutes)

```bash
node server.js
```

Open `http://localhost:8800/` in Chrome with DevTools → device toolbar. Walk through:

1. **`/`** — desktop and mobile. Confirm vertical spacing isn't congested. Try a real wager login.
2. **`/leaderboard`** — confirm it loads real data and the "Enter the Top 20%" card shows the threshold value.
3. **`/register`** — confirm reCAPTCHA renders, submit a throwaway test, confirm email arrives at `bitcoinbaynotifications@gmail.com`.
4. **`/not-a-real-page`** — confirm branded 404.
5. **`/legacy`** — old site reachable for diffing.

### Decisions still pending (from earlier audit)

These weren't blockers so I left them for you:

- **Sendlane marketing pixel** in old `index.html` — not ported (the inline comment in `index.html` literally says "Bullshit Sendlane stuff for Ryan's Marketing that i will delete later"). If you actually still want it, port the `<script>` block from old `index.html` lines ~50-60 into `index.new.html` `<head>`.
- **"Forgot password?" link** on the new login form — not present in the new design. Check old site to see where it pointed (probably a wager backend URL).
- **`termsandcond.html` redesign** — new repo didn't include a redesigned version. Still served as the old design at `/termsandcond.html`. Decide: redesign to match, or leave.
- **Analytics** — no GA / Pixel found in old `index.html` (only Sendlane). If you have GA at the Cloudflare/Heroku edge, no action needed.
- **reCAPTCHA admin console** — confirm `bitcoinbay.com` (and any staging domain) are whitelisted for site key `6Ldo7BAqAAAAAEAM6cDjWvoDm6Tp9ryPorC5eeMV`.

### Heroku deployment

When local QA passes:

```bash
git status                          # review the diff
git add -A
git commit -m "Launch new homepage / leaderboard / register design"
git push heroku main                # or whatever remote your deploy uses
```

Then verify in production:

- `EMAIL` and `PASSWORD` config vars are set (`heroku config -a <app>`)
- Hit `https://bitcoinbay.com/` and confirm new design loads
- Hit `https://bitcoinbay.com/legacy` and confirm old design is still reachable as a rollback
- Submit a real test signup and confirm the notification email arrives

### Rollback

If anything goes wrong post-deploy, edit `server.js`:

```js
// Swap these back:
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));   // was index.new.html
});
app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'leaderboard.html'));  // was leaderboard.new.html
});
// Remove or comment out app.get('/register', ...)
```

Then `git commit -am "Rollback to old design" && git push heroku main`.

## Prompt to paste into Claude Code

```
I'm picking up a Bitcoin Bay redesign integration from a previous session.
The new design is already ported, wired up to the old wager.bitcoinbay.com
backends, and tested locally. Read CUTOVER.md and CLAUDE_CODE_HANDOFF.md in
this directory for the full state.

Working folder: ~/Projects/BitcoinBay/Bitcoin-Bay-Website
Live routes serve the new design (index.new.html, leaderboard.new.html,
register.new.html). Old files remain on disk; /legacy and /legacy/leaderboard
serve them as a rollback.

Tasks I want to do next, in order:

1. rm howto.html, newimages/withdrawalScreenshot.png,
   videos/BitcoinBayDeposits.mp4 — these are unused after removing /HowTo.

2. Start `node server.js` and walk through the local QA checklist in
   CUTOVER.md → "Local testing — your turn". Take screenshots at desktop
   (1440x900) and mobile (390x844) of /, /leaderboard, /register, and the
   404 page so I can sanity-check spacing.

3. Help me decide on the open items in CLAUDE_CODE_HANDOFF.md →
   "Decisions still pending" — Sendlane, forgot-password link,
   termsandcond redesign, analytics.

4. When I'm happy, walk me through the Heroku deploy and verify the new
   site is live. Don't push without my confirmation.

Key constraints carried forward from the previous session:
- Do NOT touch the existing form action URLs, field names, reCAPTCHA site
  key, or /send-email payload shape — those are wired to the wager backend
  and any change will break login/signup.
- Old index.html, leaderboard.html stay on disk as rollback. Don't delete.
- /preview/* routes are kept alive as link-share aliases. Don't delete.
```

That prompt is enough context for Claude Code to pick up exactly where this session ends.
