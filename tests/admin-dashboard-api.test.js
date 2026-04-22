// Smoke tests for adminDashboard.js — verifies auth gates + route shapes
// without hitting a live Mongo instance. We spin up a minimal express app
// with the router mounted, then hit endpoints with and without a valid
// session cookie.

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
delete process.env.MONGO_AUTOMATION_URI;  // forces endpoint failures we can predict

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

// ---------------------------------------------------------------------------
// Auth gates
// ---------------------------------------------------------------------------
test('GET /api/admin/dashboard/report — 401 when not signed in', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/report');
    assert.equal(r.status, 401);
    assert.equal(r.json.success, false);
  } finally { await stopServer(server); }
});

test('GET /admin/dashboard — redirects to /admin/login when not signed in', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/admin/dashboard');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/admin/login');
  } finally { await stopServer(server); }
});

test('any role (full or dashboard) can hit /api/admin/dashboard/* when Mongo is misconfigured', async () => {
  // We deleted MONGO_AUTOMATION_URI — the handler should still gate on auth
  // first, then return 500 because of missing Mongo. That proves auth is in
  // front (401/403 would surface before 500).
  const app = makeApp();
  const server = await startServer(app);
  try {
    for (const role of ['full', 'dashboard']) {
      const r = await request(server, '/api/admin/dashboard/report', {
        headers: { Cookie: cookieFor(role) },
      });
      assert.equal(r.status, 500, `auth passed for role=${role}; mongo fails with 500`);
      assert.ok(r.json?.error, 'error body exists');
    }
  } finally { await stopServer(server); }
});

test('dashboard HTML is served to authenticated admin', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/admin/dashboard', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<title>BC Bay — Reports</title>') ||
              r.text.toLowerCase().includes('dashboard'),
              'response body looks like the dashboard HTML');
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
test('PATCH /api/admin/dashboard/engagement-drafts/:id — rejects invalid status', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/engagement-drafts/abc', {
      method: 'PATCH',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: { status: 'banana' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid status/);
  } finally { await stopServer(server); }
});

test('PATCH /api/admin/dashboard/engagement-drafts/:id — rejects invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/engagement-drafts/not-a-hex', {
      method: 'PATCH',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: { status: 'posted' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid id/);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Path collisions — confirm /admin/dashboard and /api/admin/dashboard don't
// overlap with existing /admin/messages or /api/admin/* routes.
// ---------------------------------------------------------------------------
test('adminDashboard router does not shadow /api/admin/threads namespace', async () => {
  // If we accidentally used /api/admin/* as a catch-all instead of
  // /api/admin/dashboard/* prefix, hitting /api/admin/threads through the
  // dashboard router would return 401 instead of 404.
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/threads');
    assert.equal(r.status, 404, 'route is not handled by the dashboard router');
  } finally { await stopServer(server); }
});
