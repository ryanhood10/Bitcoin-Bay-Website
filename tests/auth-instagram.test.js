// Smoke tests for authInstagram.js — verifies auth gates + connect-URL shape.
// No network calls are made: we only hit endpoints that don't contact IG.

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
process.env.INSTAGRAM_APP_ID = '1258908796454896';
process.env.INSTAGRAM_APP_SECRET = 'test-secret';
process.env.INSTAGRAM_REDIRECT_URI = 'https://bitcoinbay.com/auth/instagram/callback';
process.env.INSTAGRAM_ACCOUNT_HANDLE = 'bitcoin_bay';

const adminAuth = require('../adminAuth');
const authInstagram = require('../authInstagram');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authInstagram);
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
  const signed = adminAuth.signCookie({ user, role, iat: Date.now(), exp: Date.now() + 60_000 });
  return `bcb_admin=${signed}`;
}

// ---------------------------------------------------------------------------
// /auth/instagram/connect — gated by role=full, redirects to Instagram
// ---------------------------------------------------------------------------
test('GET /auth/instagram/connect — no cookie redirects to /admin/login', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/connect');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/admin/login');
  } finally { await stopServer(server); }
});

test('GET /auth/instagram/connect — dashboard-role user gets 403', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/connect', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('GET /auth/instagram/connect — full-role user gets 302 to instagram.com with correct params', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/connect', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 302);
    const loc = r.headers.location;
    assert.ok(loc.startsWith('https://www.instagram.com/oauth/authorize?'), 'redirect target is IG authorize');
    const u = new URL(loc);
    assert.equal(u.searchParams.get('client_id'), '1258908796454896');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://bitcoinbay.com/auth/instagram/callback');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.ok(u.searchParams.get('state'), 'state parameter is set');
    assert.ok(u.searchParams.get('scope').includes('instagram_business_basic'));
    // Make sure the bogus scope from the earlier Meta error is NOT present
    assert.ok(!u.searchParams.get('scope').includes('instagram_business_manage_content'),
      'bogus scope instagram_business_manage_content must not be requested');
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /auth/instagram/callback — public (IG posts to it) but state-gated
// ---------------------------------------------------------------------------
test('GET /auth/instagram/callback — rejects missing state', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/callback?code=abc');
    assert.equal(r.status, 400);
    assert.ok(r.text.includes('Missing'));
  } finally { await stopServer(server); }
});

test('GET /auth/instagram/callback — rejects bad state', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/callback?code=abc&state=never-issued');
    assert.equal(r.status, 400);
    assert.ok(r.text.includes('State mismatch'));
  } finally { await stopServer(server); }
});

test('GET /auth/instagram/callback — surfaces IG-side error cleanly', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/callback?error=access_denied&error_description=User+declined');
    assert.equal(r.status, 400);
    assert.ok(r.text.includes('access_denied'));
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /auth/instagram/status — any admin can read
// ---------------------------------------------------------------------------
test('GET /auth/instagram/status — returns JSON 401 when Accept:application/json without cookie', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/status', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(r.status, 401);
    assert.equal(r.json.success, false);
  } finally { await stopServer(server); }
});

test('GET /auth/instagram/status — redirects to /admin/login for browser requests without cookie', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    // No Accept header — treated as a browser HTML request, so it redirects.
    const r = await request(server, '/auth/instagram/status');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/admin/login');
  } finally { await stopServer(server); }
});

test('GET /auth/instagram/status — 500 when Mongo missing (auth passes, Mongo fails)', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/status', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 500);
    assert.ok(r.json?.error);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /auth/instagram/scrape-session — GET (HTML) + POST (JSON)
// ---------------------------------------------------------------------------
test('GET /auth/instagram/scrape-session — full-role only', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const unauth = await request(server, '/auth/instagram/scrape-session');
    assert.equal(unauth.status, 302);
    assert.equal(unauth.headers.location, '/admin/login');
    const dash = await request(server, '/auth/instagram/scrape-session', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(dash.status, 403);
    const full = await request(server, '/auth/instagram/scrape-session', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(full.status, 200);
    assert.ok(full.text.includes('sessionid'));
  } finally { await stopServer(server); }
});

test('POST /auth/instagram/scrape-session — rejects empty sessionid', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/auth/instagram/scrape-session', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { sessionid: '' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /required/);
  } finally { await stopServer(server); }
});
