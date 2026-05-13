// ---------------------------------------------------------------------------
// adminAuth.js — shared admin auth for bitcoinbay.com internal pages.
//
// Two admin pages share this auth:
//   /admin/messages   — existing player-messaging dashboard (role: full only)
//   /admin/dashboard  — internal analytics dashboard    (role: full OR dashboard)
//
// Credentials:
//   - Legacy env-var admin: ADMIN_USERNAME + ADMIN_PASSWORD_HASH (always role=full)
//   - Mongo-stored admins:  bcb_admin_users collection, each with a `role` field
//
// Cookie `bcb_admin` carries { user, role, iat, exp } and is HMAC-SHA256 signed
// with ADMIN_SESSION_SECRET. Backwards-compatible with the cookie shape
// adminMessages.js used to emit (extra fields are ignored by old code).
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { MongoClient } = require('mongodb');

const COOKIE_NAME    = 'bcb_admin';
const COOKIE_TTL_MS  = 30 * 24 * 60 * 60 * 1000;
const MONGO_DB       = 'bcbay_automation';
const ADMINS_COLL    = 'bcb_admin_users';

const ROLE_FULL      = 'full';
const ROLE_DASHBOARD = 'dashboard';
const VALID_ROLES    = new Set([ROLE_FULL, ROLE_DASHBOARD]);

// Per-user capability layer (Phase 10). The role still controls broad gates,
// but `granted_sections` and `denied_sections` on a Mongo admin doc let us
// hand a single user a specific extra capability (Goadma: dashboard role +
// content_drafter grant for social-media management) or take one away
// (Goadma: tickets denied — he doesn't manage player support).
//
// Section keys are server-side identifiers. The UI maps them to nav items;
// the endpoints map them to access checks via `requireSection(name)`.
const SECTIONS = {
  MESSAGING:        'messaging',         // /admin/messages player-reply UI
  ANALYTICS:        'analytics',         // GA4 + signups + Twitter/IG metrics on /admin/dashboard
  USERS:            'users',             // signups panel
  TICKETS:          'tickets',           // open-thread support panel
  ENGAGEMENT:       'engagement',        // engagement-drafts (bot-suggested replies)
  SOCIAL_METRICS:   'social_metrics',    // Twitter+IG analytics widgets
  CONTENT_DRAFTER:  'content_drafter',   // /admin/dashboard/content
  BONUS_CALCULATOR: 'bonus_calculator',  // /admin/dashboard/bonus-calculator
};

// Default sections by role. `full` gets everything; `dashboard` gets the
// read-only analytics surface. Per-user grants/denies layer on top.
const ROLE_DEFAULT_SECTIONS = {
  [ROLE_FULL]: [
    SECTIONS.MESSAGING, SECTIONS.ANALYTICS, SECTIONS.USERS, SECTIONS.TICKETS,
    SECTIONS.ENGAGEMENT, SECTIONS.SOCIAL_METRICS, SECTIONS.CONTENT_DRAFTER,
    SECTIONS.BONUS_CALCULATOR,
  ],
  [ROLE_DASHBOARD]: [
    SECTIONS.ANALYTICS, SECTIONS.USERS, SECTIONS.TICKETS,
    SECTIONS.ENGAGEMENT, SECTIONS.SOCIAL_METRICS,
  ],
};

function effectiveSections(admin) {
  const role = admin?.role || ROLE_DASHBOARD;
  const base = new Set(ROLE_DEFAULT_SECTIONS[role] || []);
  for (const s of admin?.granted_sections || []) base.add(s);
  for (const s of admin?.denied_sections || []) base.delete(s);
  return base;
}

function canAccess(admin, section) {
  return effectiveSections(admin).has(section);
}

function getSessionSecret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 24) {
    console.warn('[admin-auth] ADMIN_SESSION_SECRET missing or short — admin auth WILL be insecure until set');
    return 'INSECURE-DEV-DEFAULT-CHANGE-ME-IN-HEROKU-CONFIG';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Cookie signing / verifying — HMAC-SHA256 over base64url(JSON).
// ---------------------------------------------------------------------------
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
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

// Backward-compat: callers can pass (res, user, role) like before, OR a full
// admin object as the second arg to capture the per-user capability flags.
function setSessionCookie(res, userOrAdmin, role) {
  const admin = (typeof userOrAdmin === 'object' && userOrAdmin)
    ? userOrAdmin
    : { username: userOrAdmin, role };
  const payload = {
    user: admin.username || admin.user,
    role: admin.role || ROLE_FULL,
    granted_sections: Array.isArray(admin.granted_sections) ? admin.granted_sections : [],
    denied_sections:  Array.isArray(admin.denied_sections)  ? admin.denied_sections  : [],
    landing_page:     admin.landing_page || null,
    iat: Date.now(),
    exp: Date.now() + COOKIE_TTL_MS,
  };
  res.cookie(COOKIE_NAME, signCookie(payload), {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   COOKIE_TTL_MS,
    path:     '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// ---------------------------------------------------------------------------
// Credential lookup — env admin first (role always full), then Mongo.
// Returns { username, role, passwordHash } on match, null on not-found.
// Username comparison is case-insensitive.
// ---------------------------------------------------------------------------
async function findAdmin(username) {
  if (!username) return null;
  const lowered = username.trim().toLowerCase();

  const envUser = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const envHash = process.env.ADMIN_PASSWORD_HASH;
  if (envUser && envHash && envUser === lowered) {
    return { username: envUser, role: ROLE_FULL, passwordHash: envHash, source: 'env' };
  }

  if (!process.env.MONGO_URI) return null;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const doc = await client.db(MONGO_DB).collection(ADMINS_COLL).findOne({ username: lowered });
    if (!doc) return null;
    return {
      username: doc.username,
      role:     VALID_ROLES.has(doc.role) ? doc.role : ROLE_DASHBOARD,
      passwordHash: doc.password_hash,
      granted_sections: Array.isArray(doc.granted_sections) ? doc.granted_sections : [],
      denied_sections:  Array.isArray(doc.denied_sections)  ? doc.denied_sections  : [],
      landing_page:     doc.landing_page || null,
      source: 'mongo',
    };
  } catch (err) {
    console.error('[admin-auth] findAdmin mongo error:', err.message);
    return null;
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

async function verifyPassword(input, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(input, hash);
  } catch (_) {
    return false;
  }
}

async function touchLastLogin(username) {
  if (!process.env.MONGO_URI) return;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db(MONGO_DB).collection(ADMINS_COLL).updateOne(
      { username: username.toLowerCase() },
      { $set: { last_login_at: new Date() } },
    );
  } catch (_) { /* non-fatal */ }
  finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Middleware factory.
//
//   requireAdmin()        — any authenticated admin (full OR dashboard)
//   requireAdmin('full')  — must be role=full
// ---------------------------------------------------------------------------
// Client wants JSON if the path is under /api/ OR the Accept header says so.
// Lets us reuse requireAdmin on non-/api paths like /auth/instagram/status
// that are still called via fetch() and expect JSON back.
function wantsJson(req) {
  if (req.path.startsWith('/api/')) return true;
  const accept = (req.get && req.get('Accept')) || req.headers?.accept || '';
  return accept.includes('application/json');
}

function requireAdmin(requiredRole) {
  return function (req, res, next) {
    const raw = req.cookies && req.cookies[COOKIE_NAME];
    const session = verifyCookie(raw);
    if (!session) {
      if (wantsJson(req)) {
        return res.status(401).json({ success: false, error: 'Not signed in' });
      }
      return res.redirect('/admin/login');
    }
    const userRole = session.role || ROLE_FULL;  // back-compat: older cookies had no role
    if (requiredRole === ROLE_FULL && userRole !== ROLE_FULL) {
      if (wantsJson(req)) {
        return res.status(403).json({ success: false, error: 'Insufficient role' });
      }
      return res.status(403).type('html').send(
        `<html><body style="font-family:system-ui;padding:40px;background:#0c0c10;color:#e8e6f0;">
         <h1 style="color:#f87171;">403 — Access denied</h1>
         <p>Your admin role (<code>${userRole}</code>) does not have access to this page.</p>
         <p><a href="/admin/dashboard" style="color:#EE8034;">Go to your dashboard →</a></p>
         </body></html>`
      );
    }
    req.admin = {
      user: session.user,
      role: userRole,
      granted_sections: Array.isArray(session.granted_sections) ? session.granted_sections : [],
      denied_sections:  Array.isArray(session.denied_sections)  ? session.denied_sections  : [],
      landing_page:     session.landing_page || null,
    };
    next();
  };
}

// Section-gating middleware. Use AFTER requireAdmin so req.admin is set.
// Returns 403 (or HTML for non-API paths) if the admin doesn't have access
// to the named section. Falls back to allow if req.admin is missing because
// requireAdmin should already have rejected; this is just defense-in-depth.
function requireSection(section) {
  return function (req, res, next) {
    if (!req.admin) return res.status(401).json({ success: false, error: 'Not signed in' });
    if (canAccess(req.admin, section)) return next();
    if (wantsJson(req)) {
      return res.status(403).json({ success: false, error: `section "${section}" not accessible by this admin` });
    }
    return res.status(403).type('html').send(
      `<html><body style="font-family:system-ui;padding:40px;background:#0c0c10;color:#e8e6f0;">
       <h1 style="color:#f87171;">403 — Access denied</h1>
       <p>Your account does not have access to <code>${section}</code>.</p>
       <p><a href="/admin/dashboard" style="color:#EE8034;">Go to your dashboard →</a></p>
       </body></html>`
    );
  };
}

module.exports = {
  COOKIE_NAME,
  COOKIE_TTL_MS,
  MONGO_DB,
  ADMINS_COLL,
  ROLE_FULL,
  ROLE_DASHBOARD,
  VALID_ROLES,
  SECTIONS,
  ROLE_DEFAULT_SECTIONS,
  signCookie,
  verifyCookie,
  setSessionCookie,
  clearSessionCookie,
  findAdmin,
  verifyPassword,
  touchLastLogin,
  requireAdmin,
  requireSection,
  effectiveSections,
  canAccess,
};
