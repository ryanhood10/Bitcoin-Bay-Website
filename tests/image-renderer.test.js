// Unit tests for the Phase 4.1 imageRenderer.js helpers — the routing
// logic that decides which source to query, what intent to apply, and
// when to reject obviously off-topic Pexels matches.
//
// These were the three quality misses in the May-6 asset audit:
//   1. "Bitcoin Bay logo" → Pexels returned a wood-sticker (no BB-routing)
//   2. "SGA celebration" → Pexels returned a birthday party (off-topic match)
//   3. saveDraftImages always passed sport_action → athletes deprioritized
//        Wikimedia.
// The helpers tested here are what fixes them.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferIntent,
  isBBSubject,
  inferBrandedKind,
  pexelsOffTopic,
  searchBraveCandidates,
  searchGoogleCandidates,
  searchPhotoCandidates,
} = require('../imageRenderer');

// ---------------------------------------------------------------------------
// inferIntent — auto-detect intent from a subject string so findHeroImage
// can pick the right source order (athletes → Wikimedia first, etc.)
// ---------------------------------------------------------------------------
test('inferIntent — full athlete name returns "athlete"', () => {
  assert.equal(inferIntent('Shai Gilgeous-Alexander'), 'athlete');
  assert.equal(inferIntent('Patrick Mahomes'), 'athlete');
  assert.equal(inferIntent('Travis Kelce'), 'athlete');
});

test('inferIntent — apostrophe + hyphen names', () => {
  assert.equal(inferIntent("D'Andre Swift"), 'athlete');
  assert.equal(inferIntent("Ja'Marr Chase"), 'athlete');
});

test('inferIntent — single-word subjects fall through to sport_action', () => {
  // Single capitalized word is too ambiguous to call as athlete (could be a
  // team, a city, a brand). Default to sport_action and let the cascade decide.
  assert.equal(inferIntent('Mahomes'), 'sport_action');
  assert.equal(inferIntent('SGA'), 'sport_action');
});

test('inferIntent — stadium/arena/court tokens', () => {
  assert.equal(inferIntent('Crypto.com Arena'), 'stadium');
  assert.equal(inferIntent('Lambeau Field'), 'stadium');
  assert.equal(inferIntent('Madison Square Garden'), 'stadium');
});

test('inferIntent — crypto vocab', () => {
  assert.equal(inferIntent('BTC chart'), 'crypto');
  assert.equal(inferIntent('Bitcoin halving'), 'crypto');
  assert.equal(inferIntent('Ethereum wallet'), 'crypto');
});

test('inferIntent — finance/market vocab', () => {
  assert.equal(inferIntent('market rally'), 'abstract_finance');
  assert.equal(inferIntent('price chart'), 'abstract_finance');
  assert.equal(inferIntent('liquidation event'), 'abstract_finance');
});

test('inferIntent — team tokens', () => {
  assert.equal(inferIntent('Lakers warmups'), 'team');
  assert.equal(inferIntent('Cowboys offense'), 'team');
  assert.equal(inferIntent('Yankees pitching'), 'team');
});

test('inferIntent — generic sport phrases default to sport_action', () => {
  assert.equal(inferIntent('basketball play'), 'sport_action');
  assert.equal(inferIntent('football helmet'), 'sport_action');
  assert.equal(inferIntent('end zone'), 'sport_action');
});

test('inferIntent — empty/null subject → sport_action default', () => {
  assert.equal(inferIntent(''), 'sport_action');
  assert.equal(inferIntent(null), 'sport_action');
  assert.equal(inferIntent(undefined), 'sport_action');
});

// ---------------------------------------------------------------------------
// isBBSubject — detect when the subject is about Bitcoin Bay itself,
// so the renderer can route to a branded composite instead of the
// real-photo cascade (which would return random off-topic Pexels hits).
// ---------------------------------------------------------------------------
test('isBBSubject — matches BB-named subjects', () => {
  assert.equal(isBBSubject('Bitcoin Bay logo'), true);
  assert.equal(isBBSubject('bitcoinbay sportsbook'), true);
  assert.equal(isBBSubject('BB Logo'), true);
  assert.equal(isBBSubject('BB sportsbook'), true);
});

test('isBBSubject — rejects non-BB subjects', () => {
  assert.equal(isBBSubject('Shai Gilgeous-Alexander'), false);
  assert.equal(isBBSubject('basketball celebration'), false);
  assert.equal(isBBSubject('NFL stadium'), false);
  assert.equal(isBBSubject(''), false);
  assert.equal(isBBSubject(null), false);
});

// ---------------------------------------------------------------------------
// inferBrandedKind — picks the right branded-card kind from draft context
// (leaderboard_cta, register_cta, bonus_cta, or generic promo).
// ---------------------------------------------------------------------------
test('inferBrandedKind — leaderboard CTA', () => {
  assert.equal(inferBrandedKind({ topic: 'Weekly leaderboard winners' }), 'leaderboard_cta');
  assert.equal(inferBrandedKind({ angle: 'top 10 this week' }), 'leaderboard_cta');
});

test('inferBrandedKind — register CTA', () => {
  assert.equal(inferBrandedKind({ topic: 'Sign up to play' }), 'register_cta');
  assert.equal(inferBrandedKind({ angle: 'create account in seconds' }), 'register_cta');
});

test('inferBrandedKind — bonus CTA', () => {
  assert.equal(inferBrandedKind({ topic: 'New bonus offer this week' }), 'bonus_cta');
  assert.equal(inferBrandedKind({ angle: 'deposit match week' }), 'bonus_cta');
});

test('inferBrandedKind — generic promo fallback', () => {
  assert.equal(inferBrandedKind({ topic: 'Bitcoin Bay highlights' }), 'promo');
  assert.equal(inferBrandedKind({}), 'promo');
});

// ---------------------------------------------------------------------------
// pexelsOffTopic — reject obviously off-topic Pexels matches when the
// subject is sport-flavored. Was the source of the May-6 "SGA celebration
// → birthday party balloons" miss.
// ---------------------------------------------------------------------------
test('pexelsOffTopic — rejects birthday party for sport intent', () => {
  const photo = { alt: 'birthday party with balloons', url: 'https://pexels.com/p/x' };
  assert.equal(pexelsOffTopic(photo, 'sport_action'), true);
  assert.equal(pexelsOffTopic(photo, 'athlete'), true);
});

test('pexelsOffTopic — rejects wedding/family/baby/holiday for sport intent', () => {
  for (const bad of [
    { alt: 'a wedding ceremony in a garden' },
    { alt: 'family portrait in studio' },
    { alt: 'a baby playing with toys' },
    { alt: 'christmas tree with presents' },
    { alt: 'kids at school' },
    { alt: 'people drinking at a gala' },
    { alt: 'halloween costume party' },
  ]) {
    assert.equal(pexelsOffTopic(bad, 'sport_action'), true, `should reject "${bad.alt}"`);
  }
});

test('pexelsOffTopic — allows on-topic sport photos', () => {
  const photo = { alt: 'basketball player jumping at the rim' };
  assert.equal(pexelsOffTopic(photo, 'sport_action'), false);
});

test('pexelsOffTopic — does NOT filter for non-sport intents', () => {
  // For abstract_finance / crypto, a "party" photo could legitimately be
  // a launch event etc. — the deny-list is sport-context only.
  const photo = { alt: 'birthday party with balloons' };
  assert.equal(pexelsOffTopic(photo, 'crypto'), false);
  assert.equal(pexelsOffTopic(photo, 'abstract_finance'), false);
});

test('pexelsOffTopic — handles missing alt gracefully', () => {
  const photo = { url: 'https://pexels.com/photo/12345/' };
  assert.equal(pexelsOffTopic(photo, 'sport_action'), false);
});

// ---------------------------------------------------------------------------
// Phase 9.9 — Brave Search Images (replace-photo source). Verifies the
// guard rails: missing key → silent empty; missing subject → silent empty.
// We don't test the live API call here (would need network + the operator
// key); scripts/test-image-search.js covers the live smoke test.
// ---------------------------------------------------------------------------
test('searchBraveCandidates — returns [] when BRAVE_API_KEY is unset', async () => {
  const previous = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    const out = await searchBraveCandidates('lakers', 3);
    assert.deepEqual(out, []);
  } finally {
    if (previous !== undefined) process.env.BRAVE_API_KEY = previous;
  }
});

test('searchBraveCandidates — returns [] for empty subject', async () => {
  const out = await searchBraveCandidates('', 3);
  assert.deepEqual(out, []);
});

test('searchPhotoCandidates — returns the brave key alongside the others', async () => {
  // No env vars set → all sources gracefully empty, but the keys must exist
  // so the UI's source loop can render the labels in the right order.
  const previousBrave = process.env.BRAVE_API_KEY;
  const previousPexels = process.env.PEXELS_API_KEY;
  const previousUnsplash = process.env.UNSPLASH_ACCESS_KEY;
  const previousGoogleKey = process.env.GOOGLE_API_KEY;
  const previousGoogleCse = process.env.GOOGLE_CSE_ID;
  delete process.env.BRAVE_API_KEY;
  delete process.env.PEXELS_API_KEY;
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_CSE_ID;
  try {
    // Empty subject short-circuits Wikimedia too — we just want the shape.
    const out = await searchPhotoCandidates('');
    assert.deepEqual(Object.keys(out).sort(), ['brave', 'google', 'pexels', 'unsplash', 'wikimedia']);
  } finally {
    if (previousBrave !== undefined) process.env.BRAVE_API_KEY = previousBrave;
    if (previousPexels !== undefined) process.env.PEXELS_API_KEY = previousPexels;
    if (previousUnsplash !== undefined) process.env.UNSPLASH_ACCESS_KEY = previousUnsplash;
    if (previousGoogleKey !== undefined) process.env.GOOGLE_API_KEY = previousGoogleKey;
    if (previousGoogleCse !== undefined) process.env.GOOGLE_CSE_ID = previousGoogleCse;
  }
});

test('searchGoogleCandidates — silent empty when either env var is missing', async () => {
  // Sanity check the existing dormant Google integration still no-ops cleanly
  // (used by scripts/test-image-search.js when GOOGLE_API_KEY is set without CSE).
  const previousKey = process.env.GOOGLE_API_KEY;
  const previousCse = process.env.GOOGLE_CSE_ID;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_CSE_ID;
  try {
    assert.deepEqual(await searchGoogleCandidates('lakers'), []);
    process.env.GOOGLE_API_KEY = 'fake-key-for-shape-test';
    assert.deepEqual(await searchGoogleCandidates('lakers'), []);  // still empty (no CSE)
  } finally {
    if (previousKey !== undefined) process.env.GOOGLE_API_KEY = previousKey; else delete process.env.GOOGLE_API_KEY;
    if (previousCse !== undefined) process.env.GOOGLE_CSE_ID = previousCse;
  }
});
