// ---------------------------------------------------------------------------
// agentClient.js — server-to-server client for the wager (PPH Insider) API.
//
// The agent portal issues a 21-minute JWT and exposes a /renewToken endpoint
// that returns a fresh JWT when called with a still-valid Bearer token. As
// long as we refresh before expiry, we can maintain a valid token indefinitely
// without re-logging in (which would require 2FA).
//
// How auth is bootstrapped and kept alive
//   1) Initial JWT is seeded from the AGENT_TOKEN env var (captured once from
//      a browser session after a fresh agent login + 2FA).
//   2) Every call goes through getValidToken(), which checks the cached JWT's
//      `exp` claim and proactively refreshes if there's < REFRESH_SKEW_SEC
//      left on the clock.
//   3) The refreshed token is held in module memory AND persisted to Mongo
//      (collection `bcb_agent_token`) so it survives dyno restarts.
//   4) If the refresh chain ever breaks (missed refresh window, backend
//      revoked, 401 on renew), callers get an AgentAuthError and the admin
//      must reseed AGENT_TOKEN. This is intentional — we do NOT automate
//      re-login, because that path requires 2FA.
//
// Security notes
//   - AGENT_USERNAME / AGENT_PASSWORD are stored as env vars but are NOT used
//     by this module. They're reserved in case we ever need to bootstrap
//     without a captured JWT (would require 2FA, so not automated today).
//   - The only wager operation we expose is updatePlayerPassword(). Callers
//     cannot use this module to modify arbitrary columns. `column=Password`
//     is hardcoded to minimize blast radius if our server is ever compromised.
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const AGENT_ID       = 'BITCOINBAY';
const AGENT_OWNER    = 'BITCOINBAY';
const AGENT_SITE     = '1';
const WAGER_BASE     = 'https://wager.bitcoinbay.com';
const RENEW_URL      = `${WAGER_BASE}/cloud/api/System/renewToken`;
const UPDATE_URL     = `${WAGER_BASE}/cloud/api/Manager/updateByColumn`;
const GET_INFO_URL   = `${WAGER_BASE}/cloud/api/Manager/getInfoPlayer`;

// Refresh the JWT when it has this much time or less remaining. 21-min tokens
// + 5-min skew = we refresh every ~16 minutes of activity. Plenty of buffer.
const REFRESH_SKEW_SEC = 5 * 60;

// Mongo location of the persisted current token. Single-document collection.
const MONGO_DB     = 'bcbay_automation';
const TOKEN_COLL   = 'bcb_agent_token';
const TOKEN_DOC_ID = 'current';

class AgentAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AgentAuthError'; }
}

class AgentApiError extends Error {
  constructor(msg, status, body) {
    super(msg);
    this.name = 'AgentApiError';
    this.status = status;
    this.body = body;
  }
}

// In-memory cache of the current token. Survives within a dyno; Mongo is the
// source of truth across restarts.
let cachedToken = null; // { code: string, exp: number (unix seconds) }

function decodeJwtExp(jwt) {
  try {
    const payload = jwt.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return typeof decoded.exp === 'number' ? decoded.exp : null;
  } catch (_) {
    return null;
  }
}

async function loadTokenFromMongo() {
  if (!process.env.MONGO_URI) return null;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const doc = await client.db(MONGO_DB).collection(TOKEN_COLL).findOne({ _id: TOKEN_DOC_ID });
    return doc && doc.code ? { code: doc.code, exp: doc.exp } : null;
  } catch (err) {
    console.error('[agent] mongo token load failed:', err.message);
    return null;
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

async function saveTokenToMongo(token) {
  if (!process.env.MONGO_URI) return;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db(MONGO_DB).collection(TOKEN_COLL).updateOne(
      { _id: TOKEN_DOC_ID },
      { $set: { code: token.code, exp: token.exp, updated_at: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('[agent] mongo token save failed:', err.message);
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// Resolve the best available starting token. Priority:
//   1) In-memory cache (already loaded this process)
//   2) Mongo-persisted token from a previous run
//   3) AGENT_TOKEN env var (fresh seed from a browser capture)
async function getInitialToken() {
  if (cachedToken) return cachedToken;

  const mongoToken = await loadTokenFromMongo();
  if (mongoToken && mongoToken.exp && mongoToken.exp > nowSec()) {
    cachedToken = mongoToken;
    return cachedToken;
  }

  const seed = process.env.AGENT_TOKEN;
  if (seed) {
    const exp = decodeJwtExp(seed);
    if (exp && exp > nowSec()) {
      cachedToken = { code: seed, exp };
      await saveTokenToMongo(cachedToken);
      return cachedToken;
    }
    console.error('[agent] AGENT_TOKEN env var is present but expired (exp=', exp, '). Reseed required.');
  }

  throw new AgentAuthError(
    'No valid agent JWT available. Seed AGENT_TOKEN env var with a fresh JWT ' +
    'from the agent portal session storage.'
  );
}

function nowSec() { return Math.floor(Date.now() / 1000); }

async function refreshToken(currentJwt) {
  const body = new URLSearchParams({
    operation:   'renewToken',
    agentID:     AGENT_ID,
    agentOwner:  AGENT_OWNER,
    agentSite:   AGENT_SITE
  });

  const r = await fetch(RENEW_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${currentJwt}`,
      'Content-Type':  'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: body.toString()
  });

  if (r.status === 401 || r.status === 403) {
    throw new AgentAuthError(`Refresh rejected (HTTP ${r.status}). Current JWT is no longer accepted — reseed AGENT_TOKEN.`);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new AgentApiError(`Refresh failed HTTP ${r.status}`, r.status, text.slice(0, 500));
  }

  const data = await r.json().catch(() => null);
  if (!data || !data.code) {
    throw new AgentApiError('Refresh response missing `code` field', r.status, JSON.stringify(data));
  }

  const exp = decodeJwtExp(data.code);
  return { code: data.code, exp: exp || (nowSec() + 20 * 60) };
}

// Public: return a valid JWT, refreshing proactively if expiry is near.
async function getValidToken() {
  const current = await getInitialToken();
  const secondsLeft = (current.exp || 0) - nowSec();

  if (secondsLeft > REFRESH_SKEW_SEC) {
    return current.code;
  }

  try {
    const fresh = await refreshToken(current.code);
    cachedToken = fresh;
    await saveTokenToMongo(fresh);
    console.log('[agent] token refreshed, new exp in', Math.round((fresh.exp - nowSec()) / 60), 'min');
    return fresh.code;
  } catch (err) {
    if (secondsLeft > 0) {
      // Refresh failed but current token still has life — use it and surface
      // the refresh failure in logs. Next call will try to refresh again.
      console.error('[agent] refresh failed but current token still valid:', err.message);
      return current.code;
    }
    throw err;
  }
}

// Public: update a player's password. The ONLY write we expose.
// Returns { ok: true } on success, throws AgentApiError on failure.
async function updatePlayerPassword({ customerId, newPassword, oldPassword, auditTitle, auditInfo }) {
  if (!customerId || !newPassword) {
    throw new Error('updatePlayerPassword requires customerId and newPassword');
  }

  const token = await getValidToken();

  // Match the portal's payload shape exactly. `column` and `type` are
  // hardcoded to Password/1 — do NOT parameterize these. Keeping them fixed
  // means a bug elsewhere cannot accidentally update another column.
  const body = new URLSearchParams({
    customerID:  customerId,
    agentID:     AGENT_ID,
    operation:   'updateByColumn',
    title:       auditTitle || 'Password Reset (website forgot-password)',
    info:        auditInfo  || `Password reset via website forgot-password flow. Old: ${oldPassword || '[unknown]'}`,
    column:      'Password',
    type:        '1',
    value:       newPassword,
    agentOwner:  AGENT_OWNER,
    agentSite:   AGENT_SITE
  });

  const r = await fetch(UPDATE_URL, {
    method: 'POST',
    headers: {
      'Authorization':    `Bearer ${token}`,
      'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: body.toString()
  });

  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}

  if (r.status === 401 || r.status === 403) {
    throw new AgentAuthError(`updateByColumn auth rejected (HTTP ${r.status}). Token may have expired mid-request.`);
  }
  if (!r.ok) {
    throw new AgentApiError(`updateByColumn HTTP ${r.status}`, r.status, text.slice(0, 500));
  }

  // Observed success shape: {"Result":{"Result":1}}
  const innerResult = data && data.Result && data.Result.Result;
  if (innerResult !== 1) {
    throw new AgentApiError('updateByColumn returned non-success result', r.status, text.slice(0, 500));
  }

  return { ok: true };
}

// Public: fetch a player's stored info (email, name, etc). Useful for legacy
// users we don't have in our own Mongo. Returns null if not found.
async function getPlayerInfo(customerId) {
  if (!customerId) return null;
  const token = await getValidToken();

  const body = new URLSearchParams({
    customerID: customerId,
    agentID:    AGENT_ID,
    operation:  'getInfoPlayer',
    agentOwner: AGENT_OWNER,
    agentSite:  AGENT_SITE
  });

  const r = await fetch(GET_INFO_URL, {
    method: 'POST',
    headers: {
      'Authorization':    `Bearer ${token}`,
      'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: body.toString()
  });

  if (r.status === 401 || r.status === 403) {
    throw new AgentAuthError(`getInfoPlayer auth rejected (HTTP ${r.status})`);
  }
  if (!r.ok) return null;

  const data = await r.json().catch(() => null);
  return data && data.INFO && data.INFO.data ? data.INFO.data : null;
}

// Background refresh loop. Without this, on a low-traffic site the token
// simply expires between user visits — because the passive refresh in
// getValidToken only fires on incoming requests. The background loop keeps
// a valid token warm at all times so forgot-password flows never hit a cold
// token even if the site has been idle for hours.
let _bgInterval = null;
const BG_REFRESH_MS = 14 * 60 * 1000;  // every 14 min (tokens live 21)

function startBackgroundRefresh() {
  if (_bgInterval) return;
  _bgInterval = setInterval(async () => {
    try {
      await getValidToken();
    } catch (err) {
      console.error('[agent] background refresh failed:', err.message);
    }
  }, BG_REFRESH_MS);
  // Don't block process shutdown waiting for this timer.
  if (_bgInterval.unref) _bgInterval.unref();
  console.log('[agent] background refresh loop started (every', BG_REFRESH_MS/60000, 'min)');

  // Fire one immediate refresh so boot doesn't rely on the seeded token
  // being fresh — pulls a brand-new one right away if seed has life left.
  getValidToken().catch(err =>
    console.error('[agent] initial warm-up refresh failed:', err.message)
  );
}

function stopBackgroundRefresh() {
  if (_bgInterval) { clearInterval(_bgInterval); _bgInterval = null; }
}

module.exports = {
  getValidToken,
  updatePlayerPassword,
  getPlayerInfo,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  AgentAuthError,
  AgentApiError
};
