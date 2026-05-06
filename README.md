# Bitcoin-Bay-Website

Customer-facing marketing site for **bitcoinbay.com**, plus a private admin
suite for the operator. Sits in front of the third-party price-per-head
betting backend at **wager.bitcoinbay.com**.

## What's in here

- **Public marketing site** (`/`, `/leaderboard`, `/register`,
  `/forgot-password`, `/reset-password`, `/blog`, `/blog/:slug`)
- **Account creation + password reset proxy** (`/api/register`,
  `/api/forgot-password`, `/api/reset-password`) — validates + reCAPTCHAs
  on our side, then calls the wager backend via [agentClient.js](agentClient.js)
- **Private admin messaging dashboard** (`/admin/login`, `/admin/messages`)
  — operator gets Pushover alerts when a player messages the agent and
  replies from our dashboard
- **Internal analytics dashboard** (`/admin/dashboard`) — GA4 + Search
  Console + signups + tickets + Twitter + Instagram metrics, plus the
  weekly bonus calculator at `/admin/dashboard/bonus-calculator`
- **Content drafter** (`/admin/dashboard/content`) — daily X + IG post
  drafts from the Pi's morning research brief, with optional Replicate
  InstantID 🎨 AI scene generation per card

## Local development

```bash
npm install
cp .env.example .env             # fill in real values
node server.js                   # http://localhost:8800
npm test                         # 97 tests, ~1s
```

## Deploy

```bash
git push origin main             # GitHub
git push heroku main             # Heroku rebuild + release
```

Heroku app: `bitcoin-bay`. The app is connected to MongoDB Atlas
(`bcbay_automation` database) and uses Heroku Config Vars for all secrets
— `.env` is local-dev only. The `node_modules` directory is committed
historically; Heroku's buildpack runs `npm install --production` on push
regardless.

## Documentation map

Start with [CLAUDE.md](CLAUDE.md) for the full architecture tour. Topic
deep-dives live under [docs/](docs/):

- [docs/ADMIN_DASHBOARD.md](docs/ADMIN_DASHBOARD.md) — files, data flow,
  Mongo collections, endpoint map, extension recipes
- [docs/ADMIN_ROLES.md](docs/ADMIN_ROLES.md) — `full` vs `dashboard`
  roles, where admins live, the `manage-admins.js` CLI
- [docs/CONTENT_CREATION_HANDOFF.md](docs/CONTENT_CREATION_HANDOFF.md) —
  the original strategy doc for the content drafter (voice, image
  strategy, compliance, Eldrin reference)
- [docs/CONTENT_CREATION_PLAN.md](docs/CONTENT_CREATION_PLAN.md) —
  phased build plan + Phase 4.1/4.5 amendments + recent-changes log

Historical docs (kept for reference, not actively maintained):

- [CLAUDE_CODE_HANDOFF.md](CLAUDE_CODE_HANDOFF.md) — handoff from the
  Cowork session that did the initial redesign port
- [CUTOVER.md](CUTOVER.md) — the redesign cutover plan from that same
  port

## Security

Local `.env` is git-ignored. Anyone with admin access to the Heroku app
can read Config Vars. Cookie signing uses `ADMIN_SESSION_SECRET` (must be
≥24 chars). Per-IP login rate limit is 5 attempts per 15 minutes.

For the agent-token chain, see "Agent auth" in [CLAUDE.md](CLAUDE.md).
