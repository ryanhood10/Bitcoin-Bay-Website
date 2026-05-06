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
  - `instagram`: list of 1 topic (visual-first; should map well to a Wikimedia Commons photo).
- [ ] Each topic in the list has shape: `{ topic, angle, source_url|null, image_subject, primary_keyword, secondary_keywords[], format_hint }`.
  - `format_hint` ∈ `["take", "data_card", "preview_grid", "athlete_card", "recap_summary"]` — drafter will use this to pick a layout.
- [ ] Bump `max_tokens` if the brief output starts truncating (Eldrin hit a 8K → 20K bump when adding per-platform streams).
- [ ] Update `validate_research_output` to also check `per_platform_topics` is present.
- [ ] Smoke test: run `python3 ~/bcbay/bcbay_research.py` manually, inspect the resulting JSON, confirm both streams populate cleanly on a Mon/Tue/Wed sample.

**Effort:** 1.5h. **LOC:** ~80. **Depends on:** nothing.

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
- [ ] **Per-platform prompts** — port from Eldrin's `postDrafter.js:PROMPTS`, then rewrite. Two prompts: `twitter` and `instagram`.
  - Both share a "BB voice" preamble (sharp handicapper, beach-coded, no tout-speak, no licensed/regulated, neutral geography).
  - Twitter prompt produces JSON: `{ text (≤270 chars), hashtags[], suggested_image_subject, source_url|null, takeaway_one_liner }`.
  - Instagram prompt produces JSON: `{ caption, hashtags[10-15], suggested_image_subject, image_overlay_text (short headline + handle), format_hint }`.
- [ ] **Voice anchoring**: read `~/bcbay/bcbay_twitter_engagement.py` + `~/bcbay/bcbay_instagram_engagement.py` on the Pi, extract the persona/voice blocks, paste them into the drafter prompts as the canonical voice reference. (Eldrin learned the hard way: the engagement-side voice is the operator's trusted voice; the post drafter must match it.)
- [ ] **Compliance block** in both prompts (verbatim — same words `bcbay_research.py` uses):
  > NEUTRAL GEOGRAPHY ONLY. Do not claim licensure or regulation. Do not predict guaranteed wins. Do not use US-style promo language. Journalism first, product plug last.
- [ ] **Source citation** — when `source_url` is present on a topic, the drafter should include it in the tweet (X handles URLs natively) and link in the IG caption. Mirror Eldrin's `SOURCE CITATION` block.
- [ ] **Athlete×Crypto pinning** — when `forced_override` is true on the brief, swap the first Twitter draft with the override topic regardless of day rotation.
- [ ] Write drafts to `bcb_post_drafts` with shape:
  ```js
  {
    _id, platform: "twitter"|"instagram",
    brief_date, topic, angle, format_hint,
    text|caption, hashtags, source_url, image_subject,
    image_overlay_text?, image_url?, image_status: "pending"|"ready"|"failed",
    status: "draft"|"approved"|"posted"|"skipped", skip_reason?,
    created_at, updated_at, published_at?, published_url?
  }
  ```
- [ ] Add a CLI entry: `node contentDrafter.js --date 2026-05-05` for manual smoke testing.

**Effort:** 4h. **LOC:** ~400. **Depends on:** Phase 2.

---

## Phase 4 — Hero image pipeline

**Goal:** Each post draft gets a hero image. Strategy: Wikimedia Commons first (free, editorial-grade), FLUX fallback if a credible Commons hit isn't available.

### Tasks

- [ ] Create `imageRenderer.js` at repo root.
  - `findHeroImage(subject)` — query Wikimedia Commons API for `subject`, return `{ url, attribution, license }` or null. **Reuse the lookup logic from `~/bcbay/bcbay_blog.py:fetch_wikimedia_image()`** — port it to JS.
  - `generateFallbackImage(prompt)` — only if Wikimedia returns null; calls Replicate FLUX. Optional in v1; can stub to "no image" until Ryan asks for it.
- [ ] **Overlay text** — for Instagram drafts, render the `image_overlay_text` (short headline + @handle) on top of the hero image. Two options:
  - (A) Cloudinary `l_text` overlay on a transformed URL — easiest, no rendering on Heroku. Requires a Cloudinary account.
  - (B) `sharp` + `svg` text composite — runs on Heroku, no external service.
  - **Recommend (A)** — Eldrin uses it, well-understood.
- [ ] Wire `runDrafter` to call `findHeroImage(image_subject)` for each draft after the text is produced. Update `bcb_post_drafts` row with `image_url` + `image_status`.
- [ ] **OverlayCanvas equivalent** for editing — port Eldrin's React `OverlayCanvas` to vanilla JS. Click-and-drag the headline + handle around the hero, live preview. (~150 LOC of vanilla JS in `admin-dashboard.html`.)

**Effort:** 3h (without OverlayCanvas), 5h (with). **LOC:** ~250 (without OverlayCanvas), ~400 (with). **Depends on:** Phase 3.

---

## Phase 5 — Dashboard "Content" tab

**Goal:** New section in `admin-dashboard.html` showing today's drafts in a 2-column layout (Twitter | Instagram). Per-card: text editor, image preview, regenerate button, skip button, **✓ Approve & Post** button.

### Tasks

- [ ] Add a new top-level tab/section to the SPA — match the existing tab pattern (search for how Engagement Drafts is wired).
- [ ] Two-column grid: Twitter on left (3 cards), Instagram on right (1 card).
- [ ] Per-card UI:
  - Editable `<textarea>` (text or caption) with character counter.
  - Hero image preview (clickable to open OverlayCanvas if Phase 4 included it).
  - Source URL chip (if present).
  - Hashtags row (editable).
  - Buttons: 🔄 Regenerate · ✏️ Edit overlay · ⛔ Skip · ✓ Approve & Post.
- [ ] Add a "Run drafter now" button at the top of the section — POSTs to `/api/admin/dashboard/run-drafter` (Phase 6) and queues a Pi job (or runs the JS drafter directly — see Phase 6 decision).
- [ ] Match the existing dashboard's dark theme + card styling.

**Effort:** 3h. **LOC:** ~500 (HTML + CSS + JS, all inline in `admin-dashboard.html`). **Depends on:** Phase 3 (data exists), Phase 4 (images exist).

---

## Phase 6 — Backend REST endpoints

**Goal:** New routes on `adminDashboard.js` (or a new sibling `adminContent.js` if it gets large) for the dashboard to talk to.

### Tasks

- [ ] Add to `adminDashboard.js` (or new `adminContent.js` mounted by `server.js`):
  - `GET  /api/admin/dashboard/post-drafts?date=...&platform=...&status=...` — list drafts.
  - `PATCH /api/admin/dashboard/post-drafts/:id` — update text/caption/hashtags/overlay coords.
  - `POST  /api/admin/dashboard/post-drafts/:id/regenerate` — re-run the prompt.
  - `POST  /api/admin/dashboard/post-drafts/:id/skip` — mark skipped with reason.
  - `POST  /api/admin/dashboard/post-drafts/:id/approve` — mark approved + publish (calls `socialPublisher` from Phase 7).
  - `POST  /api/admin/dashboard/run-drafter` — kicks off a fresh drafter run. **Decision:** run JS drafter inline (fast, but blocks request up to 30s — risky on Heroku) OR queue a Pi job (`bcb_run_jobs.insertOne({kind: "drafter"})` and the Pi poller drains it). **Recommend Pi-queued** — no H12 risk, matches engagement-drafts pattern.
- [ ] All routes gated by `adminAuth.requireAdmin()` (read) or `requireAdmin('full')` (write).
- [ ] Add tests to `tests/admin-content.test.js` matching `tests/admin-dashboard-api.test.js` style. Cover: auth, list/filter, edit, skip, regenerate (mock the Anthropic call), approve (mock the publisher).

**Effort:** 2h. **LOC:** ~300. **Depends on:** Phase 3.

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
- [ ] Add `publishInstagramPost({ image_url, caption })` to `socialPublisher.js`:
  - POST `/{ig-user-id}/media` with `image_url` + `caption` → returns container `id`.
  - POST `/{ig-user-id}/media_publish` with that container id.
  - Return `{ media_id, permalink }`.
- [ ] Long-lived token refresh (60-day rolling) — schedule a daily cron OR refresh-on-publish-failure. Eldrin chose refresh-on-failure; simpler.

#### 7c — Wire approve → publish

- [ ] `POST /api/admin/dashboard/post-drafts/:id/approve` → calls the right publisher → on success, updates the draft row with `status: "posted"`, `published_at`, `published_url`. On failure, leaves status as "approved" but adds `last_publish_error` so operator can retry.

**Effort:** 4h. **LOC:** ~350. **Depends on:** Phase 6.

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

**Total estimate: 19h** (without carousel). Realistic: 3 working days.

---

## Phase order if scope is trimmed (MVP-first)

If Ryan wants to ship something quick:

1. Phase 1 + 2 (~2h)
2. Phase 3 — text-only drafts, no image pipeline yet (~3h)
3. Phase 5 — read-only Content tab, no publish yet, just render the drafts (~2h)
4. Phase 6 — minimal: list + edit + skip (~1h)
5. **Show Ryan**. If he loves it, continue with Phase 4 (images), 7 (publish), 8 (cron).

That gets a working "review-only" surface in 8h. Operator copy-pastes into native X/IG until publish lands.

---

## Recent changes

*(To be filled in as phases land. Each entry: date, phase #, commit SHA, one-liner.)*

- 2026-05-05 — Doc drafted (this file + CONTENT_CREATION_HANDOFF.md). Commit: TBD.

---

## Open questions to ask Ryan before each phase

- **Before Phase 1**: Is the day-of-week rotation already correct for X+IG strategy, or do you want X to follow a different cadence than the blog?
- **Before Phase 3**: Should the post drafter prompt include the *full* current voice block from the engagement scripts as few-shot, or a curated subset? (Eldrin used a curated subset to keep token count down.)
- **Before Phase 4**: Cloudinary or `sharp` for overlays? FLUX budget — yes/no for v1?
- **Before Phase 7**: Confirm the Twitter dev app has `tweet.write` scope before we touch the publisher code. If not, we burn 1h on OAuth re-flow.
- **Before Phase 8**: Heroku Scheduler vs. on-demand-only vs. Pi-driven? Default: Scheduler at 06:00 CT.

---

*Pair this doc with [CONTENT_CREATION_HANDOFF.md](CONTENT_CREATION_HANDOFF.md). Both should be kept in sync as work lands.*
