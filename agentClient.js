// ---------------------------------------------------------------------------
// agentClient.js — server-to-server client for the wager (PPH Insider) API.
//
// Self-healing auth model (no manual JWT reseeding required):
//
//   1) Try cached token (in-memory) → if valid, use it
//   2) Else try persisted token (Mongo) → if valid, use it
//   3) Else try AGENT_TOKEN env var seed → if valid, use it
//   4) Else perform a FRESH LOGIN from scratch using AGENT_USERNAME,
//      AGENT_PASSWORD, and AGENT_TOTP_SECRET. This is what unlocks indefinite
//      uptime — the server logs in exactly like a human does (password +
//      TOTP 2FA code), but generates the 2FA code itself from the shared
//      TOTP secret. No human intervention needed.
//   5) The real backend enforces a ~9-hour max lifetime on a JWT chain.
//      When refreshToken() eventually hits that wall and returns 401, we
//      automatically fall back to performFreshLogin() and mint a new chain.
//
// Fresh-login flow (two-step, matches what the browser portal does):
//   a) POST /cloud/api/System/authenticateCustomer with customerID/password/etc.
//      → returns { tokentemp: <short-lived temp JWT> }
//   b) POST /cloud/api/System/OTPLoginWithCode with Bearer <temp JWT> and
//      the current 6-digit TOTP code → returns { code: <full-access JWT> }
//
// Security notes
//   - All three auth secrets (password, TOTP secret, JWT cache) live only in
//     Heroku env vars or Mongo — never in code, never in logs.
//   - The only wager WRITE we expose is updatePlayerPassword(). Callers
//     cannot use this module to modify arbitrary columns — `column=Password`
//     is hardcoded to minimize blast radius if our server is ever compromised.
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const AGENT_ID       = 'BITCOINBAY';
const AGENT_OWNER    = 'BITCOINBAY';
const AGENT_SITE     = '1';
const WAGER_BASE     = 'https://wager.bitcoinbay.com';
const RENEW_URL      = `${WAGER_BASE}/cloud/api/System/renewToken`;
const AUTH_URL       = `${WAGER_BASE}/cloud/api/System/authenticateCustomer`;
const OTP_URL        = `${WAGER_BASE}/cloud/api/System/OTPLoginWithCode`;
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
    console.log('[agent] AGENT_TOKEN env var is expired — falling back to fresh login');
  } else {
    console.log('[agent] No cached token and no AGENT_TOKEN seed — performing fresh login');
  }

  // Final fallback: log in from scratch using username + password + TOTP.
  // This is what makes the system self-healing — the server re-authenticates
  // exactly like a human would, but generates its own 2FA codes.
  const fresh = await performFreshLogin();
  cachedToken = fresh;
  await saveTokenToMongo(fresh);
  return cachedToken;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// ---------------------------------------------------------------------------
// TOTP generator (RFC 6238). Produces the same 6-digit code Google
// Authenticator does, given the shared secret (base32). We use this so our
// server can generate 2FA codes on demand without a human with a phone.
// ---------------------------------------------------------------------------
function base32Decode(str) {
  // RFC 4648 base32 (A-Z2-7). Accepts uppercase, ignores padding.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = str.replace(/=+$/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('Invalid base32 char: ' + ch);
    bits += v.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return out;
}

function generateTotp(secretB32, stepSec = 30, digits = 6, offsetSteps = 0) {
  if (!secretB32) throw new Error('AGENT_TOTP_SECRET is not set');
  const key = base32Decode(secretB32);
  const counter = Math.floor(nowSec() / stepSec) + offsetSteps;
  // Counter -> 8-byte big-endian
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
    ( hmac[offset + 3] & 0xff);
  return (binCode % Math.pow(10, digits)).toString().padStart(digits, '0');
}

// ---------------------------------------------------------------------------
// Fresh login: authenticateCustomer → OTPLoginWithCode → real JWT
// This is what makes the whole system self-healing. When any part of the
// cache/refresh chain breaks, we come back here and mint a new chain.
// ---------------------------------------------------------------------------
// Consecutive fresh-login failures. Reset to 0 on success. When this crosses
// ALERT_FAILURE_THRESHOLD, we email info@bitcoinbay.com so the operator knows
// before users do (e.g. wager backend down, password changed, TOTP rotated).
let _loginFailureStreak = 0;
let _lastAlertAt = 0;
const ALERT_FAILURE_THRESHOLD = 3;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;  // one alert per hour max

async function sendOpsAlert(subject, message) {
  const to = process.env.EMAIL;        // info@bitcoinbay.com equivalent
  const pass = process.env.EMAIL_PASSWORD;
  if (!to || !pass) return;            // no transport configured
  const now = Date.now();
  if (now - _lastAlertAt < ALERT_COOLDOWN_MS) return;  // cooldown
  _lastAlertAt = now;
  try {
    const t = nodemailer.createTransport({
      host: 'mail.gandi.net', port: 465, secure: true,
      auth: { user: to, pass }
    });
    await t.sendMail({
      from: `"Bitcoin Bay Ops" <${to}>`,
      to,
      subject: `[BCB OPS] ${subject}`,
      text: `${message}\n\nTime: ${new Date().toISOString()}\nHeroku app: bitcoin-bay\n`
    });
    console.log('[agent] ops alert sent:', subject);
  } catch (err) {
    console.error('[agent] ops alert send failed:', err.message);
  }
}

async function performFreshLogin() {
  const user   = process.env.AGENT_USERNAME;
  const pass   = process.env.AGENT_PASSWORD;
  const secret = process.env.AGENT_TOTP_SECRET;

  if (!user || !pass || !secret) {
    throw new AgentAuthError(
      'Fresh login requires AGENT_USERNAME, AGENT_PASSWORD, and AGENT_TOTP_SECRET env vars.'
    );
  }

  console.log('[agent] performing fresh login...');

  try {
    return await _doFreshLoginSteps();
  } catch (err) {
    _loginFailureStreak++;
    if (_loginFailureStreak >= ALERT_FAILURE_THRESHOLD) {
      sendOpsAlert(
        `Agent fresh-login failing (${_loginFailureStreak} in a row)`,
        `The last error was: ${err.message}\n\n` +
        `User-facing password resets will fail until this is resolved. ` +
        `Check Heroku logs for details.`
      );
    }
    throw err;
  }
}

async function _doFreshLoginSteps() {
  const user   = process.env.AGENT_USERNAME;
  const pass   = process.env.AGENT_PASSWORD;
  const secret = process.env.AGENT_TOTP_SECRET;

  // Step 1 — authenticateCustomer. The portal uppercases the password before
  // submitting; we mirror that exactly to match the captured browser flow.
  const step1Body = new URLSearchParams({
    customerID:    user,
    state:         'true',
    password:      pass.toUpperCase(),
    multiaccount:  '0',
    response_type: 'code',
    client_id:     user,
    domain:        'wager.bitcoinbay.com',
    redirect_uri:  'wager.bitcoinbay.com',
    token:         '',
    operation:     'authenticateCustomer',
    RRO:           '1'
  });

  const r1 = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Authorization':    'Bearer'   // browser sends an empty Bearer here
    },
    body: step1Body.toString()
  });

  if (!r1.ok) {
    const text = await r1.text().catch(() => '');
    throw new AgentAuthError(`authenticateCustomer HTTP ${r1.status}: ${text.slice(0, 300)}`);
  }
  const d1 = await r1.json().catch(() => null);
  const tempJwt = d1 && (d1.tokentemp || d1.code);
  if (!tempJwt) {
    throw new AgentAuthError('authenticateCustomer response missing tokentemp/code: ' + JSON.stringify(d1).slice(0, 300));
  }

  // Step 2 — OTPLoginWithCode with the current TOTP. If we just missed the
  // 30-second window, try the previous and next codes too (± 1 step skew).
  const codes = [
    generateTotp(secret, 30, 6, 0),
    generateTotp(secret, 30, 6, -1),
    generateTotp(secret, 30, 6, 1)
  ];

  for (const code of codes) {
    const step2Body = new URLSearchParams({ operation: 'OTPLoginWithCode', code });
    const r2 = await fetch(OTP_URL, {
      method: 'POST',
      headers: {
        'Authorization':    `Bearer ${tempJwt}`,
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: step2Body.toString()
    });

    if (!r2.ok) {
      const text = await r2.text().catch(() => '');
      // 401/403 = code rejected — try next offset
      if (r2.status === 401 || r2.status === 403) continue;
      throw new AgentAuthError(`OTPLoginWithCode HTTP ${r2.status}: ${text.slice(0, 300)}`);
    }
    const d2 = await r2.json().catch(() => null);
    const realJwt = d2 && d2.code;
    if (!realJwt) {
      throw new AgentAuthError('OTPLoginWithCode response missing code: ' + JSON.stringify(d2).slice(0, 300));
    }

    const exp = decodeJwtExp(realJwt) || (nowSec() + 20 * 60);
    console.log('[agent] fresh login succeeded, token exp in', Math.round((exp - nowSec()) / 60), 'min');
    _loginFailureStreak = 0;
    return { code: realJwt, exp };
  }

  throw new AgentAuthError('All TOTP codes rejected. Check AGENT_TOTP_SECRET matches the account.');
}

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
    // If the refresh chain died (wager enforces ~9h max lifetime even with
    // perfect refresh), fall through to a fresh login instead of failing.
    if (err instanceof AgentAuthError) {
      console.log('[agent] refresh rejected (chain expired) — performing fresh login');
      const relogin = await performFreshLogin();
      cachedToken = relogin;
      await saveTokenToMongo(relogin);
      return relogin.code;
    }
    if (secondsLeft > 0) {
      // Transient error (network, etc.) — use current token while it's still
      // valid. Next call will try refresh again.
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
  performFreshLogin,
  generateTotp,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  AgentAuthError,
  AgentApiError
};
