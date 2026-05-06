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

// ── BB VOICE BLOCK ──
// Anchored on the persona blocks the operator already trusts in the Pi
// engagement scripts. The constants in those scripts (Pi: VOICE_BRIEF for X,
// the inline brand-voice paragraph at the top of gemini_draft_comment for IG)
// are the source of truth. Mirror them here so the post drafter sounds the
// way the operator already approves replies.
const BB_VOICE = `
You are drafting an ORIGINAL post for Bitcoin Bay (@BitcoinBay_com on X,
@bitcoin_bay on Instagram). Bitcoin Bay is a bitcoin-native sports-betting
platform and casino. Audience: people who love sports AND love crypto.

VOICE (mirror what the operator already approves on engagement-side replies):
- Sharp handicapper at the beach bar with a hardware wallet in their pocket.
- Authoritative on sports AND crypto. Sports-fluent, bitcoin-native.
  Confident, data-driven when data exists, takes-driven otherwise.
- Beach-coded but never silly. Relaxed delivery, never corporate, never shilly.
- "Fun sportsbook social" energy similar to DraftKings/FanDuel/ESPN BET on
  socials — punchy, talky, occasionally funny — MINUS their predatory promo
  voice and their tout-speak. Channel the energy, not the regulatory shape.
- Adds real value: data, insight, historical context, or genuine wit.
  One punchy idea per post.
- Journalism first, product plug last. Talk about the topic, not about us.

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
  on its own. Source URLs are fine when citing news; the operator's profile
  is the only CTA.
- Spam emoji. One or two emoji per post is fine if the topic earns them. Stop
  if you're using more than one. ZERO emoji is the safe default for X.
`.trim();

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
  const humorBlock = (ctx.humorPass || topic.allow_humor) ? HUMOR_BLOCK : '';
  const sourceLine = topic.source_url
    ? `Cite the source URL at the end of the tweet (X auto-renders it as a card). URL: ${topic.source_url}`
    : 'No source URL — make the take stand on its own.';
  return `${BB_VOICE}

${COMPLIANCE}

${humorBlock}

PLATFORM: X (Twitter), @BitcoinBay_com.
HARD LIMIT: 270 characters total (tweet text + URL combined). Hashtags optional.

TOPIC FOR THIS DRAFT:
- Topic: ${topic.topic || ''}
- Angle: ${topic.angle || ''}
- Primary keyword: ${topic.primary_keyword || ''}
- Format hint: ${topic.format_hint || 'take'}
- ${sourceLine}

${ctx.athleteCryptoPin ? `🚨 ATHLETE×CRYPTO MOAT: This is the override post. Lead with the news. Tag @BitcoinBay_com if natural. Never bury the lede.` : ''}

Return STRICT JSON, exactly this shape, no markdown, no commentary:
{
  "text": "the tweet, ≤270 chars including any URL",
  "hashtags": ["0-3 lowercase hashtags or empty array — be sparing"],
  "suggested_image_subject": "1-3 word visual subject for hero photo lookup",
  "image_overlay_text": null,
  "source_url": ${topic.source_url ? `"${topic.source_url}"` : 'null'},
  "takeaway_one_liner": "internal note — what makes this post worth posting (1 sentence)"
}`;
}

function buildInstagramSinglePrompt(topic, ctx) {
  const humorBlock = (ctx.humorPass || topic.allow_humor) ? HUMOR_BLOCK : '';
  const sourceLine = topic.source_url
    ? `Source URL (link in caption end-line, since IG can't auto-link): ${topic.source_url}`
    : 'No source URL — caption stands on its own.';
  const isBranded = topic.format_hint === 'branded_promo';
  return `${BB_VOICE}

${COMPLIANCE}

${humorBlock}

PLATFORM: Instagram (single image), @bitcoin_bay.
CAPTION LIMIT: 2200 chars (target 600-1100 — IG users skim the first 2 lines).

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
  "caption": "2-4 short paragraphs separated by blank lines. Hook in the first line. End with the @bitcoin_bay handle on its own line if it adds.",
  "hashtags": ["10-15 lowercase IG hashtags, mix broad + niche, no spaces, no #"],
  "suggested_image_subject": "${topic.image_subject || 'BitcoinBay branded card'}",
  "image_overlay_text": "≤8 words for the on-image headline",
  "source_url": ${topic.source_url ? `"${topic.source_url}"` : 'null'}
}`;
}

function buildInstagramCarouselPrompt(topic, ctx) {
  const humorBlock = (ctx.humorPass || topic.allow_humor) ? HUMOR_BLOCK : '';
  const slidesBrief = (topic.slides || []).map((s, i) => (
    `  Slide ${i + 1} (${s.slide_role}): subject="${s.image_subject || ''}", proposed-headline="${s.headline || ''}", body-hint="${s.body_caption_hint || ''}"`
  )).join('\n');
  return `${BB_VOICE}

${COMPLIANCE}

${humorBlock}

PLATFORM: Instagram CAROUSEL, @bitcoin_bay. ESPN/Bleacher Report breaking-news style.

TOPIC FOR THIS DRAFT:
- Topic: ${topic.topic || ''}
- Angle: ${topic.angle || ''}
- Primary keyword: ${topic.primary_keyword || ''}
- Slide count: ${(topic.slides || []).length}
- Source URL (cite in caption end-line): ${topic.source_url || '(none)'}

PROPOSED SLIDE SEQUENCE (improve where you see fit, but keep slide_role + image_subject):
${slidesBrief}

CAROUSEL RULES:
- Slide 1 (lead_photo) hooks the eye — strong headline, real-photo subject.
- Story flows slide-by-slide. Each slide stands alone if someone stops swiping.
- Final slide is usually the CTA (cta role) — soft pointer to bitcoinbay.com or
  a related blog post; never an aggressive sign-up push.
- The overall caption (under-deck) tells the story end-to-end so even
  non-swipers get it.
- Each slide's headline ≤8 words; each slide's body_text ≤30 words.

Return STRICT JSON, exactly this shape, no markdown, no commentary:
{
  "caption": "deck-level caption shown under all slides. 600-1200 chars. Hook → context → key-insight → soft-CTA. Plain newlines for line breaks.",
  "hashtags": ["10-15 lowercase IG hashtags, no #"],
  "slides": [
    {
      "slide_role": "lead_photo|secondary_photo|data_card|key_quote|cta",
      "image_subject": "exact visual subject for image lookup (string)",
      "headline": "≤8-word on-image overlay text",
      "body_text": "≤30 words — the alt-text/storytelling layer (not on the image, used for accessibility and dev preview)",
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
function buildTwitterDraft({ topic, briefDate, parsed, athleteCryptoPin, humorPass }) {
  return {
    platform: 'twitter',
    brief_date: briefDate,
    topic: topic.topic || '',
    angle: topic.angle || '',
    format_hint: topic.format_hint || 'take',
    allow_humor: !!(topic.allow_humor || humorPass),
    text: String(parsed.text || '').slice(0, 280),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 5) : [],
    source_url: parsed.source_url || topic.source_url || null,
    image_subject: parsed.suggested_image_subject || topic.image_subject || null,
    image_overlay_text: parsed.image_overlay_text || null,
    image_url: null,
    image_attribution: null,
    image_status: 'pending',
    takeaway_one_liner: parsed.takeaway_one_liner || null,
    athlete_crypto_pin: !!athleteCryptoPin,
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
  // Resolve brief
  const date = briefDate || new Date().toISOString().slice(0, 10);
  const brief = await withDb((db) => db.collection(BRIEFS_COLL).findOne({ date }));
  if (!brief) throw new Error(`No brief found in ${BRIEFS_COLL} for date=${date}`);

  const ppt = brief.per_platform_topics;
  if (!ppt || !Array.isArray(ppt.twitter) || !ppt.instagram) {
    throw new Error(`Brief ${date} is missing per_platform_topics — re-run bcbay_research.py`);
  }

  const forcedOverride = (brief.blog_research?.topic_category === 'Athlete Crypto');
  const drafts = [];

  // ── Twitter (3 drafts; first one pinned to athlete-crypto if override active) ──
  for (let i = 0; i < ppt.twitter.length; i++) {
    const topic = ppt.twitter[i];
    const isPin = forcedOverride && i === 0;
    const prompt = buildPrompt('twitter', topic, { athleteCryptoPin: isPin });
    const raw = await callClaude(prompt);
    let parsed;
    try { parsed = extractJSON(raw); }
    catch (e) {
      console.error(`[contentDrafter] twitter[${i}] JSON parse failed: ${e.message}`);
      continue;
    }
    drafts.push(buildTwitterDraft({ topic, briefDate: date, parsed, athleteCryptoPin: isPin }));
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

  if (dryRun) return { brief_date: date, drafts };

  // ── Persist ──
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
    return Object.values(result.insertedIds).map((id) => id.toString());
  });
  return { brief_date: date, drafts_count: drafts.length, ids };
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
    const slidePrompt = `${BB_VOICE}\n${COMPLIANCE}\n\nRewrite ONE carousel slide for the deck topic:
"${draft.topic}". Slide role: ${slide.slide_role}. Subject hint: ${slide.image_subject}.
Return STRICT JSON: {"image_subject": "...", "headline": "≤8 words", "body_text": "≤30 words"}`;
    const raw = await callClaude(slidePrompt, { maxTokens: 600 });
    const parsed = extractJSON(raw);
    const newSlides = [...(draft.slides || [])];
    newSlides[slideIndex] = {
      ...newSlides[slideIndex],
      image_subject: parsed.image_subject || newSlides[slideIndex]?.image_subject || '',
      headline: String(parsed.headline || '').slice(0, 80),
      body_text: String(parsed.body_text || '').slice(0, 250),
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
    next = buildTwitterDraft({ topic, briefDate: draft.brief_date, parsed,
      athleteCryptoPin: !!draft.athlete_crypto_pin, humorPass });
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

module.exports = { runDrafter, regenerateDraft, BB_VOICE, COMPLIANCE };

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
