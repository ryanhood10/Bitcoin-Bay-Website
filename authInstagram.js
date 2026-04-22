// ---------------------------------------------------------------------------
// authInstagram.js — Express router for Instagram auth flows.
//
// Two flows live here:
//
//   1) Long-lived OAuth token (Instagram Login flow)
//      - Used by the nightly daily-report collector for own-account metrics.
//      - Token lives in Mongo bcb_auth_tokens { platform: 'instagram' }.
//      - Flow:
//          GET /auth/instagram/connect  → 302 to Instagram authorize
//          GET /auth/instagram/callback → exchange code → short-lived → long-lived token
//
//   2) Scraping session cookie (instaloader-style)
//      - Used by the Pi's Instagram engagement finder to scrape public accounts.
//      - Cookie lives in Mongo bcb_auth_tokens { platform: 'instagram_scrape' }.
//      - Flow:
//          GET  /auth/instagram/scrape-session → instructions + form
//          POST /auth/instagram/scrape-session → validate + save
//
// Also:
//   GET /auth/instagram/status → JSON describing token state (for dashboard)
//
// Auth: `full` role required for connect / callback / scrape-session
// (anything that mints credentials). Read-only status is any admin.
// ---------------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { MongoClient } = require('mongodb');
const adminAuth = require('./adminAuth');

const router = express.Router();

const MONGO_DB    = process.env.MONGO_AUTOMATION_DB || 'bcbay_automation';
const TOKENS_COLL = 'bcb_auth_tokens';

// State store (anti-CSRF for OAuth). In-memory, wiped on dyno restart.
// Heroku dyno lifetime is typically hours; the whole OAuth dance finishes in
// seconds so losing state across restarts is acceptable.
const _oauthStates = new Map();   // state → issuedAt
const STATE_TTL_MS = 15 * 60 * 1000;

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

function isoUTC(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  try { return new Date(d).toISOString(); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Simple HTTPS JSON helper — avoids pulling in a new dep like axios.
// ---------------------------------------------------------------------------
function httpsRequest(method, urlStr, { headers = {}, body, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers,
      timeout,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function formEncode(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// ---------------------------------------------------------------------------
// Error HTML helper — consistent styling with the dashboard theme.
// ---------------------------------------------------------------------------
function errPage(msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Instagram auth error</title>
<style>body{background:#0c0c10;color:#e8e6f0;font-family:system-ui,-apple-system,sans-serif;padding:40px;max-width:640px;margin:0 auto;}
h1{color:#f87171;font-size:20px;margin-bottom:14px;}
.box{background:#131318;border:1px solid #2a2a38;border-radius:10px;padding:20px;}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#9895aa;}
a{color:#EE8034;}</style></head>
<body><div class="box"><h1>Instagram auth failed</h1><pre>${String(msg).slice(0, 600)}</pre>
<p><a href="/auth/instagram/connect">Try again →</a> · <a href="/admin/dashboard">Back to dashboard</a></p></div></body></html>`;
}

// ---------------------------------------------------------------------------
// OAuth — connect + callback
// ---------------------------------------------------------------------------
router.get('/auth/instagram/connect', adminAuth.requireAdmin('full'), (req, res) => {
  const clientId    = process.env.INSTAGRAM_APP_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  const scopes      = process.env.INSTAGRAM_SCOPES ||
    'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_manage_insights';

  if (!clientId || !redirectUri) {
    return res.status(500).type('html').send(errPage(
      'INSTAGRAM_APP_ID or INSTAGRAM_REDIRECT_URI not configured in Heroku env.',
    ));
  }

  const state = crypto.randomBytes(24).toString('base64url');
  _oauthStates.set(state, Date.now());

  // Cleanup old states
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of _oauthStates) if (v < cutoff) _oauthStates.delete(k);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state,
    force_reauth: 'true',
  });
  res.redirect(`https://www.instagram.com/oauth/authorize?${params.toString()}`);
});

router.get('/auth/instagram/callback', async (req, res) => {
  // NOTE: no auth middleware here — Instagram's IDP redirects here without a
  // bcb_admin cookie. The state param prevents forged callbacks.
  const { error, error_description, code, state } = req.query;
  if (error) return res.status(400).type('html').send(errPage(`Instagram returned error: ${error} — ${error_description || ''}`));
  if (!code || !state) return res.status(400).type('html').send(errPage('Missing ?code or ?state in callback.'));
  if (!_oauthStates.has(state)) return res.status(400).type('html').send(errPage('State mismatch or expired — start again from /auth/instagram/connect.'));
  _oauthStates.delete(state);

  const clientId = process.env.INSTAGRAM_APP_ID;
  const clientSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).type('html').send(errPage('Instagram OAuth env vars not set.'));
  }

  // 1) code → short-lived token
  let shortToken, igUserId, permissions;
  try {
    const r = await httpsRequest('POST', 'https://api.instagram.com/oauth/access_token', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (r.status >= 400) return res.status(500).type('html').send(errPage(`Short-lived token exchange failed (${r.status}): ${r.body.slice(0, 300)}`));
    const j = JSON.parse(r.body);
    shortToken = j.access_token;
    igUserId = j.user_id;
    permissions = j.permissions || [];
    if (!shortToken) return res.status(500).type('html').send(errPage(`No access_token in response: ${r.body.slice(0, 300)}`));
  } catch (e) {
    return res.status(500).type('html').send(errPage(`Short-lived exchange error: ${e.message}`));
  }

  // 2) short-lived → long-lived (60-day)
  let longToken, expiresIn, tokenType;
  try {
    const url = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(clientSecret)}&access_token=${encodeURIComponent(shortToken)}`;
    const r = await httpsRequest('GET', url);
    if (r.status >= 400) return res.status(500).type('html').send(errPage(`Long-lived token exchange failed (${r.status}): ${r.body.slice(0, 300)}`));
    const j = JSON.parse(r.body);
    longToken = j.access_token;
    expiresIn = parseInt(j.expires_in, 10) || (60 * 24 * 3600);
    tokenType = j.token_type || 'bearer';
    if (!longToken) return res.status(500).type('html').send(errPage(`No long-lived access_token in response: ${r.body.slice(0, 300)}`));
  } catch (e) {
    return res.status(500).type('html').send(errPage(`Long-lived exchange error: ${e.message}`));
  }

  // 3) Persist in Mongo
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  try {
    await withDb((db) =>
      db.collection(TOKENS_COLL).updateOne(
        { platform: 'instagram' },
        { $set: {
            platform: 'instagram',
            access_token: longToken,
            token_type: tokenType,
            ig_user_id: igUserId ? String(igUserId) : null,
            permissions,
            scopes_requested: process.env.INSTAGRAM_SCOPES,
            obtained_at: now,
            expires_at: expiresAt,
          } },
        { upsert: true },
      ),
    );
  } catch (e) {
    return res.status(500).type('html').send(errPage(`Saved token but failed to persist to Mongo: ${e.message}`));
  }

  // 4) Success page
  const daysValid = Math.round((expiresIn / 86400) * 10) / 10;
  const expiresHuman = expiresAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const handle = process.env.INSTAGRAM_ACCOUNT_HANDLE || '?';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Instagram connected</title>
<style>body{background:#0c0c10;color:#e8e6f0;font-family:system-ui,-apple-system,sans-serif;padding:40px;max-width:640px;margin:0 auto;}
h1{color:#34d399;font-size:22px;margin-bottom:16px;}
.box{background:#131318;border:1px solid #2a2a38;border-radius:10px;padding:24px;}
.kv{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #2a2a38;font-size:13px;}
.kv:last-child{border-bottom:none;}.k{color:#9895aa;}.v{color:#e8e6f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
a{color:#EE8034;}</style></head>
<body><div class="box"><h1>✓ Instagram connected</h1>
<div class="kv"><span class="k">Account</span><span class="v">@${handle}</span></div>
<div class="kv"><span class="k">IG user ID</span><span class="v">${igUserId || '?'}</span></div>
<div class="kv"><span class="k">Token expires</span><span class="v">${expiresHuman} (${daysValid} days)</span></div>
<div class="kv"><span class="k">Permissions</span><span class="v">${permissions.join(', ') || '—'}</span></div>
<p style="margin-top:18px;"><a href="/admin/dashboard">← back to dashboard</a></p></div></body></html>`);
});

router.get('/auth/instagram/status', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const doc = await withDb((db) =>
      db.collection(TOKENS_COLL).findOne({ platform: 'instagram' }, { projection: { access_token: 0 } }),
    );
    if (!doc) return res.json({ connected: false });
    const expiresAt = doc.expires_at;
    const expiresInDays = expiresAt ? Math.floor((expiresAt - Date.now()) / 86400000) : null;
    res.json({
      connected: true,
      ig_user_id: doc.ig_user_id,
      permissions: doc.permissions || [],
      obtained_at: isoUTC(doc.obtained_at),
      expires_at: isoUTC(doc.expires_at),
      expires_in_days: expiresInDays,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Scrape-session (instaloader sessionid cookie)
// ---------------------------------------------------------------------------
router.get('/auth/instagram/scrape-session', adminAuth.requireAdmin('full'), async (req, res) => {
  let installed = null;
  try {
    installed = await withDb((db) =>
      db.collection(TOKENS_COLL).findOne({ platform: 'instagram_scrape' }, { projection: { cookie_sessionid: 0 } }),
    );
  } catch (_) {}
  const installedHtml = installed ? `
    <div class="box" style="border-color:rgba(52,211,153,0.35); background:rgba(52,211,153,0.05);">
      <div style="color:#34d399;font-weight:700;margin-bottom:6px;">✓ Session currently installed</div>
      <div style="font-size:12px;color:#9895aa;">Handle: @${installed.handle || '?'} · installed ${isoUTC(installed.obtained_at) || '?'}</div>
      <div style="font-size:12px;color:#5a5870;margin-top:4px;">If post discovery has started failing, refresh below.</div>
    </div>` : '';

  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Instagram session · bcbay-dashboard</title>
<style>
body{background:#0c0c10;color:#e8e6f0;font-family:system-ui,-apple-system,sans-serif;padding:40px;max-width:720px;margin:0 auto;line-height:1.55;}
h1{font-size:22px;margin-bottom:18px;}
h2{font-size:14px;color:#EE8034;margin:22px 0 8px;text-transform:uppercase;letter-spacing:0.06em;}
.box{background:#131318;border:1px solid #2a2a38;border-radius:10px;padding:20px;margin-bottom:16px;}
ol{padding-left:22px;}
ol li{margin-bottom:10px;font-size:14px;}
code{background:#1a1a22;padding:2px 6px;border-radius:4px;font-size:12px;color:#e8e6f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
input[type=text]{width:100%;padding:10px 12px;background:#0c0c10;border:1px solid #353548;color:#e8e6f0;border-radius:7px;font-family:ui-monospace,monospace;font-size:12px;}
button{margin-top:12px;padding:10px 18px;background:#EE8034;color:#fff;border:none;border-radius:7px;font-weight:700;cursor:pointer;font-size:13px;}
button:hover{background:#d4691c;}
.muted{color:#5a5870;font-size:12px;}
a{color:#EE8034;}
</style></head><body>
<h1>Instagram session (instaloader)</h1>
${installedHtml}
<div class="box">
<h2>Why you might be here</h2>
<p>Post discovery uses the <code>sessionid</code> cookie from an active Instagram browser session. The cookie typically lasts 1–3 months before Instagram rotates it. When that happens, scraping fails and you install a fresh one below.</p>
</div>
<div class="box">
<h2>How to get a fresh sessionid</h2>
<ol>
<li>Open <a href="https://www.instagram.com" target="_blank" rel="noopener">instagram.com</a> in your browser, logged in as <strong>@${process.env.INSTAGRAM_ACCOUNT_HANDLE || 'bitcoin_bay'}</strong>.</li>
<li>Open DevTools: <code>⌘+Option+I</code> (Mac Chrome/Safari) or <code>Ctrl+Shift+I</code> (Windows/Linux).</li>
<li>Chrome: <strong>Application</strong> → <strong>Cookies</strong> → <code>https://www.instagram.com</code>.<br>Firefox: <strong>Storage</strong> → <strong>Cookies</strong> → <code>https://www.instagram.com</code>.</li>
<li>Find <code>sessionid</code> and copy its full <strong>Value</strong>.</li>
<li>Paste below and click <strong>Install</strong>.</li>
</ol>
<p class="muted"><strong>Security:</strong> this cookie is effectively an Instagram login. Anyone with it can act as the account. It's stored in Mongo only — never in git.</p>
</div>
<div class="box">
<h2>Install / refresh</h2>
<form id="ig-form">
  <label style="font-size:12px;color:#9895aa;">sessionid cookie value</label>
  <input type="text" name="sessionid" id="sessionid" autocomplete="off" spellcheck="false" placeholder="e.g. 53478764866%3A...">
  <button type="submit">Install</button>
  <div id="result" style="margin-top:14px;font-size:13px;"></div>
</form>
</div>
<p class="muted"><a href="/admin/dashboard">← back to dashboard</a></p>
<script>
document.getElementById('ig-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = document.getElementById('sessionid').value.trim();
  const result = document.getElementById('result');
  if (!val) { result.innerHTML = '<span style="color:#f87171;">Paste a sessionid first.</span>'; return; }
  result.innerHTML = '<span style="color:#9895aa;">Validating…</span>';
  try {
    const res = await fetch('/auth/instagram/scrape-session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionid: val}),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      result.innerHTML = '<span style="color:#f87171;">Failed: ' + (json.error || 'unknown') + '</span>';
    } else {
      result.innerHTML = '<span style="color:#34d399;">✓ Installed. You can close this tab.</span>';
    }
  } catch(e) {
    result.innerHTML = '<span style="color:#f87171;">Request error: ' + e.message + '</span>';
  }
});
</script>
</body></html>`);
});

router.post('/auth/instagram/scrape-session', adminAuth.requireAdmin('full'), express.json(), async (req, res) => {
  try {
    const sid = (req.body && req.body.sessionid) ? String(req.body.sessionid).trim() : '';
    if (!sid) return res.status(400).json({ error: 'sessionid required' });
    const handle = process.env.INSTAGRAM_ACCOUNT_HANDLE || 'bitcoin_bay';

    // Basic validation: hit instagram.com with the cookie and look for 200.
    // IG's private API endpoints are more stable than the web pages for this.
    let validationOk = false;
    let validationDetail = '';
    try {
      const r = await httpsRequest('GET', `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, {
        headers: {
          'Cookie': `sessionid=${sid}`,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'X-IG-App-ID': '936619743392459',  // public "web" app id used by the Instagram web client
        },
      });
      if (r.status === 200 && r.body.includes('"user"')) {
        validationOk = true;
      } else {
        validationDetail = `HTTP ${r.status}: ${r.body.slice(0, 120)}`;
      }
    } catch (e) {
      validationDetail = `network: ${e.message}`;
    }
    if (!validationOk) {
      return res.status(400).json({ error: `cookie validation failed — ${validationDetail}` });
    }

    const now = new Date();
    await withDb((db) =>
      db.collection(TOKENS_COLL).updateOne(
        { platform: 'instagram_scrape' },
        { $set: {
            platform: 'instagram_scrape',
            handle,
            cookie_sessionid: sid,
            obtained_at: now,
            last_validated_at: now,
          } },
        { upsert: true },
      ),
    );
    res.json({ ok: true, handle });
  } catch (e) {
    console.error('[auth/instagram/scrape-session POST] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
