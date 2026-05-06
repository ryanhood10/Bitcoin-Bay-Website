# Admin Dashboard — what & where

Internal analytics dashboard at `/admin/dashboard`. Ported from the Flask
`bcbay_reports_server.py` that used to run on the Pi and exposed via a
cloudflared tunnel. Now lives inside the bitcoinbay.com Express app and
shares its admin auth.

## The files

| File | Role |
|---|---|
| `adminAuth.js` | Shared auth module — cookie signing/verifying, `requireAdmin(role)` middleware factory, Mongo admin lookup, bcrypt password compare. Used by both `/admin/messages` and `/admin/dashboard`. |
| `adminDashboard.js` | Express router: serves the HTML at `/admin/dashboard`, all `/api/admin/dashboard/*` JSON endpoints (analytics + engagement + bonus + post-drafts), plus `/api/admin/dashboard/me` (identity). |
| `authInstagram.js` | Express router for IG OAuth (`/auth/instagram/connect`, `/callback`, `/status`) and the scrape-session cookie install page (`/auth/instagram/scrape-session`). |
| `contentDrafter.js` | Phase 3+ — daily X + IG post drafter. Reads `bcb_post_briefs` (Pi-written), runs three Claude prompts (twitter / instagram_single / instagram_carousel), writes `bcb_post_drafts`. CLI: `node contentDrafter.js --date YYYY-MM-DD [--dry-run]`. Lazy-loaded by `adminDashboard.js`. |
| `imageRenderer.js` | Phase 4+ — real-photo cascade (Wikimedia → Unsplash → Pexels) with intent-aware source ordering and off-topic Pexels rejection. BB-branded `sharp` SVG composites for promo subjects. Optional Replicate InstantID AI scene generation (operator-triggered via 🎨 button). Public helpers: `findHeroImage`, `findCarouselImages`, `composeBrandedCard`, `composeOverlayCard`, `saveDraftImages`, `generateAIScene`, `inferIntent`, `isBBSubject`. |
| `views/admin-dashboard.html` | Single-page dashboard. All HTML + CSS + JS inline. Talks only to `/api/admin/dashboard/*` and `/auth/instagram/status`. |
| `views/content-drafts.html` | Phase 5+ — single-page review/approve UI for daily X + IG drafts. Served at `/admin/dashboard/content` (full-role only). Per-card edit, regenerate, funny-twist, 🎨 generate-scene, skip, approve. Per-slide editor for IG carousels. |
| `views/bonus-calculator.html` | Stand-alone weekly-leaderboard tool served at `/admin/dashboard/bonus-calculator` (full-role only). XLSX upload + bonus math runs entirely client-side via SheetJS; only the final top-10 payload POSTs to `/api/admin/dashboard/bonus-report`. |

Plus `scripts/manage-admins.js` — CLI to add/list/remove/set-password/set-role
on Mongo-stored admins. See [ADMIN_ROLES.md](ADMIN_ROLES.md).

For the content-drafter feature in detail, see
[CONTENT_CREATION_HANDOFF.md](CONTENT_CREATION_HANDOFF.md) +
[CONTENT_CREATION_PLAN.md](CONTENT_CREATION_PLAN.md).

## Data flow (at 10,000 ft)

```
Raspberry Pi (cron)                Heroku (this app)              User's browser
─────────────────────              ─────────────────              ──────────────
bcbay_daily_report.py        ─┐
bcbay_twitter_engagement.py  ─┼──► Mongo Atlas ◄── adminDashboard.js ──► admin-dashboard.html
bcbay_instagram_engagement.py─┤   (bcbay_automation)  (Express)            (analytics SPA)
bcbay_research.py            ─┘                                         ┐
                                  contentDrafter.js writes ────────────┼──► content-drafts.html
                                  bcb_post_drafts ◄── reads brief from │   (operator review/approve SPA)
                                  bcb_post_briefs                      │
                                  imageRenderer.js renders/composites ─┤
                                  generateAIScene → Replicate (opt-in) ┘
bcbay_run_jobs_poller.py     ◄── drains bcb_run_jobs ◄── POST /.../run
```

Pi writes the daily research brief + engagement-side reply drafts. Heroku
runs the post drafter on top of the brief and serves both review surfaces.
One Mongo cluster (`bcbay_automation` database) is the contract between them.

External services touched only by Heroku:
- **Anthropic Claude API** — `contentDrafter.js` for X/IG post drafting
- **Wikimedia Commons / Pexels / Unsplash** — `imageRenderer.js` real-photo cascade
- **Replicate (InstantID)** — `imageRenderer.generateAIScene`, operator-triggered only via the dashboard 🎨 button (~$0.05/call, audit-logged)

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
| `weekly_leaderboard` | one doc per `{week_start, week_end}`; `bonuses[]` = top 10 `{rank, account}`; read by the public `/leaderboard` page | `views/bonus-calculator.html` → POST `/api/admin/dashboard/bonus-report` (full-role only) |
| `bcb_post_briefs` | one doc per `date` (YYYY-MM-DD); `per_platform_topics.twitter[]`, `per_platform_topics.instagram` (single OR carousel-with-slides), plus the broader research blob | `bcbay_research.py` (Pi, nightly) |
| `bcb_post_drafts` | per-platform post drafts (twitter / instagram_single / instagram_carousel). Lifecycle: `draft` → `approved` → `posted`/`skipped`. Carries text, hashtags, image_subject, image_overlay_text, image_scene_prompt, image_url, slides[] | `contentDrafter.js` writes; PATCH/regenerate/skip/approve/generate-art via `adminDashboard.js` |
| `bcb_admin_log` | every admin action (login, reply, resolve, bonus-report save, content-drafter run/regenerate/generate-art/skip/approve) | `adminMessages.js` + `adminDashboard.js` |

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

GET  /admin/dashboard/bonus-calculator        — role: full  → bonus calculator HTML page
GET  /api/admin/dashboard/bonus-reports       — role: full  → last N saved weekly leaderboards
POST /api/admin/dashboard/bonus-report        — role: full  → upsert one weekly leaderboard

GET  /admin/dashboard/content                            — role: full  → content drafts review/approve HTML
GET  /api/admin/dashboard/post-briefs/latest             — any admin   → today's brief metadata
GET  /api/admin/dashboard/post-drafts?date=&platform=&status= — any admin → list draft posts
PATCH /api/admin/dashboard/post-drafts/:id               — role: full  → edit text/caption/hashtags/slides/image_url/image_overlay_text/image_scene_prompt (slides may include overlay_x/overlay_y/overlay_color per slide for the drag editor)
POST /api/admin/dashboard/post-drafts/:id/regenerate     — role: full  → re-prompt Claude (body: { humor_pass?, slide_index?, new_angle? }); for Twitter drafts with `variants[]`, regenerates only the active variant
POST /api/admin/dashboard/post-drafts/:id/swap-variant   — role: full  → flip Twitter draft between meme + professional variants (no Claude call; both pre-generated)
POST /api/admin/dashboard/post-drafts/:id/generate-art   — role: full  → Replicate InstantID AI scene generation (~$0.05/call, audit-logged; 503 if REPLICATE_API_TOKEN unset)
POST /api/admin/dashboard/post-drafts/:id/regenerate-all-images — role: full  → re-runs imageRenderer.saveDraftImages on the draft; fire-and-forget (202)
POST /api/admin/dashboard/post-drafts/:id/add-cta-slide  — role: full  → append a BB-branded CTA slide to a carousel (body: { headline?, subhead? }); cap 10 slides
GET  /api/admin/dashboard/post-drafts/:id/zip            — role: full  → stream a ZIP attachment of all carousel slide JPEGs
POST /api/admin/dashboard/post-drafts/:id/skip           — role: full  → mark skipped + reason
POST /api/admin/dashboard/post-drafts/:id/approve        — role: full  → mark approved (Phase 7 will wire publish)
POST /api/admin/dashboard/run-drafter                    — role: full  → fire-and-forget contentDrafter run, returns 202

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

### Add a new content-drafter prompt or platform

1. **`contentDrafter.js`** — add a new `build<Platform>Prompt` function
   modeled on `buildTwitterPrompt` / `buildInstagramSinglePrompt`. Add the
   platform string to the `buildPrompt` router. Add a corresponding
   `build<Platform>Draft` builder so the parsed JSON lands in `bcb_post_drafts`
   with the right shape.
2. **Pi side (`bcbay_research.py`)** — extend `per_platform_topics` to
   include the new platform's topic stream.
3. **`views/content-drafts.html`** — add a `render<Platform>Card` function
   modeled on the existing `renderTwitterCard` / `renderInstagramSingleCard`.
   Wire it into `loadDrafts()`'s column rendering.
4. **`imageRenderer.js`** — usually no change needed; `saveDraftImages` is
   shape-agnostic.
5. **Tests** — extend `tests/admin-content.test.js` for any new endpoint
   variants. Helpers in `imageRenderer.js` already covered by
   `tests/image-renderer.test.js`.

### Tweak the AI scene-generation behavior

`imageRenderer.generateAIScene` is a single function — change the model via
`BCBAY_REPLICATE_MODEL` env override, or edit the input object in the
function body for tuning (`num_inference_steps`, `guidance_scale`,
`negative_prompt`). The endpoint at
`POST /api/admin/dashboard/post-drafts/:id/generate-art` is the only caller;
runDrafter does NOT auto-trigger AI generation (operator-only). Cost per call
is estimated at $0.05 and logged to `bcb_admin_log` for spend tracking.

### Carousel layout editor (Phase 6.4)

Each slide in a carousel renders an `.overlay-canvas` containing the
composite image plus a draggable `.overlay-headline` HTML element overlaid
on top. The operator can:

1. **Drag the headline** anywhere within the canvas — coords saved as
   percentages 0–100 in the slide's `overlay_x` / `overlay_y` fields.
2. **Pick a headline color** via 4 BB-palette swatches (white, gold, orange,
   accent green) or a native `<input type="color">` for arbitrary hex.
3. **Click "💾 Save layout"** — PATCHes the new `slides[]` then triggers
   `POST /regenerate-all-images` (fire-and-forget; UI re-polls in 30s).

Server-side, `imageRenderer.composeOverlayCard` accepts optional
`overlayX`, `overlayY`, `overlayColor` params; when present, the SVG
overlay is anchored at that point with a stroke-shadow for readability
(no gradient). When absent, the default bottom-left layout with a darken
gradient is used (existing behavior).

### Carousel CTA slide

The "➕ Add BB CTA slide" button calls `POST /add-cta-slide` which
appends a new slide to the carousel using `composeBrandedCard` (BB logo
+ headline + subhead + brand-palette gradient + bitcoinbay.com footer).
The new slide has `slide_role: 'cta'` and `is_cta_slide: true` for UI
distinction. Operator picks the headline + subhead via a prompt dialog;
the rest is the same template every time.

The CTA slide is the ONLY place BB branding appears on regular content
posts. Real-photo overlay slides stay clean (no watermark). This was an
explicit operator decision — branded watermarks on regular posts hurt
social-media reach.

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
