// ---------------------------------------------------------------------------
// adminMessages.js — Express router for the private messaging dashboard.
//
// Routes:
//   GET  /admin/login              — login page
//   POST /admin/login              — verify creds, set signed cookie
//   POST /admin/logout             — clear cookie
//   GET  /admin/messages           — dashboard (HTML shell, hydrates via JSON)
//   GET  /api/admin/threads        — JSON: list of player threads (most-recent first)
//   GET  /api/admin/thread/:player — JSON: one player's full conversation
//   POST /api/admin/reply          — send reply to player via wager API
//   POST /api/admin/sync           — force a sync poll (debug / "refresh now")
//
// Auth model: single admin user, env-configured.
//   - ADMIN_USERNAME       (e.g. "ryan")
//   - ADMIN_PASSWORD_HASH  (bcrypt of the chosen password)
//   - ADMIN_SESSION_SECRET (random 32+ chars, used for HMAC-signed cookie)
//
// We don't need server-side sessions for one user — a signed cookie carrying
// { user, exp } is enough. HMAC prevents tampering; expiry prevents replay.
//
// All admin routes are HTTPS-only in production via cookie `secure` flag.
// ---------------------------------------------------------------------------

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const agentClient = require('./agentClient');
const messagesSync = require('./messagesSync');

const router = express.Router();

const COOKIE_NAME       = 'bcb_admin';
const COOKIE_TTL_MS     = 30 * 24 * 60 * 60 * 1000;
const MONGO_DB          = 'bcbay_automation';
const MESSAGES_COLL     = 'bcb_messages';
const PLAYERS_COLL      = 'bcb_player_info';
const THREAD_STATE_COLL = 'bcb_thread_state';
const ADMIN_LOG_COLL    = 'bcb_admin_log';
const REPLY_RATE_LIMIT  = 30;        // max replies per session per hour
const REPLY_RATE_WIN_MS = 60 * 60 * 1000;
const PLAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// In-memory rate-limit counter — a session sending 30+ replies/hr is almost
// certainly a runaway script, not the brother. Wipe on restart is fine.
const _replyCounts = new Map();   // key: admin user, val: [...timestamps]

// ---------------------------------------------------------------------------
// Cookie signing — HMAC-SHA256 over the JSON payload.
// ---------------------------------------------------------------------------
function getSessionSecret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 24) {
    console.warn('[admin] ADMIN_SESSION_SECRET missing or short — admin auth WILL be insecure until set');
    return 'INSECURE-DEV-DEFAULT-CHANGE-ME-IN-HEROKU-CONFIG';
  }
  return s;
}

function signCookie(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(json).digest('base64url');
  return `${json}.${sig}`;
}

function verifyCookie(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('.')) return null;
  const [json, sig] = raw.split('.');
  if (!json || !sig) return null;
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(json).digest('base64url');
  // Constant-time compare to avoid timing leaks.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function setSessionCookie(res, user) {
  const payload = { user, iat: Date.now(), exp: Date.now() + COOKIE_TTL_MS };
  res.cookie(COOKIE_NAME, signCookie(payload), {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   COOKIE_TTL_MS,
    path:     '/',
  });
}

function requireAdmin(req, res, next) {
  const session = verifyCookie(req.cookies && req.cookies[COOKIE_NAME]);
  if (!session) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Not signed in' });
    }
    return res.redirect('/admin/login');
  }
  req.admin = session;
  next();
}

// ---------------------------------------------------------------------------
// Audit logging for sensitive admin actions.
// ---------------------------------------------------------------------------
async function logAdminAction(record) {
  if (!process.env.MONGO_URI) return;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db(MONGO_DB).collection(ADMIN_LOG_COLL).insertOne({
      ...record,
      created_at: new Date(),
    });
  } catch (err) {
    console.error('[admin] log failed:', err.message);
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// LOGIN PAGE + POST
// ---------------------------------------------------------------------------
function loginPage(error) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Admin · Bitcoin Bay</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,sans-serif;background:radial-gradient(at 60% 0%,#0E2245 0%,#091830 45%,#071225 100%);color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#0D2240;border:1px solid rgba(86,204,242,0.1);border-radius:16px;padding:40px;width:100%;max-width:380px}
h1{font-size:22px;margin-bottom:8px;background:linear-gradient(135deg,#F7941D,#F26522);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p.sub{color:#6B8DB5;font-size:13px;margin-bottom:24px}
label{display:block;font-size:12px;color:#B0C4DE;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em}
input{width:100%;background:#0A1628;border:1px solid rgba(86,204,242,0.15);border-radius:8px;padding:12px 14px;color:#fff;font-size:15px;margin-bottom:16px;font-family:inherit}
input:focus{outline:none;border-color:#F7941D}
button{width:100%;background:linear-gradient(135deg,#F7941D,#F26522);color:#0A1628;font-weight:800;font-size:15px;padding:14px;border:none;border-radius:9999px;cursor:pointer;font-family:inherit}
button:hover{opacity:0.9}
.err{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#FCA5A5;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px}
</style></head><body><div class="card">
<h1>Bitcoin Bay Admin</h1>
<p class="sub">Player messaging dashboard</p>
${error ? `<div class="err">${error}</div>` : ''}
<form method="POST" action="/admin/login">
  <label for="u">Username</label>
  <input id="u" type="text" name="username" autocomplete="username" required autofocus>
  <label for="p">Password</label>
  <input id="p" type="password" name="password" autocomplete="current-password" required>
  <button type="submit">Sign In</button>
</form>
</div></body></html>`;
}

router.get('/admin/login', (req, res) => {
  res.type('html').send(loginPage(null));
});

router.post('/admin/login', express.urlencoded({ extended: false }), async (req, res) => {
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;

  if (!expectedUser || !expectedHash) {
    console.error('[admin] ADMIN_USERNAME or ADMIN_PASSWORD_HASH not configured');
    return res.status(500).type('html').send(loginPage('Admin login is not configured. Contact the site owner.'));
  }

  if (!username || !password) {
    return res.status(400).type('html').send(loginPage('Username and password required.'));
  }

  // Constant-time username compare to limit username enumeration.
  const userOk = username.length === expectedUser.length &&
                 crypto.timingSafeEqual(Buffer.from(username), Buffer.from(expectedUser));

  let passOk = false;
  try { passOk = await bcrypt.compare(password, expectedHash); } catch (_) { passOk = false; }

  if (!userOk || !passOk) {
    await logAdminAction({ action: 'login_fail', username_attempt: username, remote_ip: remoteIp });
    // Always run a bcrypt round on failure too, so timing doesn't reveal whether
    // it was the username that was wrong.
    if (userOk === false && passOk === false) {
      try { await bcrypt.compare('dummy', '$2b$12$abcdefghijklmnopqrstuv'); } catch (_) {}
    }
    return res.status(401).type('html').send(loginPage('Wrong username or password.'));
  }

  setSessionCookie(res, username);
  await logAdminAction({ action: 'login_ok', username, remote_ip: remoteIp });
  res.redirect('/admin/messages');
});

router.post('/admin/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.redirect('/admin/login');
});

// ---------------------------------------------------------------------------
// DASHBOARD HTML SHELL
// ---------------------------------------------------------------------------
router.get('/admin/messages', requireAdmin, (req, res) => {
  res.type('html').send(dashboardHtml(req.admin.user));
});

function dashboardHtml(user) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Messages · Admin · Bitcoin Bay</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#F7941D;--orange:#F26522;
  --bg:#071225;--panel:#0D2240;--panel-2:#0A1A33;--panel-3:#101F38;
  --border:rgba(86,204,242,0.1);--border-strong:rgba(86,204,242,0.2);
  --text:#fff;--text-2:#B0C4DE;--text-3:#6B8DB5;--text-4:#4A6685;
  --green:#22C55E;--red:#EF4444;
}
html,body{height:100%}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:radial-gradient(at 60% 0%,#0E2245 0%,#091830 45%,#071225 100%);color:var(--text);overflow:hidden;font-size:14px;-webkit-font-smoothing:antialiased}
button{font-family:inherit}

header{height:52px;display:flex;align-items:center;padding:0 18px;border-bottom:1px solid var(--border);background:var(--panel-2);gap:14px}
header .brand{font-weight:800;font-size:13px;background:linear-gradient(135deg,var(--gold),var(--orange));-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:0.02em}
header .who{margin-left:auto;color:var(--text-3);font-size:12px}
header .who strong{color:var(--text-2);font-weight:600}
header form{display:inline}
header button{background:transparent;border:1px solid var(--border);color:var(--text-2);font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer}
header button:hover{border-color:var(--gold);color:var(--gold)}

.layout{display:grid;grid-template-columns:340px 1fr;height:calc(100% - 52px)}

/* Thread list */
.threads{border-right:1px solid var(--border);overflow-y:auto;background:var(--panel-2)}
.threads-header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.06em;background:var(--panel-2)}
.threads-header .count{background:var(--panel);padding:2px 8px;border-radius:9999px;font-size:11px;color:var(--text-2);font-weight:600}
.threads-header .spacer{flex:1}
.threads-header .icon-btn{background:transparent;border:1px solid var(--border);color:var(--text-3);font-size:11px;padding:5px 10px;border-radius:6px;cursor:pointer;text-transform:none;letter-spacing:0;display:inline-flex;align-items:center;gap:4px}
.threads-header .icon-btn:hover{color:var(--gold);border-color:var(--gold)}
.threads-header .icon-btn.toggle.active{color:var(--gold);border-color:var(--gold);background:rgba(247,148,29,0.05)}
.thread{padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s;position:relative}
.thread:hover{background:rgba(86,204,242,0.04)}
.thread:hover .thread-actions{opacity:1}
.thread.active{background:rgba(247,148,29,0.08);border-left:3px solid var(--gold);padding-left:11px}
.thread.resolved{opacity:0.5}
.thread .top{display:flex;align-items:baseline;gap:8px;margin-bottom:3px}
.thread .id{font-family:'SF Mono','Menlo','Courier New',monospace;font-weight:700;color:var(--gold);font-size:13px}
.thread .name{color:var(--text-2);font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}
.thread .when{margin-left:auto;color:var(--text-3);font-size:11px;flex-shrink:0}
.thread .preview{color:var(--text-2);font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.thread .preview .you{color:var(--text-3)}
.thread .badge{display:inline-block;background:var(--gold);color:var(--bg);font-size:10px;font-weight:800;padding:1px 6px;border-radius:9999px;margin-left:4px;vertical-align:middle;line-height:1.4}
.thread .resolved-tag{display:inline-block;background:rgba(34,197,94,0.15);color:var(--green);font-size:10px;font-weight:700;padding:1px 6px;border-radius:9999px;margin-left:4px;vertical-align:middle;line-height:1.4}
.thread-actions{position:absolute;right:8px;top:8px;opacity:0;transition:opacity 0.1s}
.thread-actions button{background:var(--panel);border:1px solid var(--border-strong);color:var(--text-2);font-size:10px;padding:3px 8px;border-radius:6px;cursor:pointer;text-transform:uppercase;letter-spacing:0.04em}
.thread-actions button:hover{border-color:var(--green);color:var(--green)}
.empty{color:var(--text-3);text-align:center;padding:60px 20px;font-size:13px;line-height:1.6}
.empty .small{color:var(--text-4);font-size:12px;margin-top:8px}

/* Conversation pane */
.convo{display:flex;flex-direction:column;overflow:hidden;background:var(--panel-3)}
.convo-header{padding:14px 22px;border-bottom:1px solid var(--border);background:var(--panel-2);display:flex;align-items:center;gap:14px;flex-shrink:0;min-height:64px}
.convo-header .pid{font-family:'SF Mono','Menlo','Courier New',monospace;font-size:15px;font-weight:700;color:var(--gold);letter-spacing:0.02em}
.convo-header .name{font-size:14px;color:var(--text);font-weight:600;margin-top:2px}
.convo-header .contact{font-size:12px;color:var(--text-3);margin-top:2px;display:flex;gap:14px;flex-wrap:wrap}
.convo-header .contact a{color:var(--text-3);text-decoration:none}
.convo-header .contact a:hover{color:var(--gold)}
.convo-header .actions{margin-left:auto;display:flex;gap:8px;flex-shrink:0}
.convo-header .actions button{background:transparent;border:1px solid var(--border-strong);color:var(--text-2);font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.convo-header .actions button.primary{border-color:rgba(34,197,94,0.4);color:var(--green)}
.convo-header .actions button.primary:hover{background:rgba(34,197,94,0.08);border-color:var(--green)}
.convo-header .actions button.primary.resolved{border-color:var(--green);background:rgba(34,197,94,0.12)}
.convo-header .actions button:hover{border-color:var(--gold);color:var(--gold)}
.convo-body{flex:1;overflow-y:auto;padding:24px 24px 8px;scroll-behavior:smooth}
.day-divider{display:flex;align-items:center;gap:12px;color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin:24px 0 16px}
.day-divider::before,.day-divider::after{content:'';flex:1;height:1px;background:var(--border)}
.day-divider:first-child{margin-top:0}

.msg{max-width:75%;margin-bottom:14px;padding:11px 15px;border-radius:14px;font-size:14px;line-height:1.55;word-wrap:break-word;position:relative}
.msg .label{font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-3);margin-bottom:4px;font-weight:700;display:flex;align-items:center;gap:5px}
.msg .meta{font-size:11px;color:var(--text-3);margin-top:6px;cursor:help}
.msg .body{white-space:pre-wrap}
.msg.from-player{background:var(--panel);border:1px solid var(--border)}
.msg.from-agent{background:linear-gradient(135deg,rgba(247,148,29,0.18),rgba(242,101,34,0.12));border:1px solid rgba(247,148,29,0.25);margin-left:auto}
.msg.from-master{background:rgba(86,204,242,0.06);border:1px solid rgba(86,204,242,0.15);font-size:13px;opacity:0.85}
.msg.from-master .body{color:var(--text-2)}

/* Compose */
.compose{border-top:1px solid var(--border);padding:14px 22px 16px;background:var(--panel-2);flex-shrink:0}
.compose-wrap{position:relative;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg);transition:border-color 0.15s}
.compose-wrap:focus-within{border-color:var(--gold)}
.compose textarea{width:100%;min-height:48px;max-height:240px;background:transparent;border:none;padding:12px 14px;color:var(--text);font-size:14px;line-height:1.5;font-family:inherit;resize:none;outline:none}
.compose textarea::placeholder{color:var(--text-4)}
.compose-bar{display:flex;align-items:center;gap:10px;padding:6px 10px 8px 14px;border-top:1px solid var(--border)}
.compose-bar .hint{font-size:11px;color:var(--text-4)}
.compose-bar .hint kbd{background:var(--panel-2);border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:10px;font-family:'SF Mono','Menlo',monospace;color:var(--text-3)}
.compose-bar .status{margin-left:auto;font-size:12px;color:var(--text-3);transition:color 0.15s}
.compose-bar button{background:linear-gradient(135deg,var(--gold),var(--orange));color:var(--bg);font-weight:800;font-size:13px;padding:8px 22px;border:none;border-radius:8px;cursor:pointer;transition:opacity 0.1s}
.compose-bar button:hover:not(:disabled){opacity:0.92}
.compose-bar button:disabled{opacity:0.4;cursor:not-allowed}

.placeholder{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-3);font-size:14px;text-align:center;padding:24px;gap:8px}
.placeholder .big{font-size:32px;opacity:0.4}

@media(max-width:760px){
  .layout{grid-template-columns:1fr}
  .threads{display:block}
  .convo{display:none}
  body.show-convo .threads{display:none}
  body.show-convo .convo{display:flex}
  .back-btn{display:inline-flex !important}
  .convo-header{padding:10px 14px}
  .convo-body{padding:16px 14px 4px}
  .compose{padding:10px 14px 14px}
  .msg{max-width:85%}
}
.back-btn{display:none;background:transparent;border:1px solid var(--border-strong);color:var(--text-2);font-size:14px;padding:6px 10px;border-radius:6px;cursor:pointer;align-items:center;justify-content:center;width:32px;height:32px;flex-shrink:0}
</style></head><body>
<header>
  <span class="brand">BITCOIN BAY · ADMIN</span>
  <span class="who">Signed in as <strong>${user}</strong></span>
  <form method="POST" action="/admin/logout"><button>Sign out</button></form>
</header>
<div class="layout">
  <aside class="threads">
    <div class="threads-header">
      <span>Conversations</span>
      <span class="count" id="thread-count">0</span>
      <span class="spacer"></span>
      <button type="button" class="icon-btn toggle" id="toggle-resolved" title="Toggle resolved threads">Hide Completed</button>
      <button type="button" class="icon-btn" id="refresh-btn" title="Pull latest from wager">↻</button>
    </div>
    <div id="thread-list"><div class="empty">Loading…</div></div>
  </aside>
  <main class="convo">
    <div id="convo-empty" class="placeholder">
      <div class="big">💬</div>
      <div>Select a conversation</div>
    </div>
    <div id="convo-content" style="display:none;flex:1;flex-direction:column;overflow:hidden">
      <div class="convo-header">
        <button type="button" class="back-btn" id="back-btn">←</button>
        <div style="flex:1;min-width:0">
          <div class="pid" id="convo-pid"></div>
          <div class="name" id="convo-name" style="display:none"></div>
          <div class="contact" id="convo-contact"></div>
        </div>
        <div class="actions">
          <button type="button" id="resolve-btn" class="primary"><span id="resolve-icon">✓</span> <span id="resolve-label">Mark Done</span></button>
        </div>
      </div>
      <div class="convo-body" id="convo-body"></div>
      <form class="compose" id="reply-form">
        <div class="compose-wrap">
          <textarea id="reply-text" placeholder="Type your reply…" required rows="1"></textarea>
          <div class="compose-bar">
            <span class="hint"><kbd>⌘</kbd> + <kbd>Enter</kbd> to send</span>
            <span class="status" id="reply-status"></span>
            <button type="submit" id="reply-btn">Send</button>
          </div>
        </div>
      </form>
    </div>
  </main>
</div>
<script>
let activePlayer = null;
let threads = [];
let currentThread = null;
let showResolved = false;

// ---------- Time formatting (local TZ) ----------
const dayMs = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

function fmtTimeShort(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  const today = startOfDay(now).getTime();
  const dtDay = startOfDay(dt).getTime();
  const diffMs = now.getTime() - dt.getTime();
  if (diffMs < 0) return dt.toLocaleString();
  if (diffMs < 60000) return 'now';
  if (diffMs < 3600000) return Math.floor(diffMs/60000) + 'm';
  if (dtDay === today) return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (today - dtDay === dayMs) return 'Yesterday';
  if (now.getTime() - dt.getTime() < 7 * dayMs) return dt.toLocaleDateString('en-US', { weekday: 'short' });
  if (dt.getFullYear() === now.getFullYear()) return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function fmtDayLabel(d) {
  const dt = new Date(d);
  const now = new Date();
  const today = startOfDay(now).getTime();
  const dtDay = startOfDay(dt).getTime();
  if (dtDay === today) return 'Today';
  if (today - dtDay === dayMs) return 'Yesterday';
  if (now.getTime() - dt.getTime() < 7 * dayMs) {
    return dt.toLocaleDateString('en-US', { weekday: 'long' });
  }
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric',
    year: dt.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function fmtTimeOfDay(d) {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtFull(d) {
  return new Date(d).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function stripHtml(s) {
  return String(s||'').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
}

// ---------- Thread list ----------
async function loadThreads() {
  const url = '/api/admin/threads' + (showResolved ? '?include_resolved=1' : '');
  const r = await fetch(url);
  if (!r.ok) { document.getElementById('thread-list').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
  const data = await r.json();
  threads = data.threads || [];
  renderThreads(data.resolved_hidden || 0);
}

function renderThreads(hiddenCount) {
  document.getElementById('thread-count').textContent = threads.length;
  const list = document.getElementById('thread-list');
  if (!threads.length) {
    const hint = hiddenCount > 0
      ? '<div class="small">' + hiddenCount + ' completed thread' + (hiddenCount === 1 ? '' : 's') + ' hidden — click "Hide Completed" to show.</div>'
      : '<div class="small">New player messages will appear here automatically.</div>';
    list.innerHTML = '<div class="empty">No active conversations.' + hint + '</div>';
    return;
  }
  list.innerHTML = threads.map(t => {
    const isActive = activePlayer === t.player_id;
    const unreadBadge = t.unread_player ? '<span class="badge">' + t.unread_player + '</span>' : '';
    const resolvedBadge = t.resolved ? '<span class="resolved-tag">Done</span>' : '';
    const namePart = t.display_name ? '<span class="name">· ' + escapeHtml(t.display_name) + '</span>' : '';
    const previewPrefix = t.last_direction === 'outbound' ? '<span class="you">You: </span>' : '';
    return '<div class="thread' + (isActive ? ' active' : '') + (t.resolved ? ' resolved' : '') + '" data-player="' + escapeHtml(t.player_id) + '" title="' + escapeHtml(t.last_at ? fmtFull(t.last_at) : '') + '">' +
      '<div class="top">' +
        '<span class="id">' + escapeHtml(t.player_id) + '</span>' + namePart + unreadBadge + resolvedBadge +
        '<span class="when">' + fmtTimeShort(t.last_at) + '</span>' +
      '</div>' +
      '<div class="preview">' + previewPrefix + escapeHtml(stripHtml(t.last_preview)) + '</div>' +
      (t.resolved ? '' : '<div class="thread-actions"><button data-act="resolve" data-player="' + escapeHtml(t.player_id) + '">✓ Done</button></div>') +
    '</div>';
  }).join('');
  list.querySelectorAll('.thread').forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.thread-actions')) return;
      openThread(el.dataset.player);
    });
  });
  list.querySelectorAll('.thread-actions button').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await markResolved(btn.dataset.player, true);
    });
  });
}

// ---------- Conversation view ----------
async function openThread(playerId) {
  activePlayer = playerId;
  renderThreads();
  document.body.classList.add('show-convo');
  document.getElementById('convo-empty').style.display = 'none';
  document.getElementById('convo-content').style.display = 'flex';
  document.getElementById('convo-pid').textContent = playerId;
  document.getElementById('convo-name').style.display = 'none';
  document.getElementById('convo-contact').textContent = 'Loading…';
  document.getElementById('convo-body').innerHTML = '';

  const r = await fetch('/api/admin/thread/' + encodeURIComponent(playerId));
  if (!r.ok) { document.getElementById('convo-contact').textContent = 'Failed to load.'; return; }
  const data = await r.json();
  currentThread = data;

  // Header: name, contact info
  const p = data.player;
  if (p && (p.name_first || p.name_last)) {
    const nameEl = document.getElementById('convo-name');
    nameEl.textContent = [p.name_first, p.name_last].filter(Boolean).join(' ');
    nameEl.style.display = 'block';
  }
  const contactEl = document.getElementById('convo-contact');
  const parts = [];
  if (p && p.phone) parts.push('<a href="tel:' + escapeHtml(p.phone.replace(/[^0-9+]/g,'')) + '">📞 ' + escapeHtml(p.phone) + '</a>');
  if (p && p.email) parts.push('<a href="mailto:' + escapeHtml(p.email) + '">✉ ' + escapeHtml(p.email) + '</a>');
  parts.push('<span>' + (data.messages || []).length + ' messages</span>');
  contactEl.innerHTML = parts.join('');

  // Resolve button state
  updateResolveButton(data.resolved);

  // Messages with day dividers
  const body = document.getElementById('convo-body');
  let lastDay = null;
  const html = (data.messages || []).map(m => {
    const dt = m.date_mail || m.created_at || m.seen_at;
    const dayKey = dt ? startOfDay(new Date(dt)).getTime() : 0;
    const divider = (dayKey !== lastDay)
      ? '<div class="day-divider">' + escapeHtml(dt ? fmtDayLabel(dt) : '') + '</div>'
      : '';
    lastDay = dayKey;

    let cls = 'from-master';
    let label = m.from_login || 'Unknown';
    if (m.is_player_message || (m.from_type === 'C' && m.direction === 'inbound')) {
      cls = 'from-player';
      const who = (p && (p.name_first || p.name_last))
        ? [p.name_first, p.name_last].filter(Boolean).join(' ')
        : (m.from_login || 'Player');
      label = '👤 ' + who;
    } else if (m.direction === 'outbound') {
      cls = 'from-agent';
      label = '✉ You' + (m.sent_by ? ' (' + escapeHtml(m.sent_by) + ')' : '');
    } else if ((m.from_login || '').toUpperCase() === 'MY AGENT') {
      cls = 'from-master';
      label = '🏢 Upstream notice';
    } else {
      cls = 'from-agent';
      label = '✉ ' + escapeHtml(m.from_login || '');
    }

    const rawBody = (m.body || '').replace(/<br\\s*\\/?>/gi, '\\n');
    const subj = m.subject && m.subject !== playerId && (m.from_login || '').toUpperCase() === 'MY AGENT'
      ? '<strong style="color:var(--text-2)">' + escapeHtml(m.subject) + '</strong><br>' : '';

    return divider + '<div class="msg ' + cls + '">' +
      '<div class="label">' + label + '</div>' +
      '<div class="body">' + subj + escapeHtml(stripHtml(rawBody)) + '</div>' +
      '<div class="meta" title="' + escapeHtml(dt ? fmtFull(dt) : '') + '">' + (dt ? fmtTimeOfDay(dt) : '') + '</div>' +
    '</div>';
  }).join('');
  body.innerHTML = html || '<div class="empty">No messages yet.</div>';
  body.scrollTop = body.scrollHeight;
  autoResizeTextarea();
}

function updateResolveButton(resolved) {
  const btn = document.getElementById('resolve-btn');
  const icon = document.getElementById('resolve-icon');
  const label = document.getElementById('resolve-label');
  if (resolved) {
    btn.classList.add('resolved');
    icon.textContent = '↺';
    label.textContent = 'Reopen';
  } else {
    btn.classList.remove('resolved');
    icon.textContent = '✓';
    label.textContent = 'Mark Done';
  }
}

async function markResolved(playerId, resolved) {
  const url = '/api/admin/thread/' + encodeURIComponent(playerId) + (resolved ? '/resolve' : '/unresolve');
  await fetch(url, { method: 'POST' });
  if (currentThread && currentThread.player_id === playerId) {
    currentThread.resolved = resolved;
    updateResolveButton(resolved);
  }
  if (resolved && activePlayer === playerId && !showResolved) {
    activePlayer = null;
    document.getElementById('convo-content').style.display = 'none';
    document.getElementById('convo-empty').style.display = 'flex';
    document.body.classList.remove('show-convo');
  }
  await loadThreads();
}

// ---------- Compose ----------
function autoResizeTextarea() {
  const ta = document.getElementById('reply-text');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

document.getElementById('reply-text').addEventListener('input', autoResizeTextarea);
document.getElementById('reply-text').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('reply-form').requestSubmit();
  }
});

document.getElementById('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activePlayer) return;
  const ta = document.getElementById('reply-text');
  const text = ta.value.trim();
  if (!text) return;
  const btn = document.getElementById('reply-btn');
  const status = document.getElementById('reply-status');
  btn.disabled = true; status.textContent = 'Sending…'; status.style.color = '';
  try {
    const r = await fetch('/api/admin/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: activePlayer, body: text })
    });
    const data = await r.json();
    if (!r.ok || !data.success) {
      status.textContent = data.error || ('Failed (HTTP ' + r.status + ')');
      status.style.color = '#FCA5A5';
    } else {
      status.textContent = 'Sent ✓';
      status.style.color = '#22C55E';
      ta.value = '';
      autoResizeTextarea();
      await openThread(activePlayer);
      loadThreads();
    }
  } catch (err) {
    status.textContent = 'Network error: ' + err.message;
    status.style.color = '#FCA5A5';
  } finally {
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 4000);
  }
});

// ---------- Header buttons ----------
document.getElementById('resolve-btn').addEventListener('click', () => {
  if (!activePlayer) return;
  markResolved(activePlayer, !(currentThread && currentThread.resolved));
});

document.getElementById('back-btn').addEventListener('click', () => {
  document.body.classList.remove('show-convo');
});

document.getElementById('refresh-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.style.animation = 'spin 0.6s linear'; btn.disabled = true;
  try {
    await fetch('/api/admin/sync', { method: 'POST' });
    await loadThreads();
    if (activePlayer) await openThread(activePlayer);
  } finally {
    setTimeout(() => { btn.style.animation = ''; btn.disabled = false; }, 600);
  }
});

document.getElementById('toggle-resolved').addEventListener('click', (e) => {
  showResolved = !showResolved;
  e.currentTarget.textContent = showResolved ? 'Hide Completed' : 'Show All';
  e.currentTarget.classList.toggle('active', showResolved);
  loadThreads();
});

// CSS keyframe for refresh spin
const styleEl = document.createElement('style');
styleEl.textContent = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
document.head.appendChild(styleEl);

loadThreads();
setInterval(loadThreads, 30000);
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// JSON: list of threads. Groups bcb_messages by player counterpart, shows
// the most-recent message per thread with an unread count.
// ---------------------------------------------------------------------------
router.get('/api/admin/threads', requireAdmin, async (req, res) => {
  if (!process.env.MONGO_URI) return res.json({ threads: [] });
  const agent = (process.env.AGENT_USERNAME || '').toUpperCase();
  const includeResolved = req.query.include_resolved === '1';
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db(MONGO_DB).collection(MESSAGES_COLL);

    const docs = await coll.find({}, { projection: { raw: 0 } })
      .sort({ date_mail: -1 })
      .limit(500)
      .toArray();

    const byPlayer = new Map();
    for (const d of docs) {
      const counterpart =
        d.direction === 'outbound' ? d.to_login :
        (d.from_login && d.from_login.toUpperCase() !== agent ? d.from_login : d.to_login);
      if (!counterpart) continue;
      if (counterpart.toUpperCase() === 'MY AGENT') continue;

      const key = counterpart.toUpperCase();
      if (!byPlayer.has(key)) {
        byPlayer.set(key, {
          player_id: counterpart.trim(),
          last_at: null,
          last_preview: '',
          last_direction: null,
          unread_player: 0,
        });
      }
      const t = byPlayer.get(key);
      const ts = d.date_mail || d.seen_at;
      if (!t.last_at || ts > t.last_at) {
        t.last_at = ts;
        t.last_preview = (d.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
        t.last_direction = d.direction;
      }
      if (d.is_player_message && !d.read_at) t.unread_player++;
    }

    // Join in resolved state + cached display names.
    const ids = Array.from(byPlayer.keys());
    const [stateMap, nameDocs] = await Promise.all([
      getThreadStates(ids),
      client.db(MONGO_DB).collection(PLAYERS_COLL)
        .find({ _id: { $in: ids } }, { projection: { _id: 1, name_first: 1, name_last: 1 } })
        .toArray(),
    ]);
    const nameMap = new Map(nameDocs.map(n => [n._id, n]));

    let threads = [];
    let resolvedCount = 0;
    for (const [id, t] of byPlayer.entries()) {
      const state = stateMap.get(id);
      const isResolved = !!(state && state.resolved_at);
      if (isResolved) resolvedCount++;
      if (isResolved && !includeResolved) continue;
      const n = nameMap.get(id);
      threads.push({
        ...t,
        resolved: isResolved,
        resolved_at: state && state.resolved_at || null,
        display_name: n && (n.name_first || n.name_last)
          ? `${n.name_first || ''} ${n.name_last || ''}`.trim()
          : null,
      });
    }

    threads.sort((a, b) =>
      (b.last_at ? new Date(b.last_at).getTime() : 0) - (a.last_at ? new Date(a.last_at).getTime() : 0)
    );

    res.json({ threads, resolved_hidden: includeResolved ? 0 : resolvedCount });
  } catch (err) {
    console.error('[admin] /api/admin/threads error:', err.message);
    res.status(500).json({ error: 'Failed to load threads' });
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// JSON: full conversation with one player.
// ---------------------------------------------------------------------------
router.get('/api/admin/thread/:player', requireAdmin, async (req, res) => {
  if (!process.env.MONGO_URI) return res.json({ messages: [] });
  const playerId = (req.params.player || '').toUpperCase();
  const agent = (process.env.AGENT_USERNAME || '').toUpperCase();

  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db(MONGO_DB).collection(MESSAGES_COLL);

    const docs = await coll.find({
      $or: [
        { from_login: { $regex: `^${escapeRegex(playerId)}\\s*$`, $options: 'i' } },
        { to_login:   { $regex: `^${escapeRegex(playerId)}\\s*$`, $options: 'i' } }
      ]
    }, { projection: { raw: 0 } })
      .sort({ date_mail: 1, _id: 1 })
      .toArray();

    // Mark inbound player messages as read.
    const unreadIds = docs.filter(d => d.is_player_message && !d.read_at).map(d => d._id);
    if (unreadIds.length) {
      await coll.updateMany({ _id: { $in: unreadIds } }, { $set: { read_at: new Date() } });
    }

    // Lookups: resolved state + cached player info (refresh in background if stale).
    const [stateMap, player] = await Promise.all([
      getThreadStates([playerId]),
      getCachedPlayerInfo(playerId),
    ]);
    const state = stateMap.get(playerId);

    res.json({
      player_id: playerId,
      agent,
      messages: docs,
      resolved: !!(state && state.resolved_at),
      resolved_at: state && state.resolved_at || null,
      player: player ? {
        login_id:   player.customer_id,
        name_first: player.name_first,
        name_last:  player.name_last,
        email:      player.email,
        phone:      player.phone,
      } : null,
    });
  } catch (err) {
    console.error('[admin] /api/admin/thread error:', err.message);
    res.status(500).json({ error: 'Failed to load thread' });
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
});

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// Player info cache. getPlayerInfo() hits the wager backend; we cache the
// result for 24h so the dashboard can render names/phones/emails on every
// thread click without flooding the upstream API.
// ---------------------------------------------------------------------------
async function getCachedPlayerInfo(playerId) {
  if (!playerId || !process.env.MONGO_URI) return null;
  const id = playerId.toUpperCase();
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db(MONGO_DB).collection(PLAYERS_COLL);

    const cached = await coll.findOne({ _id: id });
    if (cached && cached.expires_at && cached.expires_at > new Date()) {
      return cached;
    }

    let info;
    try { info = await agentClient.getPlayerInfo(id); }
    catch (err) {
      console.error(`[admin] getPlayerInfo(${id}) failed:`, err.message);
      return cached || null;   // fall back to stale cache if upstream is down
    }
    if (!info) return cached || null;

    const doc = {
      _id:         id,
      customer_id: id,
      name_first:  (info.NameFirst || '').trim() || null,
      name_last:   (info.NameLast  || '').trim() || null,
      email:       (info.email     || '').trim() || null,
      phone:       (info.HomePhone || '').trim() || null,
      raw:         info,
      fetched_at:  new Date(),
      expires_at:  new Date(Date.now() + PLAYER_CACHE_TTL_MS),
    };
    await coll.replaceOne({ _id: id }, doc, { upsert: true });
    return doc;
  } catch (err) {
    console.error(`[admin] player cache error for ${playerId}:`, err.message);
    return null;
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Thread resolved-state. One doc per player, marked when the operator hits
// "Done." Auto-cleared by sync when a fresh inbound player message arrives
// (handled in messagesSync.js).
// ---------------------------------------------------------------------------
async function getThreadStates(playerIds) {
  if (!process.env.MONGO_URI || !playerIds.length) return new Map();
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const docs = await client.db(MONGO_DB).collection(THREAD_STATE_COLL)
      .find({ _id: { $in: playerIds.map(p => p.toUpperCase()) } })
      .toArray();
    return new Map(docs.map(d => [d._id, d]));
  } catch (err) {
    console.error('[admin] getThreadStates failed:', err.message);
    return new Map();
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

async function setThreadResolved(playerId, adminUser, resolved) {
  if (!process.env.MONGO_URI || !playerId) return false;
  const id = playerId.toUpperCase();
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db(MONGO_DB).collection(THREAD_STATE_COLL);
    if (resolved) {
      await coll.updateOne(
        { _id: id },
        { $set: { resolved_at: new Date(), resolved_by: adminUser } },
        { upsert: true }
      );
    } else {
      await coll.updateOne(
        { _id: id },
        { $set: { resolved_at: null, reopened_at: new Date(), reopened_by: adminUser } },
        { upsert: true }
      );
    }
    return true;
  } catch (err) {
    console.error('[admin] setThreadResolved failed:', err.message);
    return false;
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// GET /api/admin/player/:id — cached player info.
router.get('/api/admin/player/:id', requireAdmin, async (req, res) => {
  const info = await getCachedPlayerInfo(req.params.id);
  if (!info) return res.status(404).json({ error: 'No info found for that player' });
  res.json({ player: info });
});

// POST /api/admin/thread/:id/resolve — mark thread as done.
router.post('/api/admin/thread/:id/resolve', requireAdmin, async (req, res) => {
  const ok = await setThreadResolved(req.params.id, req.admin.user, true);
  await logAdminAction({ action: 'thread_resolve', admin: req.admin.user, player_id: req.params.id });
  res.json({ success: ok });
});

// POST /api/admin/thread/:id/unresolve — un-mark thread (manual reopen).
router.post('/api/admin/thread/:id/unresolve', requireAdmin, async (req, res) => {
  const ok = await setThreadResolved(req.params.id, req.admin.user, false);
  await logAdminAction({ action: 'thread_unresolve', admin: req.admin.user, player_id: req.params.id });
  res.json({ success: ok });
});

// ---------------------------------------------------------------------------
// POST /api/admin/reply — send message to player via wager API + record locally
// ---------------------------------------------------------------------------
router.post('/api/admin/reply', requireAdmin, async (req, res) => {
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const playerId = (req.body.playerId || '').toString().trim().toUpperCase();
  const body     = (req.body.body     || '').toString();

  if (!playerId || !/^[A-Z0-9]{2,20}$/.test(playerId)) {
    return res.status(400).json({ success: false, error: 'Invalid player ID' });
  }
  if (!body || !body.trim()) {
    return res.status(400).json({ success: false, error: 'Reply body cannot be empty' });
  }
  if (body.length > 2000) {
    return res.status(400).json({ success: false, error: 'Reply too long (max 2000 chars)' });
  }

  // Rate limit per admin user.
  const now = Date.now();
  const stamps = (_replyCounts.get(req.admin.user) || []).filter(t => now - t < REPLY_RATE_WIN_MS);
  if (stamps.length >= REPLY_RATE_LIMIT) {
    await logAdminAction({
      action: 'reply_rate_limited', admin: req.admin.user,
      player_id: playerId, remote_ip: remoteIp
    });
    return res.status(429).json({ success: false, error: 'Sending too fast — wait a minute and try again.' });
  }
  stamps.push(now);
  _replyCounts.set(req.admin.user, stamps);

  try {
    await agentClient.sendMessageToCustomer({ customerId: playerId, body });
  } catch (err) {
    console.error('[admin] sendMessageToCustomer failed:', err.message);
    await logAdminAction({
      action: 'reply_fail', admin: req.admin.user,
      player_id: playerId, remote_ip: remoteIp, error: err.message
    });
    return res.status(502).json({ success: false, error: 'Failed to send: ' + err.message });
  }

  // Trigger an immediate sync so the just-sent message (which now lives in
  // the wager backend's type=1 sent bucket) lands in Mongo with its real
  // wager_id before the dashboard refreshes the thread view. Avoids the
  // synthetic-id-then-dupe problem that any local-insert approach has.
  try { await messagesSync.syncOnce(); }
  catch (err) { console.error('[admin] post-reply sync failed:', err.message); }

  // Tag the just-sent message with who clicked Send.
  if (process.env.MONGO_URI) {
    let client;
    try {
      client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      await client.db(MONGO_DB).collection(MESSAGES_COLL).updateOne(
        { direction: 'outbound', to_login: { $regex: `^${escapeRegex(playerId)}\\s*$`, $options: 'i' }, body, sent_by: { $exists: false } },
        { $set: { sent_by: req.admin.user } },
        { sort: { date_mail: -1 } }
      );
    } catch (err) {
      console.error('[admin] failed to tag sent_by:', err.message);
    } finally {
      if (client) try { await client.close(); } catch (_) {}
    }
  }

  await logAdminAction({
    action: 'reply_ok', admin: req.admin.user,
    player_id: playerId, body_len: body.length, remote_ip: remoteIp
  });

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/admin/sync — manual force-sync (the dashboard "Refresh" button)
// ---------------------------------------------------------------------------
router.post('/api/admin/sync', requireAdmin, async (req, res) => {
  try {
    const result = await messagesSync.syncOnce();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
