// Smoke tests for the Bonus Calculator routes added to adminDashboard.js.
// All three routes (page + 2 APIs) must be gated to role=full only — David
// runs this tool, the dashboard-role admin must NOT be able to publish to
// the live leaderboard, even by hitting the API directly.
//
// Same pattern as admin-dashboard-api.test.js: spin up a minimal express
// app with the router mounted, deliberately leave Mongo unconfigured so we
// can predict the failure mode, then verify auth gates fire BEFORE the
// Mongo failure (which proves the gate is in front).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');

process.env.ADMIN_SESSION_SECRET = 'test-secret-at-least-24-chars-long-123';
process.env.NODE_ENV = 'test';
delete process.env.ADMIN_USERNAME;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.MONGO_URI;
delete process.env.MONGO_AUTOMATION_URI;

const adminAuth = require('../adminAuth');
const adminDashboardRouter = require('../adminDashboard');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(adminDashboardRouter);
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(server, path, { method = 'GET', headers = {}, body } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function cookieFor(role, user = 'tester') {
  const signed = adminAuth.signCookie({
    user, role, iat: Date.now(), exp: Date.now() + 60_000,
  });
  return `bcb_admin=${signed}`;
}

const VALID_PAYLOAD = {
  generated_at: '2026-05-03T12:00:00.000Z',
  week_start: '2026-04-27',
  week_end: '2026-05-03',
  volume_threshold: 1500,
  bonuses: [{ rank: 1, account: 'ALICE' }, { rank: 2, account: 'BOB' }],
};

// ---------------------------------------------------------------------------
// Auth gates — page route
// ---------------------------------------------------------------------------
test('GET /admin/dashboard/bonus-calculator — redirects to login when unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/admin/dashboard/bonus-calculator');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/admin/login');
  } finally { await stopServer(server); }
});

test('GET /admin/dashboard/bonus-calculator — 403 HTML for dashboard-role admin', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/admin/dashboard/bonus-calculator', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 403);
    assert.match(r.text, /Access denied/i);
  } finally { await stopServer(server); }
});

test('GET /admin/dashboard/bonus-calculator — serves HTML for full-role admin', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/admin/dashboard/bonus-calculator', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 200);
    assert.match(r.text, /Bonus Calculator/);
    // Confirm we're serving the namespaced endpoint, not the legacy /bonus-report
    assert.match(r.text, /\/api\/admin\/dashboard\/bonus-report/);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Auth gates — JSON APIs
// ---------------------------------------------------------------------------
test('GET /api/admin/dashboard/bonus-reports — 401 when unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-reports');
    assert.equal(r.status, 401);
    assert.equal(r.json.success, false);
  } finally { await stopServer(server); }
});

test('GET /api/admin/dashboard/bonus-reports — 403 for dashboard-role admin', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-reports', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.success, false);
    assert.match(r.json.error, /Insufficient role/);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/bonus-report — 401 when unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: VALID_PAYLOAD,
    });
    assert.equal(r.status, 401);
    assert.equal(r.json.success, false);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/bonus-report — 403 for dashboard-role admin', async () => {
  // CRITICAL: the dashboard-role admin must NEVER be able to publish to the
  // live leaderboard. Even if they discover the URL, the server-side gate
  // must turn them away with 403 (not 401, not 500).
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-report', {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: VALID_PAYLOAD,
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.success, false);
    assert.match(r.json.error, /Insufficient role/);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Full-role passes the gate (then fails at Mongo because we deleted the URI)
// ---------------------------------------------------------------------------
test('GET /api/admin/dashboard/bonus-reports — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-reports', {
      headers: { Cookie: cookieFor('full') },
    });
    // 500 means we got past the auth gate and tried to hit Mongo — proves the
    // gate doesn't block role=full.
    assert.equal(r.status, 500);
    assert.ok(r.json?.error, 'error body exists');
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/bonus-report — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-report', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: VALID_PAYLOAD,
    });
    assert.equal(r.status, 500);
    assert.ok(r.json?.error, 'error body exists');
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Input validation — full-role admins still get rejected for malformed input
// ---------------------------------------------------------------------------
test('POST /api/admin/dashboard/bonus-report — 400 when week_start missing', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-report', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { week_end: '2026-05-03', bonuses: [] },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /week_start/);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/bonus-report — 400 when week_end missing', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-report', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { week_start: '2026-04-27', bonuses: [] },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /week_end/);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/bonus-report — 400 when bonuses is not an array', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/bonus-report', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { week_start: '2026-04-27', week_end: '2026-05-03' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /bonuses/);
  } finally { await stopServer(server); }
});
