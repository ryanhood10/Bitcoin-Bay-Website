// ---------------------------------------------------------------------------
// contentDrafter.js — turns the daily Pi research brief into approved-by-
// operator-style draft posts for X (Twitter) and Instagram (single + carousel).
//
// Reads:  bcb_post_briefs (one doc per date — written by bcbay_research.py
//         after Phase 2; see ~/bcbay/bcbay_research.py).
// Writes: bcb_post_drafts (one doc per draft — operator approves/edits/skips
//         from /admin/dashboard → Content tab).
//
// Three prompt variants:
//   - twitter            (3 drafts per run, ≤270 chars each)
//   - instagram_single   (1 draft, single hero image)
//   - instagram_carousel (1 draft, 3-5 slides; each slide has its own image)
//
// Voice anchored on the operator-trusted BB engagement scripts on the Pi
// (`~/bcbay/bcbay_twitter_engagement.py:VOICE_BRIEF` and the IG comment-drafter
// prompt). Compliance block is verbatim from `bcbay_research.py:COMPLIANCE_RULES`
// — neutral geography, no licensure claims, no tout-speak, no US-style promo.
//
// Public exports:
//   runDrafter({ briefDate?, dryRun? })       — generate all drafts for a date
//   regenerateDraft(draftId, { humorPass?, slideIndex?, newAngle? })
//
// CLI:
//   node contentDrafter.js                 — runs against today's brief
//   node contentDrafter.js --date 2026-05-06  — specific date
//   node contentDrafter.js --dry-run       — print drafts, don't write to Mongo
// ---------------------------------------------------------------------------

const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const imageRenderer = require('./imageRenderer');

const MONGO_DB        = process.env.MONGO_AUTOMATION_DB || 'bcbay_automation';
const BRIEFS_COLL     = 'bcb_post_briefs';
const DRAFTS_COLL     = 'bcb_post_drafts';
const ADMIN_LOG_COLL  = 'bcb_admin_log';
const CLAUDE_MODEL    = process.env.BCBAY_DRAFTER_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS      = 4000;

// ── Mongo helper (mirrors adminDashboard.js per-request connection pattern) ──
function getAutomationUri() {
  return process.env.MONGO_AUTOMATION_URI || process.env.MONGO_URI;
}
async function withDb(fn) {
  const uri = getAutomationUri();
  if (!uri) throw new Error('MONGO_AUTOMATION_URI (or MONGO_URI) not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    return await fn(client.db(MONGO_DB));
  } finally {
    try { await client.close(); } catch (_) {}
  }
}

// ── Anthropic client (lazy singleton) ──
let _client = null;
function getAnthropic() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// ── BB VOICE BLOCKS ──
// Three voice variants, all grounded in real-world samples pulled from the
// live @BitcoinBay_com (Twitter) and @bitcoin_bay (Instagram) accounts on
// 2026-05-06. The current accounts post:
//   Twitter: 3-7 word reactions, heavy emoji, first-name basis with athletes
//            ("OH NO SGA 😳", "Bane doing the most per usual", "💰💰💰💰")
//   IG:      1-3 sentence highlight-reel captions with 5-6 sport hashtags
//            ("Doing this at 41 is crazy. The KING 👑")
// The earlier "Sharp handicapper at the beach bar" framing was off-voice for
// these accounts; the meme/reaction voice is what the operator actually posts.
// Professional/news is kept as a separate variant so the drafter can produce
// both per Twitter topic and let the operator pick (Phase 6.2).
const BB_VOICE_BASE = `
You are drafting an ORIGINAL post for Bitcoin Bay (@BitcoinBay_com on X,
@bitcoin_bay on Instagram). Bitcoin Bay is a bitcoin-native sports-betting
platform and casino. Audience: people who love sports AND love crypto.

NEVER:
- Name competitors (DraftKings, FanDuel, BetMGM, Caesars, BetRivers, ESPN BET,
  PrizePicks, Hard Rock Bet, Underdog). Don't reference, don't compare.
- Use cringe crypto slang: "wagmi", "to the moon", "lfg", "gm", "ngmi",
  "based", "fren", "ser", "anon".
- Promise outcomes, predict prices, or recommend specific bets ("lock of the
  day", "free play", "guaranteed", "must-bet"). Analysis is fine; tout-speak
  is not.
- Use US-style promo voice: "Sign up now!", "100% match!", "Bonus boost!",
  excessive exclamation, urgency-bait.
- Drop generic links or "DM me / check out / visit our site". The post stands
  on its own.
`.trim();

const BB_VOICE_TWITTER_MEME = `${BB_VOICE_BASE}

PLATFORM VOICE: TWITTER, MEME / REACTION VARIANT (default).

Anchor on the actual @BitcoinBay_com voice — these are real recent tweets:
  "OH NO SGA 😳"
  "Bane doing the most per usual"
  "Greatest shot in history??"
  "Can't take DB seriously in this suit"
  "Wolves & Nuggets game got me like"
  "💰💰💰💰"
  "How do you lose this series @Celtics"

Rules:
- 3-12 words is the sweet spot. Short. Punchy. Reaction-style.
- 1-3 emoji on the right beat is fine (😳 🔥 💰 🎯 👑 🥶 ✍️). NEVER spam emoji.
- First-name basis with athletes (Bane, SGA, Mahomes, DB, Jaylen).
- Casual sports-fan voice. "got me like", "doing the most", "no chance", etc.
- ZERO hashtags. Twitter hides them and they kill reach.
- ZERO inline links in the text body. If a source URL exists, it appends to
  the tweet on its own line for the quote-tweet-card render. Otherwise no URL.
- React, don't lecture. If you're tempted to analyze, stop and just react.`.trim();

const BB_VOICE_TWITTER_PROFESSIONAL = `${BB_VOICE_BASE}

PLATFORM VOICE: TWITTER, PROFESSIONAL / NEWS VARIANT.

This variant exists for posts where a meme reaction would be off-key — data
days, breaking athlete×crypto news, line-move explainers, BTC-volatility
reads. The operator picks this variant via the swap toggle when warranted.

Rules:
- 1-2 short sentences. 100-220 chars total (excluding URL).
- Data-led or news-led. Cite a number, a fact, a name.
- ZERO emoji.
- ZERO hashtags.
- Cite the source URL at the end if present (X auto-renders it as a card).
- Never tout-speak. Analysis fine; guarantees not.
- Conversational-but-informative; not corporate, not stiff.`.trim();

const BB_VOICE_IG = `${BB_VOICE_BASE}

PLATFORM VOICE: INSTAGRAM, HYPE-FAN VARIANT.

The vibe should feel like our @BitcoinBay_com Twitter — meme/reaction style,
first-name basis, casual sports-fan energy — just sized up for IG's 1-3
sentence caption window. Anchor on the actual @bitcoin_bay voice — real
recent captions:
  "Doing this at 41 is crazy. The KING 👑"
  "This man is such a cheat code 👽"
  "Brooks and the Suns are ready for a BATTLE."
  "HUGE WIN FOR THE TIDE!! 🐘"
  "Ice in his veins 🥶🐜"
  "This lucky customer got his Super Bowl…but something was a little off 😂"

Rules:
- 1-3 short sentences typical. 50-250 chars target. NOT 600-1100.
- Hype-fan voice. Conversational. Light commentary, not analysis.
- 1-2 emoji where they earn the spot (👑 🔥 🐘 🥶 👽 😂 💰 ✍️).
- 5-7 sport-specific hashtags at the end (separate paragraph). Mix broad +
  specific (e.g. #nba + #celtics, #nflfootball + #chiefs).
- First-name basis with athletes.
- The funniest observations perform best — lean into that without forcing it.
- Carousel slide HEADLINES should feel like punchy quote-tweets: 3-10 words,
  reaction-flavored, NOT explainer-heavy. Body text under each headline is
  the one specific fact that makes the headline land.`.trim();

// Backward-compat alias (slide-only carousel regen path uses this)
const BB_VOICE = BB_VOICE_IG;

// ── COMPLIANCE BLOCK (verbatim from bcbay_research.py:COMPLIANCE_RULES) ──
const COMPLIANCE = `
COMPLIANCE — ABSOLUTE. Violating any of these breaks the post.
- Bitcoin Bay is NOT a US company and does NOT claim to be licensed or
  regulated. Never use the words "licensed", "regulated", "legal in your
  state", "US-approved", "compliant with US gaming law", or name any
  specific jurisdiction (Curaçao, Costa Rica, etc.) in marketing copy.
- Cover American sports aggressively (NFL, NBA, MLB, NHL, UFC, CFB, CBB)
  — they are just sports. But keep geography NEUTRAL. Do NOT write "bet
  on the Cowboys from Texas", "available to US players", "legal in your
  state". No state-by-state targeting language.
- Never use "guaranteed winner", "lock of the day", "can't-miss pick",
  or any tout-speak. Analysis fine; guarantees not.
- Bitcoin Bay accepts KYC'd players from around the world and takes
  Bitcoin plus 11 other cryptocurrencies. Frame as "the serious crypto
  sportsbook that verifies its players" — never "anonymous" or "no-KYC".
- No content that targets minors. Sports betting is 21+.
- Humor (when allow_humor: true) MUST stay punching-up or topic-observational.
  No punching down, no slurs, no jokes about real personal losses or
  gambling addiction, no jokes that age someone, no body shaming.
`.trim();

// ── HUMOR BLOCK (only injected when allow_humor: true OR humor_pass override) ──
const HUMOR_BLOCK = `
🎭 HUMOR PASS IS ACTIVE FOR THIS POST.

Lead with a sharp comedic angle — observational humor about the matchup,
the rivalry, the line move, the crypto market reaction. Think: a fan who
knows their stuff and isn't afraid to roast a bad-beat play, but never
mean to a real person. Examples of the right tone:
- "Bills fans, look away."
- "Lakers in 4. (Of 7.)"
- "BTC dipped 4% — your parlay didn't dip; it vaporized."
- "Calling this game 'must-watch' implies you have a choice."
- "The line moved a full point because someone in Vegas saw the practice tape."

Constraints (compliance still applies):
- Never punch down. No body humor. No addiction jokes. No nationality jokes.
- Stay punny/observational, never mean about a real person.
- One joke is funny. Two is a bit. Three is a sketch — stop at one.
`.trim();

// ── PROMPT BUILDERS ──

function buildTwitterPrompt(topic, ctx) {
  // voiceKind: 'meme' (default) or 'professional'. Phase 6.2 calls this twice
  // per topic to pre-generate both variants and let the operator swap.
  const voiceKind = ctx.voiceKind === 'professional' ? 'professional' : 'meme';
  const voiceBlock = voiceKind === 'professional'
    ? BB_VOICE_TWITTER_PROFESSIONAL
    : BB_VOICE_TWITTER_MEME;
  const humorBlock = (ctx.humorPass || topic.allow_humor) ? HUMOR_BLOCK : '';
  const sourceLine = topic.source_url
    ? (voiceKind === 'professional'
        ? `Cite the source URL at the end of the tweet (X auto-renders it as a card). URL: ${topic.source_url}`
        : `Source URL is available; append it on its own line at the end so X renders the quote-tweet card. URL: ${topic.source_url}`)
    : 'No source URL — make the take stand on its own.';
  return `${voiceBlock}

${COMPLIANCE}

${humorBlock}

PLATFORM: X (Twitter), @BitcoinBay_com.
HARD LIMIT: 270 characters total (tweet text + URL combined).

TOPIC FOR THIS DRAFT:
- Topic: ${topic.topic || ''}
- Angle: ${topic.angle || ''}
- Primary keyword: ${topic.primary_keyword || ''}
- Format hint: ${topic.format_hint || 'take'}
- Voice variant: ${voiceKind.toUpperCase()}
- ${sourceLine}

${ctx.athleteCryptoPin ? `🚨 ATHLETE×CRYPTO MOAT: This is the override post. Lead with the news. Never bury the lede.` : ''}

Return STRICT JSON, exactly this shape, no markdown, no commentary:
{
  "text": "the tweet, ≤270 chars including any URL",
  "hashtags": [],
  "suggested_image_subject": "1-3 word visual subject for hero photo lookup. ALWAYS use FULL athlete names, never abbreviations (Shai Gilgeous-Alexander, not SGA). Avoid abstract verb-subjects (use 'Stephen Curry shooting' not 'Curry celebration').",
  "image_overlay_text": null,
  "image_scene_prompt": "string|null — set ONLY when a real photo of this exact moment is unlikely to exist (e.g. 'Shai Gilgeous-Alexander celebrating after a clutch shot, confetti falling, NBA arena background, photorealistic editorial photo'). Operator-triggered AI generation will use this. Leave null when image_subject + a real photo will work fine.",
  "source_url": ${topic.source_url ? `"${topic.source_url}"` : 'null'},
  "takeaway_one_liner": "internal note — what makes this post worth posting (1 sentence)"
}`;
}

function buildInstagramSinglePrompt(topic, ctx) {
  const humorBlock = (ctx.humorPass || topic.allow_humor) ? HUMOR_BLOCK : '';
  const sourceLine = topic.source_url
    ? `Source URL (mention briefly in the caption end-line): ${topic.source_url}`
    : 'No source URL — caption stands on its own.';
  const isBranded = topic.format_hint === 'branded_promo';
  return `${BB_VOICE_IG}

${COMPLIANCE}

${humorBlock}

PLATFORM: Instagram (single image), @bitcoin_bay.
CAPTION TARGET: 50-250 chars (1-3 short sentences). Hard limit 2200 but DO NOT
approach it — the live account averages 80 chars per caption. Hook in the
first 5 words.

TOPIC FOR THIS DRAFT:
- Topic: ${topic.topic || ''}
- Angle: ${topic.angle || ''}
- Primary keyword: ${topic.primary_keyword || ''}
- Format hint: ${topic.format_hint || 'athlete_card'}
- Image subject: ${topic.image_subject || '(branded — BB logo + headline)'}
- ${sourceLine}

${isBranded ? '🎨 BRANDED PROMO — this post is ABOUT Bitcoin Bay (leaderboard, bonus, register, sportsbook feature). Lead with the BB story; the image will be a BB-branded composite (logo + headline + brand palette).' : ''}

Return STRICT JSON, exactly this shape, no markdown, no commentary:
{
  "caption": "1-3 short sentences (50-250 chars). Hype-fan voice. Light commentary, not analysis. End with hashtags on a separate line.",
  "hashtags": ["5-7 lowercase IG hashtags, mix broad (#nba) + specific (#celtics), no spaces, no #"],
  "suggested_image_subject": "${topic.image_subject || 'BitcoinBay branded card'}",
  "image_overlay_text": "≤8 words for the on-image headline",
  "image_scene_prompt": "string|null — set ONLY when a real photo of this exact moment is unlikely to exist (e.g. 'Travis Kelce reacting to a Bitcoin price chart on a phone, locker room background, photorealistic editorial photo'). Operator-triggered AI generation will use this. Leave null when image_subject + a real photo will work fine.",
  "source_url": ${topic.source_url ? `"${topic.source_url}"` : 'null'}
}`;
}

function buildInstagramCarouselPrompt(topic, ctx) {
  const humorBlock = (ctx.humorPass || topic.allow_humor) ? HUMOR_BLOCK : '';
  const slidesBrief = (topic.slides || []).map((s, i) => (
    `  Slide ${i + 1} (${s.slide_role}): subject="${s.image_subject || ''}", proposed-headline="${s.headline || ''}", body-hint="${s.body_caption_hint || ''}"`
  )).join('\n');
  return `${BB_VOICE_IG}

${COMPLIANCE}

${humorBlock}

PLATFORM: Instagram CAROUSEL, @bitcoin_bay. ESPN/Bleacher Report breaking-news style.

TOPIC FOR THIS DRAFT:
- Topic: ${topic.topic || ''}
- Angle: ${topic.angle || ''}
- Primary keyword: ${topic.primary_keyword || ''}
- Slide count: ${(topic.slides || []).length}
- Source URL (mention briefly in deck caption): ${topic.source_url || '(none)'}

PROPOSED SLIDE SEQUENCE FROM PI BRIEF (reference only — feel free to
REWRITE any slide subject that drifts off-topic from the lead):
${slidesBrief}

CAROUSEL COHESION MANDATE (most important rule on this page):
The whole deck is ONE story. Every slide must expand on slide 1's specific
subject — same athlete, same game, same play, same news event. Don't
introduce a new athlete, team, league, or topic in the middle of the deck.
A reader swiping through should think: "this is all about [Slide 1's
specific story]."

If the Pi's proposed sequence mixes unrelated subjects, OVERRIDE it. Pick
the strongest single thread from slide 1 and write slides 2 through N-1
as different angles on that thread:
- the player's reaction / quote
- the play-by-play detail
- the stat that explains it
- the historical context
- the betting / line implication
- the league / opponent fallout
All anchored to the SAME story.

Slide-role guidance:
- Slide 1 (lead_photo): the hook. Reaction-tweet headline, real-photo
  subject from the lead's actual moment.
- Slides 2 to N-1: deeper looks at the SAME story. Keep image_subject in
  the same world (same athlete's face, same team's stadium, same game's
  scoreboard). NEVER cut to an unrelated player or game.
- Final slide (slide N): the ONE place a pivot is allowed. Either:
    (a) a sportsbook / BTC bankroll angle that ties the news to what
        a sharp bettor does next, OR
    (b) a soft BB CTA ("more breakdowns at bitcoinbay.com"), OR
    (c) a forward-look — what to watch in the next game.
  Even here, name the lead's athlete/team — don't go fully generic.

Slide voice (per BB_VOICE_IG above):
- Headlines: 3-10 words. Reaction-tweet flavor. Punchy.
- Body text: ≤20 words; the one specific fact that makes the headline land.
- Use first-name basis with athletes (SGA, Mahomes, Bane), not "the OKC
  Thunder's point guard."
- 1-2 emoji per slide where they earn the spot. Not every slide.

Deck-level caption:
- 100-300 chars. NOT a 1200-char essay.
- Hook → key insight → invitation to swipe.
- Same meme-leaning hype-fan voice as a tweet.

Return STRICT JSON, exactly this shape, no markdown, no commentary:
{
  "caption": "deck-level caption shown under all slides. 100-300 chars. Hype-fan voice. Hook → key-insight. Plain newlines for line breaks.",
  "hashtags": ["5-7 lowercase IG hashtags, mix broad + specific, no #"],
  "slides": [
    {
      "slide_role": "lead_photo|secondary_photo|data_card|key_quote|cta",
      "image_subject": "exact visual subject for image lookup (string). FULL athlete names, no abbreviations. STAY IN THE LEAD'S WORLD — same athlete's face / same team's stadium / same game's scoreboard / same crypto symbol as slide 1. Don't pivot to an unrelated player or game.",
      "headline": "3-10-word on-image overlay text. Reaction-tweet flavor.",
      "body_text": "≤20 words — the one specific fact that makes the headline land. Tied to the lead's story.",
      "image_scene_prompt": "string|null — set ONLY when a real photo of this slide's exact moment is unlikely. Used for operator-triggered AI scene generation per-slide. Leave null when image_subject works.",
      "source_url": "string or null"
    }
  ]
}`;
}

// ── PROMPT ROUTER ──
function buildPrompt(platform, topic, ctx) {
  if (platform === 'twitter') return buildTwitterPrompt(topic, ctx);
  if (platform === 'instagram_single') return buildInstagramSinglePrompt(topic, ctx);
  if (platform === 'instagram_carousel') return buildInstagramCarouselPrompt(topic, ctx);
  throw new Error(`unknown platform: ${platform}`);
}

// ── ANTHROPIC CALL with one retry ──
async function callClaude(prompt, opts = {}) {
  const client = getAnthropic();
  const { maxTokens = MAX_TOKENS } = opts;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = resp.content?.[0]?.text || '';
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── JSON EXTRACTOR (handles markdown fences + leading/trailing text) ──
function extractJSON(text) {
  let s = String(text || '').trim();
  // Strip markdown fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) s = fence[1].trim();
  // Find the outermost {...}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  return JSON.parse(s);
}

// ── DRAFT BUILDERS — convert Claude output + topic into a Mongo doc ──

// Parse one Twitter variant (meme or professional) into the variant subdoc shape.
function buildTwitterVariant(kind, parsed, topic) {
  return {
    variant_kind: kind,
    text: String(parsed.text || '').slice(0, 280),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 5) : [],
    image_overlay_text: parsed.image_overlay_text || null,
    image_scene_prompt: parsed.image_scene_prompt || null,
    suggested_image_subject: parsed.suggested_image_subject || topic?.image_subject || null,
    takeaway_one_liner: parsed.takeaway_one_liner || null,
    source_url: parsed.source_url || topic?.source_url || null,
  };
}

// Build a Twitter draft with a `variants` array. parsedByKind is a map
// `{ meme: parsed_obj_or_null, professional: parsed_obj_or_null }`. The first
// non-null variant becomes the active one; meme is preferred when both exist.
function buildTwitterDraft({ topic, briefDate, parsedByKind, athleteCryptoPin, humorPass }) {
  const variants = [];
  for (const kind of ['meme', 'professional']) {
    const parsed = parsedByKind?.[kind];
    if (parsed) variants.push(buildTwitterVariant(kind, parsed, topic));
  }
  if (variants.length === 0) throw new Error('buildTwitterDraft: no parsed variants');
  // active = meme if available, else the first parsed variant
  const activeIdx = 0;
  const active = variants[activeIdx];
  return {
    platform: 'twitter',
    brief_date: briefDate,
    topic: topic.topic || '',
    angle: topic.angle || '',
    format_hint: topic.format_hint || 'take',
    allow_humor: !!(topic.allow_humor || humorPass),
    // Top-level fields mirror the active variant for backward-compat with the
    // approve/PATCH/render pipeline. /swap-variant flips which variant is
    // mirrored to the top level.
    text: active.text,
    hashtags: active.hashtags,
    source_url: active.source_url,
    image_subject: active.suggested_image_subject,
    image_overlay_text: active.image_overlay_text,
    image_scene_prompt: active.image_scene_prompt,
    image_url: null,
    image_attribution: null,
    image_status: 'pending',
    takeaway_one_liner: active.takeaway_one_liner,
    athlete_crypto_pin: !!athleteCryptoPin,
    variants,
    active_variant_index: activeIdx,
    status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function buildInstagramSingleDraft({ topic, briefDate, parsed, humorPass }) {
  return {
    platform: 'instagram_single',
    brief_date: briefDate,
    topic: topic.topic || '',
    angle: topic.angle || '',
    format_hint: topic.format_hint || 'athlete_card',
    allow_humor: !!(topic.allow_humor || humorPass),
    caption: String(parsed.caption || ''),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 18) : [],
    source_url: parsed.source_url || topic.source_url || null,
    image_subject: parsed.suggested_image_subject || topic.image_subject || null,
    image_overlay_text: parsed.image_overlay_text || null,
    image_scene_prompt: parsed.image_scene_prompt || null,
    image_url: null,
    image_attribution: null,
    image_status: 'pending',
    status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function buildInstagramCarouselDraft({ topic, briefDate, parsed, humorPass }) {
  const inSlides = Array.isArray(parsed.slides) ? parsed.slides : [];
  const slides = inSlides.slice(0, 5).map((s) => ({
    slide_role: s.slide_role || 'secondary_photo',
    image_subject: s.image_subject || '',
    headline: String(s.headline || '').slice(0, 80),
    body_text: String(s.body_text || '').slice(0, 250),
    image_scene_prompt: s.image_scene_prompt || null,
    source_url: s.source_url || null,
    image_url: null,
    image_attribution: null,
    composite_url: null,
  }));
  return {
    platform: 'instagram_carousel',
    brief_date: briefDate,
    topic: topic.topic || '',
    angle: topic.angle || '',
    format_hint: 'carousel',
    allow_humor: !!(topic.allow_humor || humorPass),
    caption: String(parsed.caption || ''),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 18) : [],
    source_url: topic.source_url || null,
    slides,
    image_status: 'pending',
    status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// ── PUBLIC: runDrafter ──
async function runDrafter({ briefDate, dryRun = false } = {}) {
  // Resolve brief. If no explicit date passed, prefer "today by UTC" if it
  // exists in Mongo, otherwise fall back to the most recent brief on file.
  // Without the fallback the Pi-cron on UTC midnight day-flip OR a server
  // running just-after-midnight would error with "No brief for YYYY-MM-DD"
  // even when yesterday's brief is sitting right there ready to draft from.
  let date = briefDate;
  let brief = null;
  if (date) {
    brief = await withDb((db) => db.collection(BRIEFS_COLL).findOne({ date }));
    if (!brief) throw new Error(`No brief found in ${BRIEFS_COLL} for date=${date}`);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    brief = await withDb((db) => db.collection(BRIEFS_COLL).findOne({ date: today }));
    if (brief) {
      date = today;
    } else {
      const latest = await withDb((db) =>
        db.collection(BRIEFS_COLL).findOne({}, { sort: { date: -1 } })
      );
      if (!latest) throw new Error(`No briefs found in ${BRIEFS_COLL} at all`);
      brief = latest;
      date = latest.date;
      console.log(`[contentDrafter] today's brief (${today}) not present — falling back to latest available: ${date}`);
    }
  }

  const ppt = brief.per_platform_topics;
  if (!ppt || !Array.isArray(ppt.twitter) || !ppt.instagram) {
    throw new Error(`Brief ${date} is missing per_platform_topics — re-run bcbay_research.py`);
  }

  const forcedOverride = (brief.blog_research?.topic_category === 'Athlete Crypto');
  const drafts = [];

  // ── Twitter (3 drafts; first one pinned to athlete-crypto if override active) ──
  // Phase 6.2: each topic produces TWO variants in parallel — meme + professional.
  // Operator can swap between them via the ⇄ button without re-prompting Claude.
  for (let i = 0; i < ppt.twitter.length; i++) {
    const topic = ppt.twitter[i];
    const isPin = forcedOverride && i === 0;
    let memeRaw = null, profRaw = null;
    try {
      [memeRaw, profRaw] = await Promise.all([
        callClaude(buildPrompt('twitter', topic, { athleteCryptoPin: isPin, voiceKind: 'meme' })),
        callClaude(buildPrompt('twitter', topic, { athleteCryptoPin: isPin, voiceKind: 'professional' })),
      ]);
    } catch (e) {
      console.error(`[contentDrafter] twitter[${i}] both variant calls failed: ${e.message}`);
      continue;
    }
    let memeParsed = null, profParsed = null;
    try { if (memeRaw) memeParsed = extractJSON(memeRaw); }
    catch (e) { console.error(`[contentDrafter] twitter[${i}] meme parse failed: ${e.message}`); }
    try { if (profRaw) profParsed = extractJSON(profRaw); }
    catch (e) { console.error(`[contentDrafter] twitter[${i}] professional parse failed: ${e.message}`); }
    if (!memeParsed && !profParsed) continue;
    drafts.push(buildTwitterDraft({
      topic, briefDate: date,
      parsedByKind: { meme: memeParsed, professional: profParsed },
      athleteCryptoPin: isPin,
    }));
  }

  // ── Instagram (single OR carousel) ──
  const ig = ppt.instagram;
  const igPlatform = ig.format_hint === 'carousel' ? 'instagram_carousel' : 'instagram_single';
  const prompt = buildPrompt(igPlatform, ig, {});
  const raw = await callClaude(prompt, { maxTokens: igPlatform === 'instagram_carousel' ? 6000 : 3000 });
  try {
    const parsed = extractJSON(raw);
    if (igPlatform === 'instagram_carousel') {
      drafts.push(buildInstagramCarouselDraft({ topic: ig, briefDate: date, parsed }));
    } else {
      drafts.push(buildInstagramSingleDraft({ topic: ig, briefDate: date, parsed }));
    }
  } catch (e) {
    console.error(`[contentDrafter] instagram (${igPlatform}) JSON parse failed: ${e.message}`);
  }

  if (dryRun) {
    // In dry-run we skip both Mongo writes AND image rendering (image rendering
    // hits the network + writes JPEGs to disk). The text + structure is what
    // matters in dry-run.
    return { brief_date: date, drafts };
  }

  // ── Persist text drafts first (cheap), then attach images in a second pass ──
  // Image rendering is slower (~2-10s per draft due to remote image fetches);
  // doing it after the insert means the dashboard can render text immediately
  // and image_status flips from "pending" to "ready" as renders complete.
  const ids = await withDb(async (db) => {
    const coll = db.collection(DRAFTS_COLL);
    // Delete prior drafts for this date so reruns produce a clean batch
    await coll.deleteMany({ brief_date: date, status: 'draft' });
    const result = await coll.insertMany(drafts);
    await db.collection(ADMIN_LOG_COLL).insertOne({
      action: 'content-drafter:run',
      brief_date: date,
      drafts_count: drafts.length,
      created_at: new Date(),
    });
    return Object.values(result.insertedIds);
  });

  // Image pass — parallelize across drafts. saveDraftImages internally
  // parallelizes per-slide for carousels too, so a 4-draft batch with a
  // 5-slide carousel renders all images concurrently instead of taking
  // 30-50s sequentially. Wikimedia/Pexels both handle the burst fine.
  await Promise.all(drafts.map(async (draft, i) => {
    const _id = ids[i];
    try {
      const patch = await imageRenderer.saveDraftImages(draft, { draftId: _id.toString() });
      await withDb((db) => db.collection(DRAFTS_COLL).updateOne(
        { _id },
        { $set: { ...patch, updated_at: new Date() } }
      ));
    } catch (e) {
      console.warn(`[contentDrafter] image render failed for draft ${_id}: ${e.message}`);
      await withDb((db) => db.collection(DRAFTS_COLL).updateOne(
        { _id },
        { $set: { image_status: 'failed', image_error: e.message, updated_at: new Date() } }
      ));
    }
  }));

  return { brief_date: date, drafts_count: drafts.length, ids: ids.map((id) => id.toString()) };
}

// ── PUBLIC: regenerateDraft ──
async function regenerateDraft(draftId, opts = {}) {
  const { humorPass = false, slideIndex = null, newAngle = null } = opts;
  const _id = typeof draftId === 'string' ? new ObjectId(draftId) : draftId;
  const draft = await withDb((db) => db.collection(DRAFTS_COLL).findOne({ _id }));
  if (!draft) throw new Error(`draft ${draftId} not found`);

  const brief = await withDb((db) =>
    db.collection(BRIEFS_COLL).findOne({ date: draft.brief_date })
  );
  if (!brief) throw new Error(`brief ${draft.brief_date} not found — cannot regenerate`);

  // Re-derive the topic from the brief by index/match
  const ppt = brief.per_platform_topics || {};
  let topic;
  if (draft.platform === 'twitter') {
    topic = (ppt.twitter || []).find((t) => (t.topic || '') === (draft.topic || '')) || {};
  } else {
    topic = ppt.instagram || {};
  }
  if (newAngle) topic = { ...topic, angle: newAngle };

  // Carousel slide-only regen → only re-prompt for that slide's image_subject + headline
  if (draft.platform === 'instagram_carousel' && Number.isInteger(slideIndex)) {
    const slide = (topic.slides || [])[slideIndex];
    if (!slide) throw new Error(`slide ${slideIndex} not in brief`);
    const slidePrompt = `${BB_VOICE_IG}\n${COMPLIANCE}\n\nRewrite ONE carousel slide for the deck topic:
"${draft.topic}". Slide role: ${slide.slide_role}. Subject hint: ${slide.image_subject}.
Return STRICT JSON: {"image_subject": "FULL athlete name, no abbreviations", "headline": "≤8 words", "body_text": "≤20 words", "image_scene_prompt": "string|null — set ONLY when a real photo of this moment is unlikely; used for operator-triggered AI generation"}`;
    const raw = await callClaude(slidePrompt, { maxTokens: 700 });
    const parsed = extractJSON(raw);
    const newSlides = [...(draft.slides || [])];
    newSlides[slideIndex] = {
      ...newSlides[slideIndex],
      image_subject: parsed.image_subject || newSlides[slideIndex]?.image_subject || '',
      headline: String(parsed.headline || '').slice(0, 80),
      body_text: String(parsed.body_text || '').slice(0, 250),
      image_scene_prompt: parsed.image_scene_prompt ?? newSlides[slideIndex]?.image_scene_prompt ?? null,
      image_url: null, // force re-render
      composite_url: null,
    };
    await withDb((db) => db.collection(DRAFTS_COLL).updateOne(
      { _id },
      { $set: { slides: newSlides, updated_at: new Date() } }
    ));
    return { ok: true, slide: newSlides[slideIndex] };
  }

  // Full-card regen
  const platform = draft.platform;

  // Twitter draft with variants[] → regenerate ONLY the active variant.
  // The other variant stays untouched so swap still works without a re-call.
  if (platform === 'twitter' && Array.isArray(draft.variants) && draft.variants.length > 0) {
    const activeIdx = Number.isInteger(draft.active_variant_index) ? draft.active_variant_index : 0;
    const activeKind = draft.variants[activeIdx]?.variant_kind === 'professional'
      ? 'professional' : 'meme';
    const prompt = buildPrompt('twitter', topic, {
      athleteCryptoPin: !!draft.athlete_crypto_pin,
      humorPass,
      voiceKind: activeKind,
    });
    const raw = await callClaude(prompt, { maxTokens: 3000 });
    const parsed = extractJSON(raw);
    const newVariant = buildTwitterVariant(activeKind, parsed, topic);
    const newVariants = [...draft.variants];
    newVariants[activeIdx] = newVariant;
    await withDb((db) => db.collection(DRAFTS_COLL).updateOne(
      { _id },
      { $set: {
        variants: newVariants,
        // Mirror to top-level (since this is the active variant)
        text: newVariant.text,
        hashtags: newVariant.hashtags,
        image_overlay_text: newVariant.image_overlay_text,
        image_scene_prompt: newVariant.image_scene_prompt,
        takeaway_one_liner: newVariant.takeaway_one_liner,
        // image_subject stays — keeps the existing image stable across regens.
        // Operator can change it via PATCH if they want a different photo.
        updated_at: new Date(),
      }}
    ));
    return { ok: true, draft_id: draftId, variant_kind: activeKind };
  }

  // Legacy / IG path — single-prompt regen, full draft replacement
  const prompt = buildPrompt(platform, topic, {
    athleteCryptoPin: !!draft.athlete_crypto_pin,
    humorPass,
  });
  const raw = await callClaude(prompt, {
    maxTokens: platform === 'instagram_carousel' ? 6000 : 3000,
  });
  const parsed = extractJSON(raw);

  let next;
  if (platform === 'twitter') {
    // Legacy single-variant Twitter draft (no variants[]). Treat the regen as
    // a fresh meme variant.
    next = buildTwitterDraft({
      topic, briefDate: draft.brief_date,
      parsedByKind: { meme: parsed },
      athleteCryptoPin: !!draft.athlete_crypto_pin, humorPass,
    });
  } else if (platform === 'instagram_single') {
    next = buildInstagramSingleDraft({ topic, briefDate: draft.brief_date, parsed, humorPass });
  } else {
    next = buildInstagramCarouselDraft({ topic, briefDate: draft.brief_date, parsed, humorPass });
  }
  // Preserve _id, created_at, status
  delete next.created_at;
  await withDb((db) => db.collection(DRAFTS_COLL).updateOne(
    { _id },
    { $set: next }
  ));
  return { ok: true, draft_id: draftId };
}

// ── PUBLIC: draftFromGameState (Phase 8) ──────────────────────────────────
// One-shot Twitter draft seeded from a live ESPN game state. Operator
// triggers via the dashboard's "Today's games" panel → "✍️ Draft tweet"
// button. Generates 2 variants (meme + professional) like the normal
// drafter, persists into bcb_post_drafts with source='live_game' so the
// operator can spot-edit and approve.
async function draftFromGameState({ gameState, eventId, leaguePath }) {
  const date = new Date().toISOString().slice(0, 10);
  // Build a topic dict that fits the existing buildTwitterPrompt contract.
  // The "topic" + "angle" carry the game context so Claude has enough to
  // react to without us forking the prompt builder.
  const score = gameState.away?.score != null && gameState.home?.score != null
    ? `${gameState.away?.abbr} ${gameState.away.score} – ${gameState.home?.abbr} ${gameState.home.score}`
    : `${gameState.away?.abbr} @ ${gameState.home?.abbr}`;
  const lastPlays = (gameState.plays || []).slice(-3)
    .map((p) => `Q${p.period} ${p.clock || ''}: ${p.text}`).join(' || ');
  const wp = gameState.win_probability;
  const wpStr = wp ? ` win-prob ${gameState.away?.abbr} ${wp.away_pct}% / ${gameState.home?.abbr} ${wp.home_pct}%.` : '';
  const topic = {
    topic: `${gameState.away?.name || ''} vs ${gameState.home?.name || ''} — live (${gameState.status || ''})`,
    angle: `Live game state: ${score}. Status: ${gameState.status || 'unknown'}.${wpStr} Last plays: ${lastPlays || '(none yet)'}`,
    primary_keyword: gameState.away?.abbr || '',
    format_hint: 'live_reaction',
    source_url: `https://www.espn.com/${leaguePath}/game/_/gameId/${eventId}`,
    image_subject: gameState.home?.name || gameState.away?.name || '',
    allow_humor: true,  // live reactions skew funny; humor block kicks in
  };
  const ctx = { athleteCryptoPin: false, humorPass: false };

  let memeRaw = null, profRaw = null;
  try {
    [memeRaw, profRaw] = await Promise.all([
      callClaude(buildPrompt('twitter', topic, { ...ctx, voiceKind: 'meme' })),
      callClaude(buildPrompt('twitter', topic, { ...ctx, voiceKind: 'professional' })),
    ]);
  } catch (e) {
    throw new Error(`live-game drafter Claude call failed: ${e.message}`);
  }
  let memeParsed = null, profParsed = null;
  try { if (memeRaw) memeParsed = extractJSON(memeRaw); } catch (_) {}
  try { if (profRaw) profParsed = extractJSON(profRaw); } catch (_) {}
  if (!memeParsed && !profParsed) throw new Error('both variants failed to parse');

  const draft = buildTwitterDraft({
    topic, briefDate: date,
    parsedByKind: { meme: memeParsed, professional: profParsed },
    athleteCryptoPin: false,
  });
  // Tag the draft so it's distinguishable from the morning batch
  draft.source = 'live_game';
  draft.live_game_event_id = eventId;
  draft.live_game_league_path = leaguePath;

  const insertedId = await withDb(async (db) => {
    const result = await db.collection(DRAFTS_COLL).insertOne(draft);
    await db.collection(ADMIN_LOG_COLL).insertOne({
      action: 'content-drafter:draft-from-game',
      brief_date: date,
      event_id: eventId,
      league_path: leaguePath,
      draft_id: result.insertedId,
      created_at: new Date(),
    });
    return result.insertedId;
  });

  return { draft_id: insertedId.toString(), variants_count: draft.variants.length };
}


module.exports = {
  runDrafter, regenerateDraft, draftFromGameState, COMPLIANCE,
  BB_VOICE_BASE, BB_VOICE_TWITTER_MEME, BB_VOICE_TWITTER_PROFESSIONAL, BB_VOICE_IG,
  // Backward-compat alias (== BB_VOICE_IG)
  BB_VOICE,
};

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dateIdx = args.indexOf('--date');
  const briefDate = dateIdx >= 0 ? args[dateIdx + 1] : undefined;
  (async () => {
    const out = await runDrafter({ briefDate, dryRun });
    if (dryRun) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`drafted ${out.drafts_count} for ${out.brief_date}: ${out.ids.join(', ')}`);
    }
  })().catch((e) => {
    console.error('contentDrafter failed:', e.message);
    process.exit(1);
  });
}
