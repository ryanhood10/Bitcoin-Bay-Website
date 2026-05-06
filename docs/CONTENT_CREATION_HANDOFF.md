# Content Creation — Handoff for a fresh Claude session

> May 5 2026 — drafted by the Eldrin AI session that just shipped its own `/internal/posts` content-creation pipeline. Ryan wants the same idea brought to Bitcoin Bay's admin dashboard, but adapted to the **sports + crypto** domain (no AI/LinkedIn slant).
>
> **Read this first**, then [CONTENT_CREATION_PLAN.md](CONTENT_CREATION_PLAN.md) for the phased build.

---

## TL;DR

Bitcoin Bay's `/admin/dashboard` already has analytics + AI-drafted **engagement** (Twitter reply drafts + Instagram comment drafts). It does **not** have an **original-post drafter** — the thing that produces "here are 3 tweets and 1 IG carousel for tomorrow, approve them and they auto-post."

Eldrin AI shipped exactly that pipeline last week. The new BB Claude session should:

1. Read the **shipped Eldrin reference implementation** (`/Users/ryanhood/Projects/EldrinMasterRepo/EldrinAI` — paths called out below) to understand the architecture.
2. Port the pattern to BB's much simpler stack (single-file Express + inline-SPA, not a React monorepo).
3. Adapt the **voice + content pillars** to BB's sports+crypto domain (Pi research script `bcbay_research.py` already produces sports+crypto briefs daily — just hasn't been wired into a per-platform drafter yet).
4. Keep the dashboard's existing scope rule intact: **no posting from /admin/dashboard except drafts the operator approves**. The existing engagement-drafts surface uses the same model — extend it, don't fork it.

**Estimated effort:** ~12–16 hours of focused work, less if scope is trimmed (see Plan doc).

---

## North star

> "Every morning, the BB operator opens `/admin/dashboard → Content` and sees 3 tweets + 1 IG post drafted from yesterday's Pi research, each with a hero image already generated. They tweak text, click ✓ Approve & Post, and BB's brand voice ships across X and IG without anyone writing a word from scratch."

The existing engagement section already proves this loop works for *replies*. We're extending it to *originals*.

**What this is NOT:**
- Not a content calendar or scheduler (post-now or skip — same model as Eldrin).
- Not a CMS for the blog (the blog already has its own pipeline via `bcbay_blog.py`).
- Not a multi-account thing — there's one BB Twitter (@BitcoinBay) and one BB Instagram. Simpler than Eldrin's 4-account fan-out.
- Not where TikTok/YouTube live — those stay on the Pi (or Dell, per Eldrin precedent). This is X + IG only for v1.

---

## The Bitcoin Bay difference (vs. Eldrin)

Eldrin is an **AI/SaaS company** posting about LinkedIn, AI tools, founder voice. BB is a **crypto sportsbook** posting about NFL, NBA, UFC, athlete-crypto news, BTC volatility's effect on bankrolls. Different content pillars, different voice, different compliance surface. The plumbing is the same; the prompts and image strategy are not.

| Dimension | Eldrin | Bitcoin Bay |
|---|---|---|
| Stack | React monorepo (CRA + Express) | Single-file Express + inline SPA (`views/admin-dashboard.html`) |
| Mongo db | `eldrin_automation` (separate cluster) | `bcbay_automation` (same cluster as the rest) |
| Accounts | 4 (X, IG, LinkedIn personal, LinkedIn business) | 2 (X, IG) — simpler |
| Voice | Founder/operator AI takes | "Sharp handicapper at the beach bar with a hardware wallet" |
| Pillars | AI tools, founder content, growth tactics | Sports previews/recaps, athlete×crypto, betting strategy, crypto market |
| Day rotation | 3 platforms × weekday format gating | Mon/Tue/Wed/Thu/Fri/Sat/Sun = different category (set in `bcbay_research.py`) |
| Compliance | "we help you grow" — no special constraints | **NO US marketing language**, NO "licensed/regulated", NO "guaranteed winner" tout-speak, neutral geography. Treat like a financial-advice surface — journalism first, product plug last. |
| Image strategy | FLUX (Replicate) + Cloudinary overlays + mascot wizard | **Wikimedia Commons** (free editorial photos of athletes/teams — already wired in `bcbay_blog.py`), fallback to FLUX for non-photo decks. NO mascot — BB doesn't have one. |
| Hero post category | "Founder takes" | **"Athlete × Crypto"** — the moat. Pi research has a dedicated detector that pre-empts day rotation when fresh athlete-crypto news drops (last 7d). |

**Voice constraints (from `bcbay_research.py:TONE`, with May-5 amendment):**
> "Authoritative on sports and crypto, relaxed in delivery, beach-coded without being silly. Think: a sharp handicapper writing from a beach bar with a hardware wallet in their pocket. Data-driven when data exists. Never fear-mongering, never salesy, never tout-speak. Journalism first, product plug last."

**May-5 amendment from Ryan:** *fun sports-theme energy, similar to other sportsbook social accounts (DraftKings/FanDuel feel — minus the predatory promo voice). An occasional humor angle is welcome — roughly 1 in 5 posts can lead with a funny take ("Bills fans, look away" energy). The drafter prompt should expose a `humor_pass` knob the operator can toggle per-card to regenerate with a punchier comedic angle.*

Twitter voice = sharper, punchier, takes-driven. Instagram voice = more visual, athlete-card aesthetic, win/loss graphics, lean into the beach/sportsbook brand. Both share the underlying tone above.

---

## What's already in place (BB side)

### Heroku app (`Bitcoin-Bay-Website` repo)

- **Express app at `server.js`** — serves the public marketing site + admin SPA. No React.
- **`adminDashboard.js`** — Express router for `/admin/dashboard` + `/api/admin/dashboard/*`. Reads `daily_reports`, `bcb_engagement_drafts`, `bcb_instagram_drafts` from Mongo. Owns the "Run now" job-queue mechanism (`bcb_run_jobs` collection + Pi poller).
- **`views/admin-dashboard.html`** — the SPA. **All inline** (HTML + CSS + JS in one file). Talks to `/api/admin/dashboard/*`. New "Content" tab will live here as another section.
- **`adminAuth.js`** — `requireAdmin('full' | 'dashboard')` middleware. Use `'full'` for any "approve & post" action (writes to a 3rd-party API are full-only). Reads via `requireAdmin()` (any role).
- **`authInstagram.js`** — already does **Meta Login OAuth** for Instagram. Stores access token in `bcb_auth_tokens` collection. **Reuse this for IG posting.** OAuth flow is already shipped; we only need the publish call.
- **Mongo collections**: see `CLAUDE.md` table. The `bcbay_automation` db is shared with the Pi.

### Pi (`eldrin-pi@192.168.68.57:~/bcbay/`)

- **`bcbay_research.py`** — daily research script, runs nightly via cron. Produces a JSON brief at `~/bcbay-research/bcbay-brief-YYYY-MM-DD.json` and uploads to Google Drive. **This is your source of truth for "what's interesting today."** Schema includes:
  - `blog_research` — { topic, suggested_title, key_facts, source_urls, image_subject, paa_questions, internal_link_candidates, fallback_image_query, data_driven, primary_keyword, target_query, topic_category, evergreen_score }
  - `video_research` — { topic, hook, script_outline, key_facts, viral_format, hashtags_tiktok, hashtags_youtube }
  - `breaking_news.relevant_stories` — 1–3 timely items
  - `content_calendar_note` — strategic context
- **Day-of-week rotation (already enforced):**
  - Mon = Game Recap (weekend)
  - Tue = **Athlete Crypto** (the moat — dedicated day)
  - Wed = Betting Strategy (single-sport deep dive)
  - Thu = Crypto Market (DATA DAY — stats & odds analysis)
  - Fri = Game Preview ("Slate at the Bay" weekend preview)
  - Sat = Game Preview (CFB / UFC)
  - Sun = Game Preview (NFL / EPL)
- **Athlete × Crypto detector** (in `bcbay_research.py:fetch_athlete_crypto_news()`) — Google News RSS scan of 12 athlete×crypto queries, last 7 days. When fresh stories exist, pre-empts the day rotation. **This is BB's defining content category.**
- **Compliance rules** — already enforced in the research prompt. Carry these into the drafter prompt verbatim.
- **`bcbay_run_jobs_poller.py`** — polls `bcb_run_jobs` queue every 60s, executes the matching Python script. Already wired for engagement scripts. **Extend this to include a `drafter` job kind** so the dashboard's "Run now" button can trigger a fresh drafter run.
- **`bcbay_daily_report.py`** — populates `daily_reports` with platform metrics (X, IG, GA4, GSC, Mongo users). Untouched by this work, but the metrics it captures are what we'll later use to evaluate post performance.
- **`bcbay_twitter_engagement.py` + `bcbay_instagram_engagement.py`** — existing draft-finders (reply/comment drafts). Read these to understand the existing voice the operator already trusts. The post drafter prompts should match this voice closely.
- **`~/.bcbay-env`** — has `ANTHROPIC_API_KEY`, `MONGO_AUTOMATION_URI`, Twitter creds, IG creds. Reuse, don't duplicate.

### What does NOT yet exist (the gaps to close)

- ❌ No **per-platform topic stream** in the brief. `blog_research` is the only structured output; we need `per_platform_topics.twitter` (list of 3 topics) + `per_platform_topics.instagram` (list of 1 topic per day) added to `bcbay_research.py`.
- ❌ No **post drafter** anywhere — no Node service that takes a brief and produces tweet text + IG caption.
- ❌ No **image generation pipeline** for original posts. (`bcbay_blog.py` does Wikimedia Commons lookup for blog hero images — copy that pattern for the X+IG hero.)
- ❌ No **Twitter publish** call. Engagement script drafts replies but the operator currently posts manually. We need v2 OAuth with `tweet.write` scope and a `socialPublisher.js` module that publishes a tweet (and replies-as-tweet for engagement-side parity later).
- ❌ No **Instagram publish** call. OAuth is wired but the publish step (`/me/media` + `/me/media_publish`) hasn't been used yet from this app.
- ❌ No **Cloudinary** account configured for BB. Either set one up or render overlays inline via Sharp/Jimp on Heroku (Eldrin uses Cloudinary; BB can choose).
- ❌ No **carousel rendering** (Eldrin uses HTML+Puppeteer). Skip in v1 unless Ryan wants Mon = carousel.
- ❌ No **Content tab** in `admin-dashboard.html` SPA.

---

## Eldrin reference implementation (read these to understand the pattern)

Path prefix: `/Users/ryanhood/Projects/EldrinMasterRepo/EldrinAI/` — Ryan's other repo. Read-only for this session; the BB session is in `/Users/ryanhood/Projects/BitcoinBay/Bitcoin-Bay-Website/`.

| Eldrin file | What it shows you |
|---|---|
| `docs/content-creation-research.md` | **Strategy bible** — voice playbook, 4 fully-spec'd Claude prompts (X/IG/LI), mascot rules, anti-slop rules. **Mandatory reading.** Adapt the X + IG prompts; ignore LI. Replace "AI/founder" with "sports/handicapper". |
| `docs/content-creation-infrastructure.md` | Posting pipeline plan (older planning doc — read for context, but the shipped reality is in the code). |
| `docs/content-creation-phase3-plan.md` | The phased build that just shipped. Read 3.1–3.8 to see the order of operations. Mirror this. |
| `docs/internal-dashboard-changelog.md` | "Current focus" + recent-changes log. Read for the *reasoning* behind recent decisions (per-platform brief slicing, async carousel, OverlayCanvas with drag-coords). |
| `backend/services/InternalDashboard/postDrafter.js` | **Core drafter service.** Per-platform PROMPTS, `pickPlatformTopics`, `selectPlatformBrief`, source-citation block, JSON-out parsing. Port this to a single `contentDrafter.js` file at the BB repo root. Trim from 4 platforms to 2. |
| `backend/services/InternalDashboard/socialPublisher.js` | OAuth-using publishers for X + IG. Port the X publisher; the IG publisher can use BB's existing `bcb_auth_tokens` (already wired by `authInstagram.js`). |
| `backend/services/InternalDashboard/imageGenerator.js` | FLUX (Replicate) + Cloudinary overlay pipeline. **Don't port directly** — BB's hero-image strategy is Wikimedia Commons (already in `bcbay_blog.py`) + optional FLUX fallback. Use this as a *structural* reference for the async render pattern. |
| `backend/controllers/InternalDashboard/posts.js` | REST surface — list drafts, approve, edit, skip, regenerate. Pattern to mirror in `adminDashboard.js`. |
| `frontend/src/pages/InternalDashboard/PostsPage.jsx` | The `/internal/posts` page — three columns (X, IG, LI), per-card edit + approve UX. **BB version is one page in `admin-dashboard.html`** — port the *layout idea* (cards in a grid), not the React code. Use vanilla JS like the rest of the SPA. |
| `frontend/src/components/InternalDashboard/OverlayCanvas.jsx` | **Click-and-drag overlay editor** with live preview. Port this to vanilla JS. Worth the effort — Ryan loves this. |
| `frontend/src/components/InternalDashboard/PlatformSection.jsx` | Renders the per-platform card column. Layout reference. |
| Pi: `~/eldrin_research.py` (latest) | Eldrin's research script — has the `per_platform_topics` schema BB needs to copy into `bcbay_research.py`. SSH `eldrin-pi@192.168.68.57` and read it. |

**Architectural deltas vs. Eldrin worth flagging up front:**

1. **No React.** All UI work goes into `views/admin-dashboard.html` (vanilla JS, no JSX, no RTK Query). Use `fetch()` directly. The existing `engagement-drafts` rendering pattern is the template.
2. **Single-file modules at repo root**, not nested under `services/InternalDashboard/`. Match BB's existing pattern: `adminDashboard.js`, `agentClient.js`, etc. So you'll add `contentDrafter.js`, `socialPublisher.js`, `imageRenderer.js` (or merge them).
3. **Mongo collections live in the same db** as everything else (`bcbay_automation`). New: `bcb_post_drafts`, `bcb_post_briefs`. Keep the `bcb_*` prefix.
4. **Job queue already exists** (`bcb_run_jobs` + Pi poller). Use it for "Run drafter now" the same way the engagement panels use it for "Find drafts now." Don't reinvent.
5. **Async render pattern**: Eldrin had to dodge Heroku's 30s H12 timeout for carousel renders by returning 202 immediately and rendering in the background. BB v1 should skip carousel rendering entirely — single hero image per post is enough. Revisit if Ryan asks.

---

## Tools available right now

| Tool / service | Where | Used for |
|---|---|---|
| **Anthropic Claude** | API key in `~/.bcbay-env` (Pi) and Heroku env (`ANTHROPIC_API_KEY`) | Drafting tweet/IG copy + research |
| **MongoDB Atlas** (`bcbay_automation` db) | `MONGO_AUTOMATION_URI` env | Briefs, drafts, job queue |
| **Wikimedia Commons API** | Public, no key | Free editorial photos of athletes, teams, stadiums (already used by `bcbay_blog.py`) |
| **CoinGecko API** | Public, no key | Live crypto prices for data-day posts (already used by `bcbay_research.py`) |
| **Google News RSS** | Public | Breaking story discovery (already used) |
| **ESPN/CBS/Yahoo/CoinDesk RSS** | Public | Sports + crypto news streams (already used) |
| **Twitter API v2** | Need to check `bcbay_twitter_engagement.py` for current creds + scopes; may need to upgrade to `tweet.write` if not yet granted | Posting tweets |
| **Instagram Graph API** | OAuth wired via `authInstagram.js`; token in `bcb_auth_tokens` Mongo collection | Posting IG photo/carousel |
| **Pi job poller** (`bcbay_run_jobs_poller.py`) | Already drains `bcb_run_jobs` every 60s | Triggering Pi-side drafter from dashboard "Run now" |
| **Pushover** (`PUSHOVER_USER_KEY` env) | Already wired for player-message alerts | Optional: notify operator when a new draft is ready (probably overkill — they'll check the dashboard). |
| **rclone → Google Drive** | Already wired on Pi | Backup brief JSON. Not needed for drafter, but available. |

| Tool to set up | Notes |
|---|---|
| **Unsplash API key** | Free tier (50 req/hr) is plenty. Register an app at https://unsplash.com/developers → store as `UNSPLASH_ACCESS_KEY`. Each rendered image must include the photographer credit in the IG caption per Unsplash terms. |
| **Pexels API key** | Free tier (200 req/hr). Register at https://www.pexels.com/api/ → store as `PEXELS_API_KEY`. Attribution is optional but we render it anyway (cheap insurance). |
| **`sharp` package** | Already battle-tested in the Heroku Node ecosystem. Used for overlay text composites + BB-branded promo cards (logo + headline on brand-palette gradient). `npm install sharp` — bumps slug size by ~30 MB but worth it (no Cloudinary dependency). |
| **Cloudinary** (optional) | Free tier is enough. Eldrin uses it for `l_text` overlays on hero images. **BB alternative chosen: `sharp` on Heroku** (one fewer external dependency, full control over overlay design with the brand palette baked in). |
| **Replicate / FLUX** (opt-in only) | Per-card "Generate art" button only — not default. Reserved for athlete×crypto posts where no real-photo angle exists on Commons/Unsplash/Pexels. Cost: ~$0.02/image. Set up `REPLICATE_API_TOKEN` only when first used. |
| **Twitter app `tweet.write` scope** | Per Ryan (May 5): "we should already have twitter configed on the app." Confirmed by user as not blocking — verify the actual scope when Phase 7 lands; if missing, 1h OAuth re-flow. |

---

## Decision points for Ryan (ask before shipping)

These are the calls where the new session should pause for Ryan:

1. **Cadence** — Daily, or 3x/week (M/W/F)?
   - Eldrin chose daily for X+IG; LinkedIn 3x/week (later 5x/week with personal added).
   - **Recommendation: daily for both** — BB has 7 day-of-week categories already in `bcbay_research.py`, so the cadence is already weekly. Don't waste research output.

2. **Image strategy v1** — ~~Wikimedia-only? Wikimedia + FLUX fallback? FLUX-only?~~ **DECIDED (May 5):** real-photo-first via three free editorial sources, with branded composites (logo + headline) for BB-promo posts. **No general "scrape the internet"** — Getty/AP/Reuters wire shots are licensed and we cannot use them.
   - **Tier 1 — Wikimedia Commons** (CC/PD): athletes, teams, stadiums, leagues, crypto/finance imagery. Already wired in `bcbay_blog.py:fetch_wikimedia_image()` — port to JS.
   - **Tier 2 — Unsplash API** (free for commercial with attribution): broader sports/lifestyle/abstract editorial photos. Token: `UNSPLASH_ACCESS_KEY` (need to create dev app).
   - **Tier 3 — Pexels API** (free for commercial): similar coverage to Unsplash, useful for fallback. Token: `PEXELS_API_KEY`.
   - **Tier 4 — Manual paste**: the dashboard exposes a "paste image URL" field per draft for cases where the operator has a specific photo (their own, athlete's official social, BB internal screenshot). Operator owns the rights call.
   - **Tier 5 — BB-branded composite**: when the post is *about Bitcoin Bay itself* (promo, bonus, leaderboard, register CTA), generate a clean `bb-logo.png + headline + brand palette` SVG composite via `sharp`. No real photo needed — this is owned brand content. **Brand palette extracted from `index.html`:** `--gold #F7941D`, `--gold-light #FDCB6E`, `--gold-dark #D47812`, `--orange #F26522`, `--bg-dark #0A1628`, `--bg-card #0D2240`, `--accent-blue #56CCF2`, `--accent-green #22C55E`. Fonts: Inter / Space Grotesk.
   - **Tier 6 — FLUX (Replicate)**: only as opt-in per-card "Generate art" button, e.g. for athlete×crypto posts where no real-photo angle exists on Commons. Not default; operator-triggered.
   - All non-branded images carry an `attribution` field that the IG caption renders as "Photo: [credit] / [license]". Twitter doesn't render it (280-char limit) but it's stored on the draft for audit.

3. **Carousel** — ~~Skip in v1.~~ **DECIDED (May 5):** **carousels are in v1** — IG-style breaking-news photo decks (3–5 slides) for Mondays (Recap), Sundays (Slate at the Bay), and Athlete×Crypto when the news angle has multiple distinct visual beats. Modeled after how ESPN/Bleacher Report do IG: photo lead → secondary photo → data card → key quote → CTA. **Each slide is a real photo** (from the same Wikimedia/Unsplash/Pexels chain) with optional overlay headline. **No HTML+Puppeteer renderer yet** — slides are just hero photos with optional `sharp` text overlay. Rendering time stays under Heroku's H12 budget.

4. **Athlete×Crypto special handling** — When the Pi detector fires, should the drafter:
   - (A) Replace one of the day's 3 X drafts with the athlete-crypto take?
   - (B) Add it as a 4th X draft (operator picks 3)?
   - (C) Always pin it to the top regardless of day rotation?
   - **Recommendation: (C)**. Athlete×Crypto is the moat. When fresh stories exist (last 7d), the top X draft is *always* the athlete-crypto take, dropping one of the day-rotation drafts. Pi already flags this with `forced_override` — propagate that flag through to the drafter.

5. **Compliance review gate** — Should an admin review *every* draft before it can post, or trust the prompt and ship low-risk categories (Game Preview/Recap, Crypto Market) auto?
   - **Recommendation: review every draft** — same as Eldrin. The compliance surface (no US marketing, no "licensed", no tout-speak) is too easy for an LLM to brush against. Operator hits ✓ Approve & Post, no auto-publish.

6. **Voice anchoring** — Should the drafter prompt include 5–10 *real, recent* approved tweets/IG captions as few-shot examples?
   - **Strong recommendation: yes.** Eldrin's biggest voice-quality jump came from porting the engagement-side persona definitions into the post drafter. BB has `bcbay_twitter_engagement.py` and `bcbay_instagram_engagement.py` with the operator's trusted reply/comment voice — extract the persona blocks from those and feed them into the post drafter.

---

## Repo conventions to follow

(Pulled from BB's `CLAUDE.md` so you don't trip over them.)

- **Mongo collection prefix `bcb_*`** for new collections. Existing Pi-populated ones (`daily_reports`, `bcb_engagement_drafts`, `bcb_instagram_drafts`) keep their names.
- **Env-var names** — match the existing style: `BCBAY_*`, `MONGO_AUTOMATION_*`, `INSTAGRAM_*`, `TWITTER_*`. Don't use Eldrin's `INTERNAL_*` prefix here.
- **Branches** — current dev work happens on `main`. Ryan does NOT use a feature branch for BB. Confirm with him before pushing — for big multi-commit work like this, suggest a branch (`content-creation`) and PR back to `main`.
- **Never `git push heroku` without explicit instruction.** BB deploys from `main` via `git push heroku main`. (Twin remote: keep `origin/main` in sync.)
- **Test suite**: BB has `npm test` (36 tests via `node:test`). Add tests for new endpoints to `tests/` — match the existing `admin-dashboard-api.test.js` style.
- **Don't fork the engagement-drafts collections** for posts — use a *new* collection (`bcb_post_drafts`). Engagement = replies/comments on others' content; Posts = original tweets/IG. Different shape, different lifecycle.
- **Inline SPA edits** — `views/admin-dashboard.html` is one big file. Search for `engagement-drafts` rendering to find the pattern. Add a "Content" tab as a sibling section. Don't modularize the SPA in this pass.

---

## Compliance reminder (read twice — this is the easy place to mess up)

BB sells the *concept* of crypto sports betting in **neutral geography**. The marketing site does not say "licensed in X jurisdiction" or "regulated by X." The drafter must respect this:

- ✅ "Sharp NFL props for Sunday's slate"
- ✅ "BTC dipped 4% — what that means for your bankroll going into Week 7"
- ✅ "How [athlete] earning his salary in BTC actually works"
- ❌ "Licensed crypto sportsbook in Curaçao" (geography claims)
- ❌ "100% regulated and safe" (regulatory claims)
- ❌ "Guaranteed winners every week!" (tout-speak)
- ❌ "Sign up now and get 200% match!" (US-style promo voice — too aggressive)

**Bake these as hard rules in the post drafter prompt**, mirroring what `bcbay_research.py` already enforces. When in doubt, the prompt should pass; the operator catches the rest at review.

---

## Suggested first-day commit ladder

If you're picking this up cold:

1. **Day 1 morning** — read `docs/content-creation-research.md` in the Eldrin repo (1h). Read `bcbay_research.py` end-to-end on the Pi (1h). Read `views/admin-dashboard.html` engagement-drafts rendering (30m). Now you understand both ends.
2. **Day 1 afternoon** — port the X + IG prompts from Eldrin's `postDrafter.js` to a new `contentDrafter.js`. Replace voice/pillars per the BB voice. Wire `pickPlatformTopics` + `selectPlatformBrief` for BB's brief schema. Stop and show Ryan a CLI smoke test (run drafter against yesterday's brief, dump JSON).
3. **Day 2** — add the `Content` tab to `admin-dashboard.html`. Render drafts. Add edit + approve buttons. NO publish wiring yet.
4. **Day 3** — wire X + IG publish via `socialPublisher.js`. Manually test one approved tweet end-to-end on a staging account if available.
5. **Day 4** — add `per_platform_topics` to `bcbay_research.py` so the brief feeds X and IG with separate topic streams (don't repeat the blog topic verbatim). Bump `max_tokens` if needed (Eldrin hit a 8K → 20K bump for this).
6. **Day 5** — image hero pipeline (Wikimedia Commons lookup, fallback FLUX if budgeted). OverlayCanvas drag-and-drop in vanilla JS (port from Eldrin React component). Polish.

---

## What NOT to build in v1

- ❌ ~~Carousel rendering~~ — **carousels ARE in v1** (per May-5 amendment). Just no HTML+Puppeteer renderer; slides are real photos with optional `sharp` overlay text.
- ❌ Multi-account fan-out (BB has one X handle, one IG)
- ❌ TikTok/YouTube originals (separate Dell-side pipeline per Eldrin precedent)
- ❌ Auto-posting without operator approval (compliance risk)
- ❌ Performance attribution / "did this post drive conversions" (deferred — engagement metrics already tracked)
- ❌ The mascot. BB doesn't have one. Don't invent one mid-build.
- ❌ Animated/video posts. Eldrin's animation pipeline was for AI-tool demos. BB sports content lives or dies on still imagery + text.
- ❌ Generic "scrape the internet for images" (Getty/AP/Reuters wire shots are licensed — we use Wikimedia + Unsplash + Pexels + manual paste + BB-branded composites only).
- ❌ **Watermarks on regular posts.** A previous build added a subtle BB logo to every overlay composite — Ryan rejected this on 2026-05-06: watermarks hurt social-media reach (algorithms deprioritize visibly-branded content). Only `format_hint='branded_promo'` posts carry BB branding; regular athlete/sports posts stay clean.
- ❌ **Auto-fallback AI image generation.** Replicate InstantID is wired in (Phase 4.5) but is operator-triggered only via the 🎨 button. Real-photo cascade always tries first; AI is the operator's deliberate choice for cases where no real photo will fit ("Travis Kelce reacting to a Bitcoin chart").

---

## Cost estimate

| Item | Per-day | Per-month |
|---|---|---|
| Anthropic — drafter (X×3 + IG single + IG carousel × 4 slides each = ~7 Claude calls × ~$0.02) | $0.14 | ~$4.20 |
| Anthropic — research (already running, no change) | $0.20 | ~$6.00 |
| FLUX/Replicate (opt-in only; ~2/week × $0.02) | <$0.01 | ~$0.20 |
| Wikimedia Commons | $0 | $0 |
| Unsplash API (free tier, 50/hr) | $0 | $0 |
| Pexels API (free tier, 200/hr) | $0 | $0 |
| Heroku — no new dyno needed (Express handles `sharp` composites in-process) | $0 | $0 |
| **Total new spend** | **~$0.15** | **~$4.40** |

Rounding error against BB's existing infrastructure cost.

---

## When you're done

Update `docs/CONTENT_CREATION_PLAN.md` with checkmarks against the phases as you complete them, and add a "Recent changes" section at the bottom of this handoff doc with commit SHAs. Mirror Eldrin's `internal-dashboard-changelog.md` discipline — that's how the next session avoids re-reading 30 commits.

Update `CLAUDE.md` (root) under "What this app does" to include capability #5: "Content drafter — daily X + IG post drafts based on Pi research, operator-approved publish."

Push to `main` (or a feature branch — confirm with Ryan), then `git push heroku main` only on Ryan's explicit go.

---

## Recent changes

- **2026-05-05** — Phases 3, 4, 5, 6 shipped to `main` (commits `da3f9c0`, `697d936`, `44686c2`, `292a94c`). Drafter + image renderer + review UI + REST endpoints all working end-to-end. CLAUDE.md updated with capability #5.
- **2026-05-06 — Phase 4.1 (asset-quality fixes):** A May-6 audit pass on the first batch of rendered drafts found three concrete misses (BB-logo subjects falling through to Pexels, off-topic Pexels matches like "SGA celebration → birthday party balloons", and `saveDraftImages` always passing `intent: 'sport_action'` regardless of athlete subjects). The previous chat session was mid-flight on these fixes when it crashed; this session recovered them. New helpers in `imageRenderer.js`: `inferIntent`, `isBBSubject`, `inferBrandedKind`, `pexelsOffTopic`. Net 19 unit tests in `tests/image-renderer.test.js`.
- **2026-05-06 — Phase 4.5 (AI scene generation):** New capability — operator-triggered `🎨 Generate scene` button on each draft card. Calls Replicate InstantID (`zsxkib/instant-id`) with a Wikimedia/Pexels reference photo of the athlete + a scene prompt; returns a generated JPEG with the athlete's actual face in the new scene. ~$0.05/call, audit-logged in `bcb_admin_log` with the model + prompt. Reference image defaults to the current draft image; falls back to a fresh Wikimedia lookup of `image_subject` when neither is set. Endpoint returns 503 if `REPLICATE_API_TOKEN` is missing. **No watermarks on regular posts** — only `branded_promo` posts carry BB branding.
- **2026-05-06 — Pi-side TODO (blocked):** `bcbay_research.py:per_platform_topics` should produce literal, search-friendly `image_subject` strings (full athlete names, no abstractions like "celebration"/"reaction") and populate `image_scene_prompt` for cases where a real photo is unlikely. Documented in `CONTENT_CREATION_PLAN.md` Phase 1 amendment; blocked on SSH access to the Pi.

---

*Drafted by the Eldrin AI Phase 3.x session, May 5 2026. The Eldrin shipped reference is at `/Users/ryanhood/Projects/EldrinMasterRepo/EldrinAI` on Ryan's machine — read it freely; don't write to it.*
