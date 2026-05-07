// ---------------------------------------------------------------------------
// imageRenderer.js — pulls real editorial photos for post drafts and
// composes BB-branded SVG cards for promo content.
//
// Strategy (cascade, in priority order):
//   1. Wikimedia Commons  — CC/PD athletes, teams, stadiums, leagues, crypto
//      (port of ~/bcbay/bcbay_blog.py:fetch_wikimedia_image — same scoring
//      logic, same subject-name guard, same good/bad keyword lists)
//   2. Pexels API         — broader sports/lifestyle/abstract editorial,
//      free for commercial use, attribution rendered into IG captions
//   3. (future) Unsplash  — placeholder; activates if UNSPLASH_ACCESS_KEY set
//   4. Manual paste       — handled in the dashboard, not here
//   5. Branded composite  — for format_hint='branded_promo' OR a BB-named
//      image_subject ("Bitcoin Bay logo", "BB sportsbook"). Routed via
//      isBBSubject() before the real-photo cascade ever runs. (BB logo +
//      headline + brand-palette gradient via sharp.)
//   6. (opt-in) Replicate InstantID — operator-only via the dashboard 🎨
//      "Generate scene" button. Real-person AI: takes a Wikimedia photo of
//      the athlete + a scene prompt, generates the athlete in the new scene
//      with their actual face. ~$0.05/image, audit-logged.
//
// All non-branded images carry an `attribution` string that the IG caption
// renders as "Photo: {credit} / {license}". X drops it (280 char limit).
// NO watermarks on regular overlay cards — they hurt social-media reach. Only
// branded composites carry BB branding; real-photo overlays stay clean.
//
// Generated images for IG publish are saved to:
//   public/post-images/{date}/{draft_id}[/{slide_index}].jpg
// served by express.static('public') so the IG Graph API can pull them.
//
// Public exports:
//   findHeroImage(subject, { intent? })          // auto-infers intent
//   findCarouselImages(slides)                   // distinct subjects per slide
//   composeBrandedCard({ headline, subhead?, kind, outPath })
//   composeOverlayCard({ imageUrl, headline, badgeKind?, outPath })
//   saveDraftImages(draft, { dateDir, draftId }) // full pipeline for one draft
//   generateAIScene({ scenePrompt, referenceImageUrl, outPath, width?, height? })
//   inferIntent / isBBSubject / inferBrandedKind / pexelsOffTopic   // helpers
//   BB_PALETTE                                   // brand color const
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
// Use native fetch (Node 18+). The `node-fetch` v3 dep is ESM-only and would
// require dynamic import; native fetch is identical for our needs.
const TIMEOUT = (ms) => AbortSignal.timeout(ms);

// ── BB BRAND PALETTE — extracted from index.html :root ──
const BB_PALETTE = {
  gold:        '#F7941D',
  goldLight:   '#FDCB6E',
  goldDark:    '#D47812',
  orange:      '#F26522',
  bgDark:      '#0A1628',
  bgCard:      '#0D2240',
  bgSurface:   '#163060',
  accentBlue:  '#56CCF2',
  accentGreen: '#22C55E',
  textPrimary: '#FFFFFF',
  textSecondary: '#B0C4DE',
  textMuted:   '#6B8DB5',
};

const PUBLIC_DIR = path.join(__dirname, 'public', 'post-images');
const LOGO_PATH = path.join(__dirname, 'bb-logo.png');
const WIKIMEDIA_USER_AGENT = 'BitcoinBay-ContentDrafter/1.0 (https://bitcoinbay.com; ops@bitcoinbay.com)';
const WIKIMEDIA_MIN_SCORE = 3;

// ── WIKIMEDIA SCORING KEYWORDS (port from bcbay_blog.py) ──
const WIKI_GOOD_KEYWORDS = [
  'portrait','headshot','press','official','official photo',
  'pose','posing','closeup','close-up','close up',
  'nba','nfl','mlb','nhl','mls','ufc','fifa',
  'basketball','football','baseball','hockey','soccer',
  'stadium','arena','court','pitch','field',
  'photograph','photo of','profile','individual',
  'ceo','president','founder','director','senator',
  'keynote','conference','speech','speaking',
];
const WIKI_BAD_KEYWORDS = [
  'party','drinking','beer','wine','drunk','beach party',
  'group','crowd','fans','audience','spectators','selfie',
  'event','event photo','gala',
  'family','wife','husband','kids','children','baby',
  'funeral','memorial','hospital','injured',
  'meme','parody','cartoon','illustration','drawing','fan art',
  'protest','riot','arrest','mugshot','courtroom',
  'costume','halloween','cosplay',
  'monument','statue','plaque','gravestone',
  'graffiti','street art','mural',
  'map','flag','coat of arms','logo',
  'bird','animal','insect','flower','plant','landscape','starling',
  'butterfly','fish','wildlife','nature','sunset','sunrise',
];

// ── HELPERS ──
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

// ── SUBJECT INFERENCE / ROUTING HELPERS ──
//
// Three concerns handled here:
//   1) Detect when a subject is about Bitcoin Bay itself (CTA / promo / logo) —
//      route those to composeBrandedCard, never to the real-photo cascade. Was
//      the source of the May-6 "Bitcoin Bay logo → random Pexels wood-sticker"
//      miss when this routing didn't exist.
//   2) Infer the right `intent` from the subject string so findHeroImage can
//      pick the right source order (athletes → Wikimedia first; abstract topics
//      → Unsplash/Pexels first). Was the source of the May-6 "always
//      sport_action" deprioritization of Wikimedia for athlete subjects.
//   3) Off-topic deny-list for Pexels matches when intent is sport-flavored —
//      reject "birthday party", "wedding", etc. that Pexels happily returns
//      for queries like "celebration" when subject is an athlete.
const BB_TOKENS = /\b(bitcoin\s*bay|bitcoinbay|bb\s+logo|bb\s+sportsbook)\b/i;
const TEAM_TOKENS = /\b(lakers|warriors|celtics|knicks|bulls|heat|bucks|nets|cowboys|patriots|chiefs|ravens|eagles|49ers|packers|yankees|dodgers|red\s+sox|cubs|mets|braves|rangers|bruins|leafs|canadiens|maple\s+leafs|oilers|flames)\b/i;
const STADIUM_TOKENS = /\b(stadium|arena|court|field|park|dome|garden|coliseum)\b/i;
const CRYPTO_TOKENS = /\b(btc|bitcoin|eth|ethereum|sol|solana|crypto|blockchain|wallet|hardware\s+wallet|hodl|halving)\b/i;
const FINANCE_TOKENS = /\b(market|chart|price|index|rally|dip|pump|dump|liquidation|orderbook|volume)\b/i;

function isBBSubject(subject) {
  return BB_TOKENS.test(String(subject || ''));
}

function inferBrandedKind(draft) {
  const s = `${draft?.topic || ''} ${draft?.angle || ''} ${draft?.image_subject || ''}`.toLowerCase();
  if (/\b(leaderboard|weekly winners|top 10)\b/.test(s)) return 'leaderboard_cta';
  if (/\b(register|sign up|sign-up|create account)\b/.test(s)) return 'register_cta';
  if (/\b(bonus|deposit match|promo)\b/.test(s)) return 'bonus_cta';
  return 'promo';
}

function inferIntent(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'sport_action';
  // Order matters. Stadium/team checks BEFORE crypto/finance so subjects
  // like "Crypto.com Arena" (an actual NBA stadium) and "Madison Square
  // Garden" route to 'stadium' rather than 'crypto'/'abstract_finance'.
  // Athlete pattern is checked last so "Bitcoin Halving" (capitalized
  // 2-word phrase that matches crypto vocabulary) doesn't get mistaken
  // for an athlete name.
  if (STADIUM_TOKENS.test(s)) return 'stadium';
  if (TEAM_TOKENS.test(s)) return 'team';
  if (CRYPTO_TOKENS.test(s)) return 'crypto';
  if (FINANCE_TOKENS.test(s)) return 'abstract_finance';
  // Capitalized full name: 2-4 words, each starts with uppercase letter.
  // Allows hyphens/apostrophes (Shai Gilgeous-Alexander, D'Andre Swift).
  const words = s.split(/\s+/);
  if (words.length >= 2 && words.length <= 4 &&
      words.every((w) => /^[A-Z][a-zA-Z'\-]+$/.test(w))) {
    return 'athlete';
  }
  return 'sport_action';
}

const SPORT_INTENTS = new Set(['sport_action', 'athlete', 'team', 'stadium']);
const PEXELS_OFF_TOPIC_SPORT = [
  'party','birthday','wedding','baby','gala','christmas','holiday','easter',
  'family portrait','children','toddler','kids','beach party','drinking',
  'drunk','halloween','costume','funeral','memorial','candles','balloon',
];
function pexelsOffTopic(photo, intent) {
  if (!SPORT_INTENTS.has(intent)) return false;
  const hay = `${photo.alt || ''} ${photo.url || ''}`.toLowerCase();
  return PEXELS_OFF_TOPIC_SPORT.some((bad) => hay.includes(bad));
}

// ── WIKIMEDIA SEARCH ──
function scoreWikimediaResult(result, subject) {
  const haystack = [result.title, result.description, result.object_name].join(' ').toLowerCase();
  const subjectWords = (String(subject || '').match(/[A-Za-z]+/g) || [])
    .filter((w) => w.length >= 3)
    .map((w) => w.toLowerCase());
  if (subjectWords.length === 0) return -999;
  const nameHits = subjectWords.filter((w) => haystack.includes(w)).length;
  if (nameHits === 0) return -999;
  if (subjectWords.length >= 2 && nameHits < 2) return -999;
  let score = nameHits;
  for (const kw of WIKI_GOOD_KEYWORDS) if (haystack.includes(kw)) score += 1;
  for (const kw of WIKI_BAD_KEYWORDS) if (haystack.includes(kw)) score -= 2;
  const w = result.width || 0, h = result.height || 0;
  if (w && h) {
    if (w >= h) score += 1;
    if (w >= 1200 && h >= 800) score += 1;
  }
  return score;
}

async function wikimediaSearch(subject, { limit = 15 } = {}) {
  if (!subject) return [];
  try {
    const searchUrl = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
      action: 'query', format: 'json', list: 'search',
      srsearch: subject, srnamespace: '6', srlimit: String(limit),
    }).toString();
    const res = await fetch(searchUrl, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT }, signal: TIMEOUT(15000) });
    const data = await res.json();
    const hits = data?.query?.search || [];
    if (!hits.length) return [];

    const titles = hits.map((h) => h.title).join('|');
    const infoUrl = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
      action: 'query', format: 'json', titles,
      prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '1600',
    }).toString();
    const res2 = await fetch(infoUrl, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT }, signal: TIMEOUT(15000) });
    const info = await res2.json();
    const pages = info?.query?.pages || {};

    const results = [];
    for (const page of Object.values(pages)) {
      const ii = (page.imageinfo || [])[0] || {};
      if (!['image/jpeg', 'image/png'].includes(ii.mime)) continue;
      const width = ii.width || 0, height = ii.height || 0;
      if (width < 800 || height < 450) continue;
      if (height > width * 1.5) continue; // skip wildly vertical
      const ext = ii.extmetadata || {};
      const license = (ext.LicenseShortName || {}).value || '';
      const llower = license.toLowerCase();
      if (['fair use', 'non-free', 'copyright'].some((bad) => llower.includes(bad))) continue;
      const artist = stripHtml((ext.Artist || {}).value || '');
      const description = stripHtml((ext.ImageDescription || {}).value || '');
      const objectName = stripHtml((ext.ObjectName || {}).value || '');
      const r = {
        title: page.title || '',
        url: ii.thumburl || ii.url || '',
        width, height, license, artist, description, object_name: objectName,
        descriptionurl: ii.descriptionurl || '',
      };
      r.score = scoreWikimediaResult(r, subject);
      results.push(r);
    }
    return results.filter((r) => r.score > -999).sort((a, b) => b.score - a.score);
  } catch (e) {
    console.warn(`[imageRenderer] wikimedia search failed for "${subject}": ${e.message}`);
    return [];
  }
}

async function findWikimediaImage(subject) {
  if (!subject) return null;
  let results = await wikimediaSearch(subject);
  if (!results.length) {
    const words = String(subject).split(/\s+/).slice(0, 2).join(' ');
    if (words && words !== subject) {
      results = await wikimediaSearch(words);
    }
  }
  if (!results.length) return null;
  const best = results[0];
  if (best.score < WIKIMEDIA_MIN_SCORE) return null;
  const credit = best.artist ? `Photo: ${best.artist}` : 'Photo: Wikimedia Commons';
  return {
    url: best.url,
    source: 'wikimedia',
    attribution: best.license ? `${credit} / ${best.license}` : credit,
    license: best.license,
    descriptionurl: best.descriptionurl,
  };
}

// ── PEXELS SEARCH ──
// `intent` is threaded in so we can reject obviously off-topic matches when the
// subject is sport-flavored (Pexels happily returns birthday-party photos for
// queries like "celebration"). Without an intent guard, "SGA celebration" once
// returned a literal birthday party with balloons.
async function findPexelsImage(subject, intent = 'sport_action') {
  if (!subject) return null;
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const url = 'https://api.pexels.com/v1/search?' + new URLSearchParams({
      query: subject, orientation: 'landscape', size: 'large', per_page: '10',
    }).toString();
    const res = await fetch(url, {
      headers: { Authorization: key },
      signal: TIMEOUT(12000),
    });
    if (!res.ok) {
      console.warn(`[imageRenderer] pexels HTTP ${res.status} for "${subject}"`);
      return null;
    }
    const data = await res.json();
    const photos = data.photos || [];
    for (const photo of photos) {
      if (pexelsOffTopic(photo, intent)) {
        console.log(`[imageRenderer] pexels rejected off-topic match for "${subject}" (intent=${intent}, alt="${photo.alt}")`);
        continue;
      }
      return {
        url: photo.src?.large2x || photo.src?.large || photo.src?.original,
        source: 'pexels',
        attribution: `Photo: ${photo.photographer} on Pexels`,
        license: 'Pexels License',
        descriptionurl: photo.url,
      };
    }
    return null;
  } catch (e) {
    console.warn(`[imageRenderer] pexels search failed for "${subject}": ${e.message}`);
    return null;
  }
}

// ── UNSPLASH (placeholder; active if UNSPLASH_ACCESS_KEY set) ──
async function findUnsplashImage(subject) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key || !subject) return null;
  try {
    const url = 'https://api.unsplash.com/search/photos?' + new URLSearchParams({
      query: subject, orientation: 'landscape', per_page: '5', content_filter: 'high',
    }).toString();
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}` },
      signal: TIMEOUT(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const photo = (data.results || [])[0];
    if (!photo) return null;
    return {
      url: photo.urls?.regular || photo.urls?.full,
      source: 'unsplash',
      attribution: `Photo: ${photo.user?.name} on Unsplash`,
      license: 'Unsplash License',
      descriptionurl: photo.links?.html,
    };
  } catch (e) {
    console.warn(`[imageRenderer] unsplash failed for "${subject}": ${e.message}`);
    return null;
  }
}

// ── CANDIDATE SEARCH (Phase 9.2 — replace-photo UI) ──
// Returns up to `limit` candidates per source as a flat array. Each candidate
// has the same shape as the cascade results (`{source,url,attribution,...}`)
// plus a `thumb_url` for the picker grid. Used by /api/admin/dashboard/photo-search.
async function searchWikimediaCandidates(subject, limit = 3) {
  if (!subject) return [];
  const results = await wikimediaSearch(subject, { limit: Math.max(limit, 8) });
  return results.slice(0, limit).map((r) => {
    const credit = r.artist ? `Photo: ${r.artist}` : 'Photo: Wikimedia Commons';
    return {
      source: 'wikimedia',
      url: r.url,
      thumb_url: r.url,
      attribution: r.license ? `${credit} / ${r.license}` : credit,
      license: r.license,
      descriptionurl: r.descriptionurl,
      title: r.title,
    };
  });
}

async function searchPexelsCandidates(subject, intent = 'sport_action', limit = 3) {
  if (!subject) return [];
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  try {
    const url = 'https://api.pexels.com/v1/search?' + new URLSearchParams({
      query: subject, orientation: 'landscape', size: 'large', per_page: '15',
    }).toString();
    const res = await fetch(url, { headers: { Authorization: key }, signal: TIMEOUT(12000) });
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    for (const photo of (data.photos || [])) {
      if (pexelsOffTopic(photo, intent)) continue;
      out.push({
        source: 'pexels',
        url: photo.src?.large2x || photo.src?.large || photo.src?.original,
        thumb_url: photo.src?.medium || photo.src?.small || photo.src?.tiny,
        attribution: `Photo: ${photo.photographer} on Pexels`,
        license: 'Pexels License',
        descriptionurl: photo.url,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    console.warn(`[imageRenderer] pexels candidates failed for "${subject}": ${e.message}`);
    return [];
  }
}

async function searchUnsplashCandidates(subject, limit = 3) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key || !subject) return [];
  try {
    const url = 'https://api.unsplash.com/search/photos?' + new URLSearchParams({
      query: subject, orientation: 'landscape', per_page: String(Math.max(limit, 5)), content_filter: 'high',
    }).toString();
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}` }, signal: TIMEOUT(12000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0, limit).map((photo) => ({
      source: 'unsplash',
      url: photo.urls?.regular || photo.urls?.full,
      thumb_url: photo.urls?.small || photo.urls?.thumb,
      attribution: `Photo: ${photo.user?.name} on Unsplash`,
      license: 'Unsplash License',
      descriptionurl: photo.links?.html,
    }));
  } catch (e) {
    console.warn(`[imageRenderer] unsplash candidates failed for "${subject}": ${e.message}`);
    return [];
  }
}

async function searchPhotoCandidates(subject, { intent, perSource = 3 } = {}) {
  if (!subject) return { wikimedia: [], pexels: [], unsplash: [] };
  const inferredIntent = intent || inferIntent(subject) || 'sport_action';
  const [wikimedia, pexels, unsplash] = await Promise.all([
    searchWikimediaCandidates(subject, perSource),
    searchPexelsCandidates(subject, inferredIntent, perSource),
    searchUnsplashCandidates(subject, perSource),
  ]);
  return { wikimedia, pexels, unsplash };
}

// ── HERO CASCADE ──
async function findHeroImage(subject, opts = {}) {
  if (!subject) return null;
  // Auto-infer intent from the subject text unless caller forced one. This is
  // the fix for the "saveDraftImages always passed sport_action" bug — athlete
  // subjects now correctly route Wikimedia first.
  const intent = opts.intent || inferIntent(subject);
  const isPersonOrPlace = ['athlete', 'team', 'stadium', 'league'].includes(intent);
  const sources = isPersonOrPlace
    ? [
        () => findWikimediaImage(subject),
        () => findUnsplashImage(subject),
        () => findPexelsImage(subject, intent),
      ]
    : [
        () => findUnsplashImage(subject),
        () => findPexelsImage(subject, intent),
        () => findWikimediaImage(subject),
      ];
  for (const fn of sources) {
    const hit = await fn();
    if (hit && hit.url) return hit;
  }
  return null;
}

async function findCarouselImages(slides) {
  // Distinct subjects required; small de-dup pass on URLs as final guard.
  // Intent is auto-inferred per slide via findHeroImage's default.
  const seen = new Set();
  const out = [];
  for (const slide of slides || []) {
    let hit = await findHeroImage(slide.image_subject);
    if (hit && seen.has(hit.url)) {
      // Try a fallback search with the secondary subject hint if duplicate
      hit = await findHeroImage(`${slide.image_subject} stadium`, { intent: 'stadium' });
    }
    if (hit) seen.add(hit.url);
    out.push(hit);
  }
  return out;
}

// ── BB-BRANDED COMPOSITE (sharp + SVG) ──
function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// brandedSVG — Phase 9.1 redesign. Clean poster layout. The previous version
// stacked text starting at 40% from top with the BB logo at top-left, which
// caused logo+text overlap on long headlines. New layout has dedicated zones
// stacked vertically with no collision possible:
//
//   ┌─────────────── 6px gold-orange gradient bar ──────────┐
//   │                                                       │
//   │              ⬛ BB LOGO (centered, 32% w)              │  <- top zone (12-38%)
//   │                                                       │
//   │       ━━━━━━━━━━ accent line ━━━━━━━━━━              │  <- 42%
//   │                                                       │
//   │           HEADLINE (Space Grotesk 700)                │  <- mid zone (45-65%)
//   │           multi-line, centered                         │
//   │                                                       │
//   │       Subhead in Inter 400, lighter color             │  <- 70%
//   │                                                       │
//   │                                                       │
//   │              bitcoinbay.com  (gold)                   │  <- bottom (88%)
//   ├──────────── 6px gold-orange gradient bar ─────────────┤
//
// All text centered. No overlap with logo. Logo is composited on top of this
// SVG separately (in composeBrandedCard) so the logo zone above is reserved.
function brandedSVG({ width, height, headline, subhead = '', accent = BB_PALETTE.gold }) {
  // Adaptive font size for headline. Bigger budgets than before since the
  // layout has more vertical room without the top-left logo competing.
  const headlineLen = String(headline || '').length;
  let fontSize, charBudget;
  if (headlineLen <= 18)      { fontSize = Math.round(width / 11); charBudget = 18; }
  else if (headlineLen <= 40) { fontSize = Math.round(width / 16); charBudget = 24; }
  else                        { fontSize = Math.round(width / 22); charBudget = 30; }
  const lines = wrapHeadline(headline, charBudget, 3);
  const lineHeight = Math.round(fontSize * 1.1);

  // Vertical zones (% of height)
  const headlineCenterY = Math.round(height * 0.55);
  const subY = headlineCenterY + Math.ceil(lines.length / 2) * lineHeight + Math.round(fontSize * 0.4) + 24;
  const accentBarY = Math.round(height * 0.40);
  const accentBarW = Math.round(width * 0.30);
  const accentBarX = Math.round((width - accentBarW) / 2);

  const subhFontSize = Math.round(width / 32);
  const footerFontSize = Math.round(width / 44);

  // Multi-line headline, vertically centered around headlineCenterY
  const totalLineHeight = lines.length * lineHeight;
  const firstLineY = headlineCenterY - Math.round(totalLineHeight / 2) + lineHeight;
  const tspans = lines.map((ln, i) => {
    const y = firstLineY + i * lineHeight;
    return `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="'Space Grotesk', 'Inter', 'DejaVu Sans', sans-serif" font-size="${fontSize}" font-weight="700" fill="${BB_PALETTE.textPrimary}" letter-spacing="-1">${escapeXml(ln)}</text>`;
  }).join('\n    ');

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${BB_PALETTE.bgDark}"/>
        <stop offset="60%" stop-color="${BB_PALETTE.bgCard}"/>
        <stop offset="100%" stop-color="${BB_PALETTE.bgSurface}"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${accent}"/>
        <stop offset="100%" stop-color="${BB_PALETTE.orange}"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <rect x="0" y="0" width="100%" height="6" fill="url(#accent)"/>
    <rect x="0" y="${height - 6}" width="100%" height="6" fill="url(#accent)"/>
    <rect x="${accentBarX}" y="${accentBarY}" width="${accentBarW}" height="4" fill="${accent}"/>
    ${tspans}
    ${subhead ? `<text x="${width / 2}" y="${subY}" text-anchor="middle" font-family="'Inter', 'DejaVu Sans', 'Helvetica Neue', sans-serif"
          font-size="${subhFontSize}" font-weight="400" fill="${BB_PALETTE.textSecondary}">${escapeXml(subhead)}</text>` : ''}
    <text x="${width / 2}" y="${Math.round(height * 0.91)}" text-anchor="middle" font-family="'Space Grotesk', 'Inter', sans-serif"
          font-size="${footerFontSize}" font-weight="700" fill="${accent}" letter-spacing="2">BITCOINBAY.COM</text>
  </svg>`;
}

async function composeBrandedCard({ headline, subhead, kind = 'promo', outPath }) {
  // Aspect ratios: IG 1080x1080, X 1200x675, IG portrait 1080x1350
  const dimensions = {
    promo:           { w: 1080, h: 1080 },
    leaderboard_cta: { w: 1080, h: 1080 },
    register_cta:    { w: 1080, h: 1080 },
    bonus_cta:       { w: 1080, h: 1350 },
  };
  const { w, h } = dimensions[kind] || dimensions.promo;
  const svg = brandedSVG({ width: w, height: h, headline, subhead });
  let pipeline = sharp(Buffer.from(svg));
  // Phase 9.1: composite BB logo CENTERED in the upper-third zone reserved
  // by the SVG layout. Logo is square (1024×1024) so we resize to ~28% of
  // canvas width and center horizontally; vertical anchor is around 22% from
  // top (~140px on 1080) which leaves clean space above the accent bar at 40%.
  if (fs.existsSync(LOGO_PATH)) {
    const logoW = Math.round(w * 0.28);
    const logoBuf = await sharp(LOGO_PATH).resize({ width: logoW }).toBuffer();
    const logoLeft = Math.round((w - logoW) / 2);
    const logoTop = Math.round(h * 0.13);
    pipeline = pipeline.composite([{ input: logoBuf, top: logoTop, left: logoLeft }]);
  }
  await ensureDir(path.dirname(outPath));
  await pipeline.jpeg({ quality: 88 }).toFile(outPath);
  return { url: pathToPublicUrl(outPath), source: 'branded', attribution: 'Bitcoin Bay', license: 'Owned' };
}

// ── REAL-PHOTO + OVERLAY COMPOSITE ──
// Wrap a headline string into lines that fit a given character budget.
// Approximates pixel-aware wrapping by treating each line as ~charBudget
// characters wide. Result is up to maxLines lines; longer text gets
// truncated with an ellipsis on the last line.
function wrapHeadline(text, charBudget, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= charBudget) cur = cur + ' ' + w;
    else { lines.push(cur); cur = w; if (lines.length >= maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    // Truncate last line if there's overflow
    const last = lines[lines.length - 1];
    if (last.length > charBudget - 3) {
      lines[lines.length - 1] = last.slice(0, charBudget - 3).replace(/\s+\S*$/, '') + '…';
    } else {
      lines[lines.length - 1] = last + '…';
    }
  }
  return lines;
}

function overlaySVG({ width, height, headline, badgeKind, overlayX, overlayY, overlayColor, overlayFont }) {
  const badgeMap = {
    breaking:           { text: 'BREAKING',          color: BB_PALETTE.accentGreen },
    live:               { text: 'LIVE',              color: BB_PALETTE.orange },
    athlete_x_crypto:   { text: 'ATHLETE × CRYPTO',  color: BB_PALETTE.gold },
  };
  const badge = badgeMap[badgeKind];

  // ESPN/SportsCenter-style headline: uppercase, condensed bold sans-serif,
  // wide impact. Anton is the closest free font (used in browser preview);
  // the SVG renderer falls back to Impact / "Arial Narrow Bold" / Liberation
  // Sans Condensed depending on what's installed. The look is similar enough.
  const ucHeadline = String(headline || '').toUpperCase();
  const headlineLen = ucHeadline.length;
  // Bigger font sizes than before — uppercase + condensed lets us go heavier.
  let fontSize, charBudget, maxLines;
  if (headlineLen <= 22)      { fontSize = Math.round(width / 12); charBudget = 22; maxLines = 1; }
  else if (headlineLen <= 50) { fontSize = Math.round(width / 17); charBudget = 28; maxLines = 2; }
  else                        { fontSize = Math.round(width / 22); charBudget = 36; maxLines = 3; }
  const lines = wrapHeadline(ucHeadline, charBudget, maxLines);
  const lineHeight = Math.round(fontSize * 1.0);  // tighter for uppercase

  // Custom position via Phase 6.4 drag editor: overlayX, overlayY are 0-100
  // percentages relative to width/height. Default is anchored bottom-left.
  // overlayColor (#hex) overrides the white text color.
  const useCustomPos = Number.isFinite(overlayX) && Number.isFinite(overlayY);
  const headlineX = useCustomPos ? Math.round((Math.max(0, Math.min(100, overlayX)) / 100) * width) : 60;
  const headlineY = useCustomPos ? Math.round((Math.max(0, Math.min(100, overlayY)) / 100) * height) : (height - 80);
  const fillColor = (typeof overlayColor === 'string' && /^#[0-9a-f]{3,8}$/i.test(overlayColor))
    ? overlayColor : BB_PALETTE.textPrimary;

  // BB-navy stroke ("paint-order=stroke" puts it BEHIND the fill). Heavy
  // outline lets white text stay legible on bright photos AND lets BB-gold
  // text pop on darker photos. Mirrors the browser CSS multi-layer shadow.
  const strokeAttrs = `stroke="${BB_PALETTE.bgDark}" stroke-width="${Math.round(fontSize * 0.12)}" paint-order="stroke" stroke-linejoin="round"`;

  // Pick font family + weight + tracking based on per-slide overlayFont
  // setting. 'brand' = BB's display font (Space Grotesk; matches the
  // marketing site at index.html). 'espn' = condensed Anton (matches the
  // ESPN/SportsCenter IG carousel reference). Both fall through to
  // sensible system fonts on Heroku-22.
  const useEspn = overlayFont === 'espn';
  const fontFamily = useEspn
    ? "Anton, Impact, 'Arial Narrow Bold', 'Liberation Sans Condensed', 'Helvetica Neue Condensed Black', sans-serif"
    : "'Space Grotesk', 'Inter', 'DejaVu Sans', 'Helvetica Neue', sans-serif";
  const fontWeight = useEspn ? 400 : 700;
  const letterSpacing = useEspn ? 1 : -0.5;

  const tspans = lines.map((ln, i) => {
    const y = headlineY - (lines.length - 1 - i) * lineHeight;
    return `<text x="${headlineX}" y="${y}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" letter-spacing="${letterSpacing}" fill="${fillColor}" ${strokeAttrs}>${escapeXml(ln)}</text>`;
  }).join('\n    ');

  // Gradient only renders for default (bottom-anchored) overlays. Custom-
  // positioned headlines rely on the stroke for contrast.
  const gradientStartY = Math.round(headlineY - lines.length * lineHeight - 20);
  const gradient = useCustomPos ? '' : `<defs>
      <linearGradient id="darken" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${BB_PALETTE.bgDark}" stop-opacity="0"/>
        <stop offset="60%" stop-color="${BB_PALETTE.bgDark}" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="${BB_PALETTE.bgDark}" stop-opacity="0.94"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${Math.max(0, gradientStartY)}" width="100%" height="${height - Math.max(0, gradientStartY)}" fill="url(#darken)"/>`;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${gradient}
    ${badge ? `<rect x="60" y="60" rx="6" ry="6" width="${Math.max(180, badge.text.length * 16 + 30)}" height="42" fill="${badge.color}"/>
       <text x="${75}" y="92" font-family="Inter,Helvetica,Arial,sans-serif" font-size="22" font-weight="800" fill="${BB_PALETTE.bgDark}">${escapeXml(badge.text)}</text>` : ''}
    ${tspans}
  </svg>`;
}

async function composeOverlayCard({ imageUrl, headline, badgeKind, outPath, targetW = 1080, targetH = 1080, overlayX, overlayY, overlayColor, overlayFont }) {
  if (!imageUrl) throw new Error('composeOverlayCard requires imageUrl');
  // Download the source image (can be remote)
  const srcRes = await fetch(imageUrl, { signal: TIMEOUT(20000) });
  if (!srcRes.ok) throw new Error(`download failed: HTTP ${srcRes.status}`);
  const srcBuf = Buffer.from(await srcRes.arrayBuffer());
  // Cover-crop to target dimensions
  const baseBuf = await sharp(srcBuf)
    .resize(targetW, targetH, { fit: 'cover', position: 'center' })
    .toBuffer();
  // Compose overlay SVG on top (with optional custom position + color + font)
  const svg = overlaySVG({ width: targetW, height: targetH, headline, badgeKind, overlayX, overlayY, overlayColor, overlayFont });
  const composed = sharp(baseBuf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  await ensureDir(path.dirname(outPath));
  await composed.jpeg({ quality: 88 }).toFile(outPath);
  return pathToPublicUrl(outPath);
}

function pathToPublicUrl(absPath) {
  // Convert /…/public/post-images/2026-05-06/abc.jpg → /post-images/2026-05-06/abc.jpg
  const idx = absPath.indexOf('/public/');
  if (idx < 0) return absPath;
  return absPath.slice(idx + '/public'.length);
}

// ── AI SCENE GENERATION (Replicate InstantID, operator-only) ──
// Operator-triggered only via the dashboard 🎨 button. NOT called by runDrafter
// automatically. Cost: ~$0.05/image. Audit-logged at the route layer.
//
// InstantID preserves the face from `referenceImageUrl` while restyling the
// surroundings to match `scenePrompt`. Pass a Wikimedia Commons editorial photo
// of the athlete + a scene description, get back a JPEG with the athlete's
// actual likeness in the new scene.
async function generateAIScene({ scenePrompt, referenceImageUrl, outPath, width = 1080, height = 1080 }) {
  if (!process.env.REPLICATE_API_TOKEN) throw new Error('REPLICATE_API_TOKEN not set');
  if (!scenePrompt || String(scenePrompt).trim().length < 10) {
    throw new Error('scenePrompt required (min 10 chars)');
  }
  if (!referenceImageUrl) throw new Error('referenceImageUrl required (face for InstantID)');
  // Lazy require so the SDK + transitive deps don't load on every server boot —
  // only when the operator actually triggers a generation.
  const Replicate = require('replicate');
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  // Pin the version explicitly. The default Replicate JS SDK call for
  // "owner/name" hits /v1/models/{owner}/{name}/predictions which 404s for
  // community models without an "official" promoted version. The version-pinned
  // form ("owner/name:version") routes through /v1/predictions instead.
  // To rotate to a newer version, set BCBAY_REPLICATE_MODEL with the
  // pinned slug. Latest as of 2026-05-06: 2e4785a4d80dadf580077b2244c8d7c05d8e3faac04a04c02d8e099dd2876789.
  const model = process.env.BCBAY_REPLICATE_MODEL
    || 'zsxkib/instant-id:2e4785a4d80dadf580077b2244c8d7c05d8e3faac04a04c02d8e099dd2876789';

  const output = await replicate.run(model, {
    input: {
      image: referenceImageUrl,
      prompt: scenePrompt,
      negative_prompt: 'blurry, low quality, distorted face, watermark, text, logo, deformed, ugly',
      width, height,
      num_inference_steps: 30,
      guidance_scale: 5,
    },
  });
  const generatedUrl = Array.isArray(output) ? output[0] : output;
  if (!generatedUrl) throw new Error(`Replicate returned no image (model=${model})`);

  // Download + re-encode to JPEG so the asset matches the rest of the pipeline
  // (uniform format, predictable size, served by express.static).
  const res = await fetch(String(generatedUrl), { signal: TIMEOUT(30000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await ensureDir(path.dirname(outPath));
  await sharp(buf).resize(width, height, { fit: 'cover' }).jpeg({ quality: 88 }).toFile(outPath);
  return {
    url: pathToPublicUrl(outPath),
    source: 'replicate',
    model,
    attribution: 'AI-generated (Replicate InstantID, reference photo)',
  };
}

// ── DRAFT-LEVEL PIPELINE ──
async function saveDraftImages(draft, { dateDir, draftId } = {}) {
  // Returns the patches needed on the draft doc.
  const date = draft.brief_date || new Date().toISOString().slice(0, 10);
  const dir = dateDir || path.join(PUBLIC_DIR, date);
  const id = draftId || draft._id?.toString() || slugify(draft.topic).slice(0, 24);

  if (draft.platform === 'instagram_carousel') {
    const slides = draft.slides || [];
    // Parallelize slide rendering — Wikimedia/Pexels easily handle 5
    // concurrent lookups, and sharp encoding is CPU-bound but small.
    // Was the source of "Image pending" sticking around 30s+ for carousels.
    const renderOne = async (s, i) => {
      // BB-subject slides → branded composite, skip the real-photo cascade.
      if (isBBSubject(s.image_subject)) {
        try {
          const outPath = path.join(dir, id, `slide-${i}.jpg`);
          const composite = await composeBrandedCard({
            headline: s.headline || draft.topic || 'Bitcoin Bay',
            subhead: s.body_text || '',
            kind: inferBrandedKind({ ...draft, image_subject: s.image_subject }),
            outPath,
          });
          return {
            ...s,
            image_url: composite.url,
            image_attribution: composite.attribution,
            composite_url: composite.url,
          };
        } catch (e) {
          console.warn(`[imageRenderer] slide ${i} branded composite failed: ${e.message}`);
        }
      }
      // Real-photo path — intent auto-inferred from slide subject.
      // Overlay coords + color come from the slide if the operator dragged
      // them via the Phase 6.4 layout editor; absent → default bottom-left/white.
      const hit = await findHeroImage(s.image_subject);
      let composite = null;
      if (hit?.url) {
        try {
          const outPath = path.join(dir, id, `slide-${i}.jpg`);
          composite = await composeOverlayCard({
            imageUrl: hit.url,
            headline: s.headline || '',
            badgeKind: i === 0 ? (draft.angle?.toLowerCase().includes('athlete') ? 'athlete_x_crypto' : 'breaking') : null,
            outPath,
            overlayX: Number.isFinite(s.overlay_x) ? s.overlay_x : undefined,
            overlayY: Number.isFinite(s.overlay_y) ? s.overlay_y : undefined,
            overlayColor: typeof s.overlay_color === 'string' ? s.overlay_color : undefined,
            overlayFont: s.overlay_font === 'espn' ? 'espn' : 'brand',
          });
        } catch (e) {
          console.warn(`[imageRenderer] slide ${i} composite failed: ${e.message}`);
        }
      }
      return {
        ...s,
        image_url: hit?.url || null,
        image_attribution: hit?.attribution || null,
        composite_url: composite,
      };
    };
    const newSlides = await Promise.all(slides.map((s, i) => renderOne(s, i)));
    const ready = newSlides.filter((s) => s.composite_url || s.image_url).length;
    return {
      slides: newSlides,
      image_status: ready === slides.length ? 'ready' : (ready === 0 ? 'failed' : 'partial'),
    };
  }

  // Single-image (Twitter or IG single).
  // Branded composite path: explicit format_hint OR a BB-named subject.
  if (draft.format_hint === 'branded_promo' || isBBSubject(draft.image_subject)) {
    const outPath = path.join(dir, id, 'main.jpg');
    const composite = await composeBrandedCard({
      headline: draft.image_overlay_text || draft.topic || 'Bitcoin Bay',
      subhead: draft.angle || '',
      kind: inferBrandedKind(draft),
      outPath,
    });
    return {
      image_url: composite.url,
      image_attribution: composite.attribution,
      image_status: 'ready',
    };
  }

  const subject = draft.image_subject;
  if (!subject) return { image_status: 'failed' };
  // Intent auto-inferred from subject text (athletes → Wikimedia first, etc.)
  const hit = await findHeroImage(subject);
  if (!hit?.url) return { image_status: 'failed' };

  // For IG single, compose with overlay; for X, leave the raw real photo
  // (X auto-renders the URL as a card and the tweet text carries the headline).
  if (draft.platform === 'instagram_single' && draft.image_overlay_text) {
    try {
      const outPath = path.join(dir, id, 'main.jpg');
      const composite = await composeOverlayCard({
        imageUrl: hit.url,
        headline: draft.image_overlay_text,
        outPath,
      });
      return {
        image_url: composite,
        image_source_url: hit.url,
        image_attribution: hit.attribution,
        image_status: 'ready',
      };
    } catch (e) {
      console.warn(`[imageRenderer] IG single composite failed: ${e.message}`);
    }
  }

  return {
    image_url: hit.url,
    image_attribution: hit.attribution,
    image_status: 'ready',
  };
}

module.exports = {
  BB_PALETTE,
  findHeroImage,
  findCarouselImages,
  composeBrandedCard,
  composeOverlayCard,
  saveDraftImages,
  generateAIScene,
  // subject inference / routing (Phase 4.1):
  inferIntent,
  isBBSubject,
  inferBrandedKind,
  pexelsOffTopic,
  // exposed for tests / debugging:
  wikimediaSearch,
  scoreWikimediaResult,
  findWikimediaImage,
  findPexelsImage,
  findUnsplashImage,
  // Phase 9.2 — replace-photo candidate search:
  searchPhotoCandidates,
  searchWikimediaCandidates,
  searchPexelsCandidates,
  searchUnsplashCandidates,
};
