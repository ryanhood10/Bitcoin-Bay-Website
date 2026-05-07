# Bitcoin Bay — Content Strategy

> Captures the research and decisions that drive what the content drafter produces and how the dashboard surfaces it. Sister to [CONTENT_CREATION_HANDOFF.md](CONTENT_CREATION_HANDOFF.md) (architecture) and [CONTENT_CREATION_PLAN.md](CONTENT_CREATION_PLAN.md) (build phases). This doc is the WHY; the others are the HOW.
>
> Last refreshed: 2026-05-06 after a Phase 6.9 research pass with two parallel agents (UI/UX + competitive sportsbook content).

## North star

Two distinct outputs from one daily research brief:

| Surface | Purpose | Voice | Length |
|---|---|---|---|
| **Blog post** (`/blog/:slug`) | **SEO** — drive organic discovery via keyword-targeted long-form content | Authoritative, journalistic, sharp-handicapper-but-readable | 1,200-2,500 words |
| **Twitter / X** (`@BitcoinBay_com`) | **Engagement** — show up in sports-fan timelines with reactive takes | Meme/reaction (default) OR professional/news (variant). Heavy emoji ok, first-name basis | 3-12 words |
| **Instagram** (`@bitcoin_bay`) | **Engagement** — hype-fan visuals + carousels for breaking news | Short hype-fan caption + 5-7 sport hashtags | 50-250 chars |

The blog and the socials **share a research brief but are independently topic-picked**. The blog optimizes for keyword targeting + uniqueness vs the last 14 days of blog history; the socials optimize for "is this worth saying right now." They CAN overlap on a high-news day but generally don't.

---

## How the brief decomposes

```
bcb_post_briefs/{date}
├── blog_research            → bcbay_blog.py (Pi nightly)
│   └── topic, title, key_facts, image_subject, primary_keyword, ...
├── video_research           → bcbay_video.py (Dell, separate pipeline)
├── per_platform_topics      → contentDrafter.js (Heroku, on-demand)
│   ├── twitter: [3 topics]
│   └── instagram: { ... single or carousel ... }
├── breaking_news            → context for all
└── data_driven              → context for blog when applicable
```

Field shape per Twitter topic (after Phase 6 amendments):
```js
{
  topic, angle, source_url, primary_keyword, secondary_keywords[],
  format_hint, allow_humor,
  image_subject,         // FULL athlete name, no abstractions
  image_scene_prompt,    // null OR a Replicate AI scene prompt
  time_window_hint,      // anytime | pre_tipoff | halftime | post_game
}
```

---

## Voice (anchored on real account history)

Pulled live from @BitcoinBay_com (last 11 tweets) and @bitcoin_bay (last 15 IG posts) on 2026-05-06.

### @BitcoinBay_com — actual voice

```
"OH NO SGA 😳"
"Bane doing the most per usual"
"Greatest shot in history??"
"Can't take DB seriously in this suit"
"Wolves & Nuggets game got me like"
"💰💰💰💰"
"How do you lose this series @Celtics"
```

- **3-7 words.** Almost all are quote-tweet reactions to a highlight.
- **Heavy emoji** on the right beat (😳 🔥 💰 🎯 👑 🥶).
- **First-name basis** with athletes (Bane, SGA, DB, Jaylen).
- **Zero hashtags.** Twitter hides them and they kill reach.
- **Zero crypto slang** ("wagmi", "lfg", etc.).
- **Reaction, never lecture.**

This is the operator's actual voice. It's also exactly the playbook the Lane B sportsbooks (PrizePicks, Underdog Fantasy) ride to 5-10x engagement-per-follower vs the Lane A majors (DraftKings, FanDuel).

### @bitcoin_bay — actual voice

```
"Doing this at 41 is crazy. The KING 👑"
"This man is such a cheat code 👽"
"Brooks and the Suns are ready for a BATTLE."
"HUGE WIN FOR THE TIDE!! 🐘"
"Ice in his veins 🥶🐜"
"This lucky customer got his Super Bowl…but something was a little off 😂"
```

- **1-3 sentences.** 50-250 char captions (NOT 600-1100).
- **5-7 sport-specific hashtags** at the end (separate paragraph). Mix broad + specific (`#nba` + `#celtics`).
- **Emoji sparingly but emphatically** (👑 🔥 🐘 🥶 👽 😂).
- **Hype-fan voice.** Light commentary, not analysis.
- **Best-performing posts are the funniest observations.**

### Compliance constraints (absolute)

- NEVER name competitors (DraftKings, FanDuel, BetMGM, Caesars, BetRivers, ESPN BET, PrizePicks, Hard Rock Bet, Underdog).
- NEVER use US-style promo voice ("Sign up now!", "100% match!", "Bonus boost!").
- NEVER claim licensure / regulation / state-targeting.
- NEVER use tout-speak ("lock of the day", "guaranteed winner", "can't-miss").
- NEVER use crypto slang ("wagmi", "to the moon", "lfg", "gm", "ngmi", "based", "fren").
- Sports betting is 21+. Never target minors.

These constraints are baked into the contentDrafter prompt block AND the Pi research prompt block. They are non-negotiable.

---

## Competitive landscape (Lane A vs Lane B)

The sportsbook category on social splits cleanly:

**Lane A — major books** (DraftKings, FanDuel, BetMGM, Caesars, ESPN BET): polished broadcast-style, promo blasts, state-targeted CTAs, branded odds graphics, athlete partnerships. Voice is corporate-fan-adjacent — calibrated, low-emoji. **Engagement rates run thin** (~0.02–0.15% on X, ~0.3–0.8% on IG) because reach is large but content is transactional.

**Lane B — challenger DFS / pick'em** (PrizePicks, Underdog Fantasy): meme/reaction, athlete first-name energy, quote-tweets within 5 min of broadcast highlights, fan-roast humor. **Consistently 5-10x Lane A engagement-per-follower.**

**Bitcoin Bay is structurally Lane B.** The compliance constraints actively help — BB physically cannot do the Lane A promo voice. Lean into the lane the brand belongs to.

| Account | Voice | Best archetype | BB-relevant? |
|---|---|---|---|
| DraftKings | Polished + promo-forward | Branded odds graphic + promo CTA | ❌ promo voice off-limits |
| FanDuel | Same lane, slightly more meme | Player highlight + reaction one-liner | ⚠️ partial — clip+reaction yes, branded odds no |
| BetMGM | Lion-branded, celebrity-tied | Celebrity ambassador videos | ❌ no ambassadors |
| Caesars | Corporate, gladiator | Branded prop bet graphic | ❌ |
| ESPN BET | Leverages ESPN talent + clip rights | Live clip + analyst quote-tweet | ⚠️ partial — quote-tweet news yes, no clip rights |
| **PrizePicks** ⭐ | Pure meme/reaction. First-name. Heavy emoji. Zero hashtags on X. | Quote-tweet viral highlight in <5 min with 3-7 word reaction | ✅ closest model |
| **Underdog Fantasy** ⭐ | Meme + data hybrid. Player-card visuals on IG. Fan-roast humor on X. | "Receipt" posts (called it earlier in week, posts proof) | ✅ adopt the receipt pattern |

---

## Engagement multipliers BB can adopt

1. **Quote-tweet viral highlights within 5 minutes of broadcast.** Lead with a 1-3 emoji reaction, then a 3-7 word observation. No link, no hashtag. PrizePicks runs this constantly during NBA windows; lands 1k+ engagement on accounts BB's size. Requires Pi to surface live game-state events, not just morning recaps. *(Phase 8 — see deferred work below.)*

2. **The "receipt" post.** Underdog pattern — when a take from earlier in the week hits, screenshot or quote-link the original post with a 2-4 word capper ("called it ✍️"). Builds credibility flywheel. Requires Mongo log of past posts. *(Phase 8 — see below.)*

3. **First-name basis with athletes.** ALREADY on-brand. Reinforced as a HARD rule in the drafter prompt and the Pi research prompt's `image_subject` field guidance.

4. **Reaction-face-only image posts.** A still frame of an athlete's reaction face (joy, disgust, shock) + a 3-5 word caption out-engages branded graphics 3-5x on X. Works because it's screenshot-shareable. The image renderer cascade is already photo-first. *(Pi could flag "high-emotion moment" still-frames specifically — Phase 8.)*

5. **"POV: you bet on…" framing on IG carousels.** Underdog and PrizePicks use 2nd-person fan POV captions heavily. Compliance-safe (no tout, no promo) and fits BB's hype-fan voice. Try it: "POV: you faded the Lakers tonight 😬".

6. **Game-window posting cadence.** Top accounts cluster 60-80% of their X output in the 30 min before tipoff, during commercial breaks, and within 10 min of the final whistle. BB's daily-brief-driven cadence misses all of that. Phase 6 added `time_window_hint` to topics so the dashboard can sort/highlight on this once Pi populates it.

7. **Polls and binary "who you got?" posts.** Underdog runs these constantly pre-game. Compliance-safe, drives reply volume, replies become next day's quote-tweet ammo. *(Phase 8 — add a poll/binary topic type to the IG schema.)*

8. **"Bad beat" community catharsis posts.** PrizePicks regularly posts "if you had X over by 0.5..." style commiseration. Reads as fan-with-fans, not house-vs-customer. BB compliance allows observational humor about losses; lean in.

---

## Anti-patterns — DO NOT adopt

1. **Branded odds graphics with sign-up CTAs.** DK/FanDuel ubiquitous. BB cannot do "$X promo" voice and shouldn't try a softened version — reads as off-brand. Compliance fail and brand fail.
2. **State/jurisdiction targeting.** "Live in NJ tonight" / "Now legal in MD" — hard compliance fail. Pi brief must never surface state-targeted news angles.
3. **"Lock of the day" / pick-confidence framing.** Even when competitors get away with it via influencer accounts, BB cannot. Drafter rejects any topic angle that reads as a tout.
4. **Crypto-Twitter slang ("wagmi", "lfg", "to the moon").** Already in the never-list. Worth re-flagging because trend-mining on a live X feed will surface this constantly during BTC moves; the drafter must filter.
5. **Naming competitors — even subtweet style.** PrizePicks subtweets DraftKings frequently. BB cannot. Drafter prompt's never-list covers; consider adding a post-generation lint check on competitor name tokens before any post hits the operator queue.

---

## UI patterns — making the dashboard feel native

The UI research agent (UI/UX deep dive on Twitter / Instagram / Buffer / Hootsuite / Later / Sprout Social, 2026-05-06) surfaced eight specific recommendations. Phase 6.9 implemented the high-leverage subset. The single biggest "feels native" lever per the research:

> Render hashtags as **inline blue text inside the body, not as pills underneath.** Auto-detect `#word` and `@word` in the text. Both X and IG do this — every SaaS tool that splits hashtags into pills loses the native feel.

✅ **Shipped.** `renderInlineText()` colors hashtags + mentions with the platform's blue.

Other patterns shipped in Phase 6.9:
- ✅ Card widths constrained to native (Twitter 580px, IG 470px)
- ✅ Twitter avatar + handle header
- ✅ IG gradient-ring avatar + native action-row mock + "Liked by..." placeholder
- ✅ Carousel "1/N" pill + dot row (replaces giant thumbnail strip)
- ✅ Click-to-edit on the styled preview (Buffer pattern)
- ✅ Hover-revealed action chrome
- ✅ Single-active-slide editor (replaces stacked-vertically panels)

Patterns deferred to a future v2:
- ❌ Full Buffer-style "preview IS the editor" via contenteditable (would replace textarea entirely; current click-to-edit toggles textarea visibility — close but not the same)
- ❌ Hootsuite-style per-network tabs above one canvas (we already have side-by-side columns; don't think this would help)
- ❌ Slide-over drawer for deep edits (current Advanced expander serves the same purpose)

---

## Deferred work (Phase 8 / future)

Big-leverage items that need separate sessions:

1. ~~**Pi-side live game-state polling**~~ **LANDED 2026-05-06 as operator-pull (not auto-polling).** Re-scoped after operator feedback ("admin only logs in 1× a day; rare use, don't make it expensive"). Now: Pi nightly populates `bcb_post_briefs.todays_games` with the day's most popular games (NBA/NFL/MLB/NHL/UFC/CFB/MLS, ~10 games filtered by big-market team + national broadcast). The dashboard's "Today's games" panel shows them. Operator clicks **📡 Live state** → ESPN proxy returns score + last 5 plays + win prob. Operator clicks **✍️ Draft tweet** → Claude generates 2 variants (meme + professional) seeded from the live state, costs ~$0.04. Default state: $0/day if operator doesn't touch it. ESPN free API; no key required.

2. **Receipts pattern** ("called it ✍️" callbacks). Requires Mongo log of past posts (`bcb_published_posts` collection). When today's news matches an angle BB posted on within the last 14 days, the brief's `receipts_candidate` field surfaces the original post ID + outcome. Drafter can craft a callback. Maybe 4 hours of work.

3. **Trending sports-meme tracker.** Daily scan of sports-Twitter top quote-tweeted clips and the dominant fan reaction format ("[athlete] doing the most", "POV:", reaction-image templates). Surface 2-3 active meme formats per day with example fills so the drafter can echo current internet voice without going stale. Requires X API + clip-trending API.

4. **Tagged athlete bio context.** When a topic centers on an athlete, the brief pre-loads: full name, common nicknames/first-name usage, team, jersey #, last 7-day storyline. Lets the drafter make first-name-basis decisions without hallucinating nicknames (drafter has gotten "DB" wrong before).

5. **Pi → Heroku push for fresh moments.** The dashboard "Run drafter now" + Heroku Scheduler cron handle the daily case. For sub-hour moments, the Pi should be able to push directly via a webhook to `/api/admin/dashboard/run-drafter` on Heroku, scoped to the moment topic only.

---

## What's been shipped (timeline)

- **Phases 3-6 (2026-05-05/06)** — Drafter, image renderer, dashboard SPA, REST endpoints, Replicate AI scene generation, voice refresh from live accounts, variant generation, native preview UI, click-to-edit. See `CONTENT_CREATION_PLAN.md` recent-changes for commit SHAs.
- **2026-05-06 — Pi prompt amendments**: image_subject tightening (full athlete names, no abstractions), image_scene_prompt added to all topic levels, time_window_hint added per topic. Backward-compatible — validator doesn't enforce the new fields, downstream code falls back to defaults if Claude omits them.

---

*This doc is durable across Claude sessions. Update the "what's been shipped" section + recent changes in CONTENT_CREATION_PLAN.md whenever the content drafter or strategy evolves.*
