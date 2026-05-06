# Content Creation — Phased Plan

> Companion to [CONTENT_CREATION_HANDOFF.md](CONTENT_CREATION_HANDOFF.md). Read that first for context, voice, decisions, and Eldrin reference paths.

This doc breaks the build into self-contained phases (1–8) with effort estimates and dependency arrows. Each phase ends with a smoke test and a commit.

---

## Phase 1 — Brief schema extension (Pi)

**Goal:** Make `bcbay_research.py` produce per-platform topic streams in addition to its existing blog/video output. Twitter and Instagram should each get their own seeded topic list so they don't end up posting identical content.

### Tasks

- [ ] SSH into Pi (`eldrin-pi@192.168.68.57`), backup `~/bcbay/bcbay_research.py` (`cp ~/bcbay/bcbay_research.py ~/bcbay/bcbay_research.py.bak-$(date +%Y%m%d%H%M)`), then edit.
- [ ] Add `per_platform_topics` to the JSON schema returned by Claude. Two streams:
  - `twitter`: list of 3 topics (sharp takes, fits 280 chars). Seeded from breaking_news + day-rotation category + (if firing) athlete-crypto override.
  - `instagram`: **list of 1 topic, format depends on day rotation.** Mon (Recap), Sun (Slate), and Athlete×Crypto when news has multiple visual beats produce a **carousel topic** with a `slides` array of 3–5 entries (ESPN/Bleacher Report breaking-news pattern). Other days produce a single-image topic.
- [ ] Each Twitter / IG-single topic has shape: `{ topic, angle, source_url|null, image_subject, primary_keyword, secondary_keywords[], format_hint, allow_humor: boolean }`.
- [ ] Each IG-carousel topic has shape: `{ topic, angle, source_url|null, primary_keyword, format_hint: "carousel", allow_humor, slides: [{ slide_role, image_subject, headline, body_caption_hint, source_url|null }, ...] }`. `slide_role` ∈ `["lead_photo", "secondary_photo", "data_card", "key_quote", "cta"]`.
  - `format_hint` ∈ `["take", "data_card", "preview_grid", "athlete_card", "recap_summary", "carousel", "branded_promo"]` — drafter uses this to pick layout. `branded_promo` skips real-photo lookup and routes to BB-branded `sharp` composite.
  - `allow_humor: true` is set on ~1 in 5 topics by the brief writer so the drafter can lead with a comedic angle. Operator can also force a humor regen via the dashboard's funny-twist toggle.
- [ ] Bump `max_tokens` if the brief output starts truncating (Eldrin hit a 8K → 20K bump when adding per-platform streams).
- [ ] Update `validate_research_output` to also check `per_platform_topics` is present.
- [ ] Smoke test: run `python3 ~/bcbay/bcbay_research.py` manually, inspect the resulting JSON, confirm both streams populate cleanly on a Mon/Tue/Wed sample.

**Effort:** 2h (was 1.5h, +30m for carousel slide schema). **LOC:** ~110. **Depends on:** nothing.

---

## Phase 2 — Brief storage in Mongo

**Goal:** The brief should land in Mongo so the Heroku-side drafter can read it without rclone'ing from Drive. Match how `daily_reports` is written.

### Tasks

- [ ] In `bcbay_research.py`, after `save_local()`, also `bcb_post_briefs.replaceOne({date: today_str}, brief, upsert=True)`.
- [ ] Document the `bcb_post_briefs` collection in BB `CLAUDE.md` Mongo table.
- [ ] Smoke test: confirm a doc lands in `bcb_post_briefs` with the expected shape.

**Effort:** 30m. **LOC:** ~20. **Depends on:** Phase 1.

---

## Phase 3 — `contentDrafter.js` core service

**Goal:** A new module at the BB repo root that, given a brief, produces draft tweets + IG captions and writes them to `bcb_post_drafts`. **This is the core port from Eldrin's `postDrafter.js`.**

### Tasks

- [ ] Create `contentDrafter.js` with two exports:
  - `runDrafter({ briefDate? })` — pulls today's (or specified) brief from `bcb_post_briefs`, drafts each platform's posts, writes to `bcb_post_drafts`.
  - `regenerateDraft(draftId, { newAngle? })` — re-runs the prompt for a single draft (operator hits 🔄 in the UI).
- [ ] **Per-platform prompts** — port from Eldrin's `postDrafter.js:PROMPTS`, then rewrite. **Three prompts:** `twitter`, `instagram_single`, `instagram_carousel`.
  - All three share a "BB voice" preamble (sharp handicapper, beach-coded, no tout-speak, no licensed/regulated, neutral geography, **fun sportsbook tone** with occasional humor when `allow_humor: true`).
  - Twitter prompt produces JSON: `{ text (≤270 chars), hashtags[], suggested_image_subject, source_url|null, takeaway_one_liner }`.
  - Instagram-single prompt produces JSON: `{ caption, hashtags[10-15], suggested_image_subject, image_overlay_text (short headline + @handle), format_hint }`.
  - Instagram-carousel prompt produces JSON: `{ caption (the deck-level caption shown under all slides), hashtags[10-15], slides: [{ slide_role, image_subject, headline, body_text, source_url|null }, ...] }`. Caption tells the story end-to-end; each slide's `headline` is the on-image overlay (≤8 words) and `body_text` is the alt-text/dev-only copy.
- [ ] **Humor knob** — when `allow_humor: true` on the topic OR `humor_pass: true` is passed to `regenerateDraft`, the prompt switches to a "sharp comedic angle, still respect compliance rules" preamble. Examples bank: "Bills fans, look away.", "Lakers in 4. (Of 7.)" — punchy, observational, never punching down.
- [ ] **Voice anchoring**: read `~/bcbay/bcbay_twitter_engagement.py` + `~/bcbay/bcbay_instagram_engagement.py` on the Pi, extract the persona/voice blocks, paste them into the drafter prompts as the canonical voice reference. (Eldrin learned the hard way: the engagement-side voice is the operator's trusted voice; the post drafter must match it.)
- [ ] **Compliance block** in both prompts (verbatim — same words `bcbay_research.py` uses):
  > NEUTRAL GEOGRAPHY ONLY. Do not claim licensure or regulation. Do not predict guaranteed wins. Do not use US-style promo language. Journalism first, product plug last.
- [ ] **Source citation** — when `source_url` is present on a topic, the drafter should include it in the tweet (X handles URLs natively) and link in the IG caption. Mirror Eldrin's `SOURCE CITATION` block.
- [ ] **Athlete×Crypto pinning** — when `forced_override` is true on the brief, swap the first Twitter draft with the override topic regardless of day rotation.
- [ ] Write drafts to `bcb_post_drafts` with shape:
  ```js
  {
    _id, platform: "twitter"|"instagram_single"|"instagram_carousel",
    brief_date, topic, angle, format_hint, allow_humor,
    // single-image OR twitter:
    text?: string,                    // twitter only
    caption?: string,                 // ig (both)
    hashtags: string[],
    source_url?: string,
    image_subject?: string,           // single-image lookup key
    image_overlay_text?: string,      // single-image overlay
    image_url?: string,               // single-image final URL
    image_attribution?: string,       // photographer credit (Wikimedia/Unsplash/Pexels)
    image_status: "pending"|"ready"|"failed",
    // carousel only:
    slides?: [{
      slide_role, image_subject, headline, body_text,
      image_url, image_attribution, source_url?,
      composite_url?,                 // sharp-rendered overlay version
    }, ...],
    // lifecycle:
    status: "draft"|"approved"|"posted"|"skipped", skip_reason?,
    last_publish_error?: string,
    created_at, updated_at, published_at?, published_url?
  }
  ```
- [ ] Add a CLI entry: `node contentDrafter.js --date 2026-05-05` for manual smoke testing.

**Effort:** 5h (was 4h, +1h for the carousel prompt + humor knob + slide-array shape). **LOC:** ~500. **Depends on:** Phase 2.

---

## Phase 4 — Image pipeline (real-photo-first, branded composites)

**Goal:** Every post draft (single or per-slide for carousel) gets a real editorial photo or a BB-branded composite — never a generic AI render unless explicitly opted in. Three free editorial sources in cascade, then BB-branded `sharp` composite, then opt-in FLUX as last-resort.

### Tasks

- [ ] Create `imageRenderer.js` at repo root with these exports:
  - `findHeroImage(subject, { intent }) → { url, attribution, license, source } | null`
    - Cascade: **Wikimedia Commons → Unsplash → Pexels**, return on first hit. `intent` ∈ `["athlete", "team", "stadium", "sport_action", "crypto", "abstract_finance"]` — used to weight which source to query first (athletes ⇒ Wikimedia first; abstract_finance ⇒ Unsplash first).
  - `findCarouselImages(slides) → [{ url, attribution, ... }, ...]`
    - Per-slide call to `findHeroImage`. Distinct subjects required per slide (don't return the same Commons photo twice in one carousel).
  - `composeBrandedCard({ headline, subhead?, kind }) → { url }`
    - `kind` ∈ `["promo", "leaderboard_cta", "register_cta", "bonus_cta"]`. Produces a `sharp` SVG composite: BB-palette gradient background (deep navy → orange accent), `bb-logo.png` top-left at 80px, headline in Space Grotesk 64pt white, subhead in Inter 24pt `--text-secondary #B0C4DE`, BB website footer `bitcoinbay.com` in `--gold #F7941D`. 1080×1080 for IG single, 1080×1350 for portrait, 1200×675 for X.
  - `composeOverlayCard({ image_url, headline, badge_kind? }) → { url }`
    - Loads real photo, applies bottom-third gradient (transparent → navy 90%), overlays headline in Space Grotesk on the gradient. Optional `badge_kind` ∈ `["breaking", "live", "athlete_x_crypto"]` puts a small colored chip top-left ("BREAKING" in `--accent-green`, "LIVE" in `--orange`, "ATHLETE × CRYPTO" in `--gold`).
  - `generateAIImage(prompt) → { url, source: "flux" }`
    - Replicate FLUX. **Not called by `runDrafter` automatically** — only via the per-card "Generate art" button in Phase 5 UI. Cost-aware: log every call to `bcb_admin_log`.
- [ ] **Wikimedia Commons port** — translate `~/bcbay/bcbay_blog.py:fetch_wikimedia_image()` to JS. Same query strategy: `srsearch` against File: namespace, fetch metadata, prefer landscape, prefer >800px, skip thumbnails, skip user-deleted. Cache results in `bcb_image_cache` collection keyed by `subject` for 7 days.
- [ ] **Unsplash integration** — `GET /search/photos?query={subject}&orientation=landscape&content_filter=high`. Return top hit, store full attribution string per their terms ("Photo by {name} on Unsplash" with both links). Required header: `Authorization: Client-ID {UNSPLASH_ACCESS_KEY}`.
- [ ] **Pexels integration** — `GET /v1/search?query={subject}&orientation=landscape&size=large`. Header `Authorization: {PEXELS_API_KEY}`. Attribution rendered in IG caption only (Pexels doesn't strictly require it but we render anyway).
- [ ] **Brand assets** — read `bb-logo.png` from repo root once at module load (cache as Buffer). Brand palette baked as a JS const exported from `imageRenderer.js` for reuse:
  ```js
  const BB_PALETTE = {
    gold: '#F7941D', goldLight: '#FDCB6E', goldDark: '#D47812',
    orange: '#F26522', bgDark: '#0A1628', bgCard: '#0D2240',
    bgSurface: '#163060', accentBlue: '#56CCF2', accentGreen: '#22C55E',
    textPrimary: '#FFFFFF', textSecondary: '#B0C4DE', textMuted: '#6B8DB5'
  };
  ```
- [ ] **Wire `runDrafter`** — for each draft: if `format_hint === "branded_promo"` → `composeBrandedCard()`; else for IG → real-photo lookup + `composeOverlayCard()`; for X → real-photo lookup, no overlay (Twitter renders headlines from the tweet text itself). For carousels → `findCarouselImages(slides)` then per-slide `composeOverlayCard`. Update `bcb_post_drafts` rows with `image_url` (or `slides[].image_url`) + `image_attribution` + `image_status`.
- [ ] **OverlayCanvas equivalent** for editing — vanilla JS port of Eldrin's React `OverlayCanvas`. Click-and-drag the headline around the hero, live preview, save coords back via PATCH. ~150 LOC inline in `admin-dashboard.html`. Carousel mode shows slide tabs at the top; selecting a slide shows that slide's overlay editor.

**Effort:** 6h (was 3h base, +3h for multi-source cascade, branded composites with palette, carousel image lookups). **LOC:** ~600 (incl. OverlayCanvas). **Depends on:** Phase 3.

---

## Phase 5 — Dashboard "Content" tab

**Goal:** New section in `admin-dashboard.html` showing today's drafts in a 2-column layout (Twitter | Instagram). Per-card: text editor, image preview, regenerate button, funny-twist toggle, manual image-URL paste, skip button, **✓ Approve & Post** button. Carousel cards have a slide editor (slide tabs, per-slide overlay editor, reorder).

### Tasks

- [ ] Add a new top-level tab/section to the SPA — match the existing tab pattern (search for how Engagement Drafts is wired). Role-gate to `'full'` (writes go through `socialPublisher`).
- [ ] Two-column grid: Twitter on left (3 cards), Instagram on right (1 card — single OR carousel).
- [ ] **Per-card UI (Twitter + IG single):**
  - Editable `<textarea>` (text or caption) with character counter (270 for X, 2200 for IG caption).
  - Hero image preview (click → OverlayCanvas modal). Source/photographer credit shown as small caption beneath.
  - **Manual image URL paste** — small `<input>` "Override image URL" — when filled, replaces the auto-found image, sets `image_attribution: 'Manual override'`. Operator owns the rights call.
  - Source URL chip (if present).
  - Hashtags row (editable, comma-separated).
  - Buttons: 🔄 Regenerate · 😄 Funny twist · 🎨 Generate art (FLUX, opt-in only) · ✏️ Edit overlay · ⛔ Skip · ✓ Approve & Post.
- [ ] **Carousel card UI:**
  - Top: deck-level caption editor + hashtags.
  - Slide strip: 3–5 thumbnails with `slide_role` chip ("LEAD", "SECONDARY", "DATA", "QUOTE", "CTA"). Click a thumbnail → that slide's editor below.
  - Slide editor: image preview + manual URL paste + headline (overlay text) + body text + drag-to-reorder slides.
  - Add slide / remove slide buttons (cap at 5).
  - Buttons: 🔄 Regenerate deck · 🔄 Regenerate this slide · 😄 Funny twist (deck-level) · ⛔ Skip · ✓ Approve & Post all.
- [ ] **"Run drafter now" button** at the top of the section — POSTs to `/api/admin/dashboard/run-drafter` (Phase 6).
- [ ] **"Last drafted at" timestamp** — small chip showing when `runDrafter` last completed.
- [ ] Match the existing dashboard's dark theme + card styling. Reuse the engagement-drafts card classes; add carousel-specific styles in the same `<style>` block.
- [ ] **Empty state** — when no draft for today, show "No drafts yet — click Run drafter now to generate today's batch."

**Effort:** 5h (was 3h, +2h for carousel slide editor + funny-twist UX + manual-paste field). **LOC:** ~750 (HTML + CSS + JS, all inline in `admin-dashboard.html`). **Depends on:** Phase 3 (data exists), Phase 4 (images exist).

---

## Phase 6 — Backend REST endpoints

**Goal:** New routes on `adminDashboard.js` (or a new sibling `adminContent.js` if it gets large) for the dashboard to talk to.

### Tasks

- [ ] Add to `adminDashboard.js` (or new `adminContent.js` mounted by `server.js`):
  - `GET  /api/admin/dashboard/post-drafts?date=...&platform=...&status=...` — list drafts.
  - `PATCH /api/admin/dashboard/post-drafts/:id` — update text/caption/hashtags/overlay coords/manual image URL/slide reorder.
  - `POST  /api/admin/dashboard/post-drafts/:id/regenerate` — re-run the prompt. Body: `{ humor_pass?: bool, slide_index?: number }`. `slide_index` regenerates only that slide (carousel only).
  - `POST  /api/admin/dashboard/post-drafts/:id/generate-art` — opt-in FLUX call. Full-role + audit-logged + cost-tracked.
  - `POST  /api/admin/dashboard/post-drafts/:id/skip` — mark skipped with reason.
  - `POST  /api/admin/dashboard/post-drafts/:id/approve` — mark approved + publish (calls `socialPublisher` from Phase 7).
  - `POST  /api/admin/dashboard/run-drafter` — kicks off a fresh drafter run. **Recommended path:** `runDrafter()` fire-and-forget Promise inside the route handler, return 202 immediately. Background work continues; UI polls `GET /post-drafts?date=...` to see results land. Mirrors Eldrin's async-render pattern.
- [ ] All routes gated by `adminAuth.requireAdmin()` (read) or `requireAdmin('full')` (write/regenerate/approve/generate-art).
- [ ] Add tests to `tests/admin-content.test.js` matching `tests/admin-dashboard-api.test.js` style. Cover: auth, list/filter, edit (incl. carousel slide reorder), skip, regenerate (mock the Anthropic call), regenerate with `humor_pass`, approve (mock the publisher), generate-art (mock Replicate).

**Effort:** 2.5h (was 2h, +30m for the additional regenerate variants and slide-reorder PATCH). **LOC:** ~400. **Depends on:** Phase 3.

---

## Phase 7 — `socialPublisher.js` (X + IG OAuth posting)

**Goal:** Actually publish to Twitter and Instagram. **This is the riskiest phase** — both APIs have brittle auth flows.

### Tasks

#### 7a — Twitter v2 publisher

- [ ] Verify the BB Twitter dev app has `tweet.write` scope. If not, redo the OAuth (browser redirect to `https://twitter.com/i/oauth2/authorize?...` from a one-time admin page).
- [ ] Store tokens in `bcb_auth_tokens` collection alongside the IG token (one doc per provider).
- [ ] Add `publishTweet({ text, image_url? })` to `socialPublisher.js`:
  - If image present: download → POST to v1.1 `media/upload` → use `media_id` in v2 `tweets` POST.
  - If text-only: just v2 `tweets`.
  - Return `{ tweet_id, url }`.
- [ ] Refresh-token handling — Twitter access tokens expire in 2h, refresh with the stored refresh token. Mirror Eldrin's pattern.

#### 7b — Instagram Graph publisher

- [ ] OAuth already done by `authInstagram.js` — token in `bcb_auth_tokens`. Reuse.
- [ ] Add `publishInstagramSingle({ image_url, caption })` to `socialPublisher.js`:
  - POST `/{ig-user-id}/media` with `image_url` + `caption` → returns container `id`.
  - Poll `GET /{container_id}?fields=status_code` until `FINISHED` (Meta processes async; usually 1–3s).
  - POST `/{ig-user-id}/media_publish` with that container id.
  - Return `{ media_id, permalink }`.
- [ ] Add `publishInstagramCarousel({ slides: [{ image_url }, ...], caption })`:
  - For each slide: POST `/{ig-user-id}/media` with `image_url` + `is_carousel_item=true` → child container id.
  - POST `/{ig-user-id}/media` with `media_type=CAROUSEL`, `children=[child_id1,child_id2,...]`, `caption=...` → carousel container id.
  - Poll until `FINISHED`.
  - POST `/{ig-user-id}/media_publish` with the carousel container id.
  - Return `{ media_id, permalink }`. **Cap slides at 10** per Meta's hard limit; we cap at 5 in the brief schema for taste.
- [ ] Long-lived token refresh (60-day rolling) — refresh-on-publish-failure. Eldrin chose this; simpler.

#### 7c — Wire approve → publish

- [ ] `POST /api/admin/dashboard/post-drafts/:id/approve` → routes to `publishTweet` / `publishInstagramSingle` / `publishInstagramCarousel` based on `platform` field → on success, updates the draft row with `status: "posted"`, `published_at`, `published_url`. On failure, leaves status as "approved" but adds `last_publish_error` so operator can retry.
- [ ] **Image hosting for IG publish** — IG Graph requires a public HTTPS image URL. Wikimedia/Unsplash/Pexels URLs are already public. `sharp`-composed branded/overlay images need to be hosted somewhere — write to a publicly-readable folder under `public/post-images/{date}/{draft_id}/{slide?}.jpg` served by `express.static('public')`. Cleanup job (Phase 8 candidate): drop images older than 30 days.

**Effort:** 5h (was 4h, +1h for IG carousel multi-step API + public image hosting). **LOC:** ~450. **Depends on:** Phase 6.

---

## Phase 8 — Pi drafter trigger + scheduling

**Goal:** Make the drafter run automatically every morning (after the research script finishes), and let "Run now" from the dashboard force a fresh run.

### Tasks

- [ ] **Decision:** does the drafter run on the Pi (Python wrapper) or on Heroku (JS service called by cron)?
  - **Recommend Heroku** — the drafter is JS, lives in the repo, no Python wrapper needed. Use Heroku Scheduler to run `node contentDrafter.js --auto` every morning at 06:00 CT (1h after Pi research finishes at 23:59 the previous night plus buffer).
- [ ] Alternative for "Run now" button: `bcb_run_jobs.insertOne({kind: "drafter", date: today})` → the Pi poller could SSH/curl to Heroku to trigger, but simpler: have Heroku itself listen on the queue (a 60s setInterval in `server.js`). Or just call `runDrafter()` directly from the route handler in a fire-and-forget Promise (return 202 immediately, render in background — same async pattern Eldrin uses for carousel).
- [ ] Test the cron path on Heroku Scheduler dashboard.
- [ ] Add a small "Last drafted at" timestamp to the Content tab UI so operators see when the drafter last ran.

**Effort:** 1.5h. **LOC:** ~80. **Depends on:** Phase 3.

---

## Phase order summary

```
Phase 1 (Pi brief) ─┐
                    └─► Phase 2 (Mongo store) ─► Phase 3 (drafter) ─┬─► Phase 4 (images) ─┐
                                                                    │                     ├─► Phase 5 (UI) ─► Phase 6 (REST) ─► Phase 7 (publish) ─► Phase 8 (cron)
                                                                    └─────────────────────┘
```

Critical path: 1 → 2 → 3 → 5 → 6 → 7 → 8.
Phase 4 (images) can run parallel to 5/6 once 3 lands.

**Total estimate: ~28h** (with IG carousels + branded composites + multi-source images). Realistic: 4–5 working days. Per Ryan (May 5): full build, no MVP trim.

---

## Phase order if scope is trimmed (MVP-first) — *not selected*

~~Original MVP-first variant — Ryan opted for full build on May 5. Kept here for reference if scope ever needs to be cut mid-build.~~

1. Phase 1 + 2 (~2h)
2. Phase 3 — text-only drafts, no image pipeline yet (~3h)
3. Phase 5 — read-only Content tab, no publish yet, just render the drafts (~2h)
4. Phase 6 — minimal: list + edit + skip (~1h)
5. Show Ryan. If he loves it, continue with Phase 4 (images), 7 (publish), 8 (cron).

That gets a working "review-only" surface in 8h. Operator copy-pastes into native X/IG until publish lands.

---

## Recent changes

*(To be filled in as phases land. Each entry: date, phase #, commit SHA, one-liner.)*

- 2026-05-05 — Doc drafted (this file + CONTENT_CREATION_HANDOFF.md). Commit: `da3f9c0`.
- 2026-05-05 — **Scope amendments from Ryan:**
  - **Carousels in v1** — IG ESPN/Bleacher Report-style breaking-news photo decks (3–5 slides, real photos, optional `sharp` overlay). Phase 4/5/7 expanded.
  - **Real-photo-first imagery** — Wikimedia Commons → Unsplash → Pexels cascade, with manual paste + BB-branded `sharp` composites for promo cards. AI/FLUX is opt-in only.
  - **BB brand palette baked in** — extracted from `index.html` `:root`, exported as `BB_PALETTE` const from `imageRenderer.js` for branded composites (logo + headline + gradient).
  - **Voice tweak** — fun sportsbook tone with occasional humor (`allow_humor` knob on briefs, funny-twist toggle in UI).
  - **Twitter scope** — Ryan confirms BB Twitter app is configured; verify `tweet.write` scope at Phase 7 (not blocking).
  - **Full build, no MVP trim** — all 8 phases.
  - Working branch: `content-creation`. Commit: TBD (this commit).

---

## Open questions — status

- ~~**Before Phase 1**: Day-of-week rotation correct for X+IG?~~ **Resolved (May 5):** keep the existing 7-day rotation in `bcbay_research.py`. X gets 3 takes/day, IG gets 1 carousel-or-single/day.
- **Before Phase 3**: Should the post drafter prompt include the *full* current voice block from the engagement scripts as few-shot, or a curated subset? (Eldrin used a curated subset to keep token count down.) — **Default: curated subset (~10 examples). Ask Ryan to confirm before drafting prompts.**
- ~~**Before Phase 4**: Cloudinary or `sharp` for overlays? FLUX budget — yes/no for v1?~~ **Resolved (May 5):** `sharp` for overlays + branded composites. FLUX opt-in only via per-card "Generate art" button.
- **Before Phase 7**: Confirm the Twitter dev app has `tweet.write` scope. — **Per Ryan May 5:** "we should already have twitter configed on the app." Will verify via the existing `bcbay_twitter_engagement.py` creds when Phase 7 lands; not blocking earlier phases.
- ~~**Before Phase 8**: Heroku Scheduler vs. on-demand-only vs. Pi-driven?~~ **Resolved (May 5):** Heroku Scheduler at 06:00 CT (1h after Pi research finishes). On-demand "Run now" runs `runDrafter()` fire-and-forget from the Heroku route handler.

---

*Pair this doc with [CONTENT_CREATION_HANDOFF.md](CONTENT_CREATION_HANDOFF.md). Both should be kept in sync as work lands.*
