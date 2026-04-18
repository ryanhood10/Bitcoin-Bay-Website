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
const ADMIN_LOG_COLL    = 'bcb_admin_log';
const REPLY_RATE_LIMIT  = 30;        // max replies per session per hour
const REPLY_RATE_WIN_MS = 60 * 60 * 1000;

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
:root{--gold:#F7941D;--orange:#F26522;--bg:#071225;--panel:#0D2240;--panel-2:#0A1A33;--border:rgba(86,204,242,0.1);--text:#fff;--text-2:#B0C4DE;--text-3:#6B8DB5;--green:#22C55E}
html,body{height:100%}
body{font-family:'Inter',-apple-system,sans-serif;background:radial-gradient(at 60% 0%,#0E2245 0%,#091830 45%,#071225 100%);color:var(--text);overflow:hidden}
header{height:54px;display:flex;align-items:center;padding:0 20px;border-bottom:1px solid var(--border);background:var(--panel-2)}
header .brand{font-weight:800;font-size:14px;background:linear-gradient(135deg,var(--gold),var(--orange));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
header .who{margin-left:auto;color:var(--text-3);font-size:12px}
header form{display:inline}
header button{margin-left:12px;background:transparent;border:1px solid var(--border);color:var(--text-2);font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit}
header button:hover{border-color:var(--gold);color:var(--gold)}

.layout{display:grid;grid-template-columns:340px 1fr;height:calc(100% - 54px)}
.threads{border-right:1px solid var(--border);overflow-y:auto;background:var(--panel-2)}
.threads-header{display:flex;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.05em}
.threads-header .count{margin-left:auto;background:var(--panel);padding:2px 8px;border-radius:9999px;font-size:11px}
.threads-header button{margin-left:8px;background:transparent;border:1px solid var(--border);color:var(--text-3);font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;font-family:inherit;text-transform:uppercase;letter-spacing:0.05em}
.threads-header button:hover{color:var(--gold);border-color:var(--gold)}
.thread{padding:14px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s}
.thread:hover{background:rgba(86,204,242,0.04)}
.thread.active{background:rgba(247,148,29,0.08);border-left:3px solid var(--gold);padding-left:13px}
.thread .top{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
.thread .id{font-family:'Courier New',monospace;font-weight:700;color:var(--gold);font-size:13px}
.thread .when{margin-left:auto;color:var(--text-3);font-size:11px;flex-shrink:0}
.thread .preview{color:var(--text-2);font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.thread .badge{display:inline-block;background:var(--gold);color:var(--bg);font-size:10px;font-weight:800;padding:1px 6px;border-radius:9999px;margin-left:6px;vertical-align:middle}
.empty{color:var(--text-3);text-align:center;padding:60px 20px;font-size:14px}

.convo{display:flex;flex-direction:column;overflow:hidden}
.convo-header{padding:16px 24px;border-bottom:1px solid var(--border);background:var(--panel-2);display:flex;align-items:center;gap:12px;flex-shrink:0}
.convo-header .who{font-size:16px;font-weight:700;font-family:'Courier New',monospace;color:var(--gold)}
.convo-header .meta{color:var(--text-3);font-size:12px}
.convo-body{flex:1;overflow-y:auto;padding:24px}
.msg{max-width:75%;margin-bottom:16px;padding:12px 16px;border-radius:14px;font-size:14px;line-height:1.5}
.msg .meta{font-size:11px;color:var(--text-3);margin-top:6px}
.msg.from-player{background:var(--panel);border:1px solid var(--border)}
.msg.from-agent{background:linear-gradient(135deg,rgba(247,148,29,0.18),rgba(242,101,34,0.12));border:1px solid rgba(247,148,29,0.25);margin-left:auto}
.msg.from-master{background:rgba(86,204,242,0.06);border:1px solid rgba(86,204,242,0.15)}
.msg .label{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-3);margin-bottom:4px;font-weight:600}
.compose{border-top:1px solid var(--border);padding:16px 24px;background:var(--panel-2);flex-shrink:0}
.compose textarea{width:100%;min-height:80px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--text);font-size:14px;font-family:inherit;resize:vertical}
.compose textarea:focus{outline:none;border-color:var(--gold)}
.compose .row{display:flex;align-items:center;gap:12px;margin-top:10px}
.compose .status{flex:1;font-size:12px;color:var(--text-3)}
.compose button{background:linear-gradient(135deg,var(--gold),var(--orange));color:var(--bg);font-weight:800;font-size:13px;padding:10px 24px;border:none;border-radius:9999px;cursor:pointer;font-family:inherit}
.compose button:disabled{opacity:0.5;cursor:not-allowed}
.placeholder{flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:14px;text-align:center;padding:24px}

@media(max-width:760px){
  .layout{grid-template-columns:1fr}
  .threads{display:block}
  .convo{display:none}
  body.show-convo .threads{display:none}
  body.show-convo .convo{display:flex}
  .back-btn{display:inline-block !important}
}
.back-btn{display:none;background:transparent;border:1px solid var(--border);color:var(--text-2);font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit;margin-right:8px}
</style></head><body>
<header>
  <span class="brand">BITCOIN BAY · ADMIN</span>
  <span class="who">${user}</span>
  <form method="POST" action="/admin/logout"><button>Sign out</button></form>
</header>
<div class="layout">
  <aside class="threads">
    <div class="threads-header">
      Conversations
      <span class="count" id="thread-count">0</span>
      <button type="button" id="refresh-btn" title="Pull latest from wager">Refresh</button>
    </div>
    <div id="thread-list"><div class="empty">Loading…</div></div>
  </aside>
  <main class="convo">
    <div id="convo-empty" class="placeholder">Select a conversation</div>
    <div id="convo-content" style="display:none;flex:1;flex-direction:column;overflow:hidden">
      <div class="convo-header">
        <button type="button" class="back-btn" onclick="document.body.classList.remove('show-convo')">&larr;</button>
        <div>
          <div class="who" id="convo-who"></div>
          <div class="meta" id="convo-meta"></div>
        </div>
      </div>
      <div class="convo-body" id="convo-body"></div>
      <form class="compose" id="reply-form">
        <textarea id="reply-text" placeholder="Type your reply…" required></textarea>
        <div class="row">
          <span class="status" id="reply-status"></span>
          <button type="submit" id="reply-btn">Send Reply</button>
        </div>
      </form>
    </div>
  </main>
</div>
<script>
let activePlayer = null;
let threads = [];

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = Date.now();
  const diff = now - dt.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadThreads() {
  const r = await fetch('/api/admin/threads');
  if (!r.ok) { document.getElementById('thread-list').innerHTML = '<div class="empty">Failed to load.</div>'; return; }
  const data = await r.json();
  threads = data.threads || [];
  renderThreads();
}

function renderThreads() {
  document.getElementById('thread-count').textContent = threads.length;
  const list = document.getElementById('thread-list');
  if (!threads.length) {
    list.innerHTML = '<div class="empty">No conversations yet.<br>New player messages will appear here.</div>';
    return;
  }
  list.innerHTML = threads.map(t => {
    const unreadBadge = t.unread_player ? '<span class="badge">' + t.unread_player + '</span>' : '';
    return '<div class="thread' + (activePlayer === t.player_id ? ' active' : '') + '" data-player="' + escapeHtml(t.player_id) + '">' +
      '<div class="top"><span class="id">' + escapeHtml(t.player_id) + '</span>' + unreadBadge +
      '<span class="when">' + fmtDate(t.last_at) + '</span></div>' +
      '<div class="preview">' + escapeHtml(t.last_preview || '') + '</div>' +
    '</div>';
  }).join('');
  list.querySelectorAll('.thread').forEach(el => {
    el.addEventListener('click', () => openThread(el.dataset.player));
  });
}

async function openThread(playerId) {
  activePlayer = playerId;
  renderThreads();
  document.body.classList.add('show-convo');
  document.getElementById('convo-empty').style.display = 'none';
  document.getElementById('convo-content').style.display = 'flex';
  document.getElementById('convo-who').textContent = playerId;
  document.getElementById('convo-meta').textContent = 'Loading…';
  document.getElementById('convo-body').innerHTML = '';
  const r = await fetch('/api/admin/thread/' + encodeURIComponent(playerId));
  if (!r.ok) { document.getElementById('convo-meta').textContent = 'Failed to load.'; return; }
  const data = await r.json();
  document.getElementById('convo-meta').textContent = (data.messages || []).length + ' messages';
  const body = document.getElementById('convo-body');
  body.innerHTML = (data.messages || []).map(m => {
    let cls = 'from-master';
    let label = m.from_login || 'Unknown';
    if (m.is_player_message || (m.from_type === 'C')) { cls = 'from-player'; label = '👤 ' + label; }
    else if (m.direction === 'outbound') { cls = 'from-agent'; label = '✉️ You'; }
    else if (m.from_login === 'MY AGENT') { cls = 'from-master'; label = '🏢 Upstream'; }
    else { cls = 'from-agent'; label = '✉️ ' + label; }
    return '<div class="msg ' + cls + '">' +
      '<div class="label">' + escapeHtml(label) + '</div>' +
      escapeHtml(m.body || '').replace(/\\n/g, '<br>').replace(/&lt;br&gt;/gi, '<br>') +
      '<div class="meta">' + (m.subject ? escapeHtml(m.subject) + ' · ' : '') + fmtDate(m.date_mail || m.created_at) + '</div>' +
    '</div>';
  }).join('');
  body.scrollTop = body.scrollHeight;
}

document.getElementById('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activePlayer) return;
  const text = document.getElementById('reply-text').value.trim();
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
      document.getElementById('reply-text').value = '';
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

document.getElementById('refresh-btn').addEventListener('click', async (e) => {
  e.target.textContent = '…'; e.target.disabled = true;
  try {
    await fetch('/api/admin/sync', { method: 'POST' });
    await loadThreads();
    if (activePlayer) await openThread(activePlayer);
  } finally {
    e.target.textContent = 'Refresh'; e.target.disabled = false;
  }
});

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
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db(MONGO_DB).collection(MESSAGES_COLL);

    // Pull a wide net of recent messages then group in JS — keeps the query
    // simple and the dataset is tiny anyway (few hundred rows expected).
    const docs = await coll.find({}, { projection: { raw: 0 } })
      .sort({ date_mail: -1 })
      .limit(500)
      .toArray();

    const byPlayer = new Map();
    for (const d of docs) {
      // The "player" in a thread is whichever counterpart isn't us (the agent).
      const counterpart =
        d.direction === 'outbound' ? d.to_login :
        (d.from_login && d.from_login.toUpperCase() !== agent ? d.from_login : d.to_login);
      if (!counterpart) continue;
      // Skip "MY AGENT" upstream-master broadcasts — those are not threads
      // worth replying to (they're operational announcements).
      if (counterpart.toUpperCase() === 'MY AGENT') continue;

      if (!byPlayer.has(counterpart)) {
        byPlayer.set(counterpart, { player_id: counterpart, last_at: null, last_preview: '', unread_player: 0 });
      }
      const t = byPlayer.get(counterpart);
      const ts = d.date_mail || d.seen_at;
      if (!t.last_at || ts > t.last_at) {
        t.last_at = ts;
        t.last_preview = (d.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      }
      // "Unread" = inbound player message we haven't acknowledged yet.
      // For now, no read state, so just count player messages.
      if (d.is_player_message && !d.read_at) t.unread_player++;
    }

    const threads = Array.from(byPlayer.values()).sort((a, b) =>
      (b.last_at ? new Date(b.last_at).getTime() : 0) - (a.last_at ? new Date(a.last_at).getTime() : 0)
    );

    res.json({ threads });
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

    res.json({ player_id: playerId, agent, messages: docs });
  } catch (err) {
    console.error('[admin] /api/admin/thread error:', err.message);
    res.status(500).json({ error: 'Failed to load thread' });
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
});

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// POST /api/admin/reply — send message to player via wager API + record locally
// ---------------------------------------------------------------------------
router.post('/api/admin/reply', requireAdmin, express.json(), async (req, res) => {
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
