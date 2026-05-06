// Smoke tests for the Phase 6 content-drafter routes added to adminDashboard.js.
//
// All write/regen/approve endpoints MUST be FULL-role only — they trigger
// Anthropic spend (regenerate, run-drafter) and will eventually publish to
// the live BB X/IG accounts (Phase 7). The dashboard-role admin must NOT
// be able to touch them, even by hitting the URLs directly.
//
// Same pattern as admin-dashboard-api.test.js + bonus-calculator.test.js:
// spin up a minimal express app with the router mounted, deliberately
// leave Mongo unconfigured so we can predict the failure mode, then verify
// auth gates fire BEFORE the Mongo failure (which proves the gate is in
// front).

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
// Make sure the contentDrafter module can require() without crashing during
// test bootstrap. ANTHROPIC_API_KEY is required by getAnthropic() but only
// when a request actually hits Anthropic — module-level require is safe
// without it. Set a dummy so any accidental client construction surfaces a
// 401 instead of a missing-env throw.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-dummy-key';

// Suppress noisy stderr from intentional handler-error paths
const _origErr = console.error;
console.error = () => {};

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

const VALID_OBJECT_ID = '507f1f77bcf86cd799439011'; // any 24-hex string parses

// ---------------------------------------------------------------------------
// Auth gates — read endpoints (any admin role)
// ---------------------------------------------------------------------------
test('GET /api/admin/dashboard/post-briefs/latest — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-briefs/latest');
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('GET /api/admin/dashboard/post-briefs/latest — both roles pass auth (then 500 at Mongo)', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    for (const role of ['full', 'dashboard']) {
      const r = await request(server, '/api/admin/dashboard/post-briefs/latest', {
        headers: { Cookie: cookieFor(role) },
      });
      assert.equal(r.status, 500, `role=${role}: auth passed, mongo failed`);
    }
  } finally { await stopServer(server); }
});

test('GET /api/admin/dashboard/post-drafts — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts');
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('GET /api/admin/dashboard/post-drafts — both roles pass auth (read is open)', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    for (const role of ['full', 'dashboard']) {
      const r = await request(server, '/api/admin/dashboard/post-drafts', {
        headers: { Cookie: cookieFor(role) },
      });
      assert.equal(r.status, 500, `role=${role}: auth passed, mongo failed`);
    }
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Auth gates — write endpoints (FULL role only)
// ---------------------------------------------------------------------------
test('PATCH /api/admin/dashboard/post-drafts/:id — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: { text: 'edit' },
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('PATCH /api/admin/dashboard/post-drafts/:id — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}`, {
      method: 'PATCH',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: { text: 'edit' },
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Insufficient role/);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/regenerate — 403 for dashboard role', async () => {
  // Critical: dashboard-role admin must not be able to burn Anthropic spend.
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/regenerate`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Insufficient role/);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/skip — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/skip`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: { reason: 'no' },
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/approve — 403 for dashboard role', async () => {
  // Critical: only full-role can approve. Phase 7 will wire this to actual
  // X/IG publish — dashboard-role must NEVER trigger that path.
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/approve`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/run-drafter — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/run-drafter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {},
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/run-drafter — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/run-drafter', {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Input validation — full-role admins still get rejected for malformed input
// ---------------------------------------------------------------------------
test('PATCH /api/admin/dashboard/post-drafts/:id — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/not-a-hex', {
      method: 'PATCH',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { text: 'edit' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid id/);
  } finally { await stopServer(server); }
});

test('PATCH /api/admin/dashboard/post-drafts/:id — 400 when body has no allowed fields', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}`, {
      method: 'PATCH',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { status: 'posted', injected: 'bad' },  // none in allowlist
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /no allowed fields/);
  } finally { await stopServer(server); }
});

test('PATCH /api/admin/dashboard/post-drafts/:id — 400 when hashtags is not an array', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}`, {
      method: 'PATCH',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { hashtags: 'not-an-array' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /hashtags must be an array/);
  } finally { await stopServer(server); }
});

test('PATCH /api/admin/dashboard/post-drafts/:id — 400 when slides is not an array', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}`, {
      method: 'PATCH',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { slides: { wrong: 'shape' } },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /slides must be an array/);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/regenerate — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/regenerate', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid id/);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/skip — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/skip', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { reason: 'test' },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/approve — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/approve', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// Full-role passes — these should hit Mongo and 500 (proves auth gate is in
// front). For PATCH/skip/approve, the handler runs Mongo update with a
// well-formed ObjectId and returns 500 because Mongo isn't reachable.
// ---------------------------------------------------------------------------
test('PATCH /api/admin/dashboard/post-drafts/:id — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}`, {
      method: 'PATCH',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { text: 'tweet edit' },
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/skip — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/skip`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { reason: 'off-message' },
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/post-drafts/:id/approve — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/approve`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

test('POST /api/admin/dashboard/run-drafter — full-role gets 202 (fire-and-forget)', async () => {
  // The endpoint returns 202 immediately; the background runDrafter() call
  // will fail (no Mongo) but its rejection is caught by the route handler.
  // We only test that the gate passes and the response is 202.
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/run-drafter', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { date: '2026-05-06' },
    });
    assert.equal(r.status, 202);
    assert.equal(r.json.success, true);
    assert.equal(r.json.accepted, true);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /generate-art — Phase 4.5 — Replicate InstantID AI scene generation
// Operator-triggered, FULL role only, ~$0.05/call. Auth gates are critical
// here — dashboard-role admins must NOT be able to burn Replicate credits.
// ---------------------------------------------------------------------------
test('POST /post-drafts/:id/generate-art — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/generate-art`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: { scene_prompt: 'an athlete celebrating in confetti' },
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/generate-art — 403 for dashboard role (cost-bearing)', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/generate-art`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: { scene_prompt: 'an athlete celebrating in confetti' },
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Insufficient role/);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/generate-art — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/generate-art', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { scene_prompt: 'an athlete celebrating in confetti' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid id/);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/generate-art — 400 when scene_prompt is missing', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/generate-art`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /scene_prompt required/);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/generate-art — 400 when scene_prompt is too short', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/generate-art`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { scene_prompt: 'too short' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /scene_prompt required/);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/generate-art — 503 when REPLICATE_API_TOKEN missing', async () => {
  // Token check fires AFTER the body validation — so a valid prompt + valid id
  // hits the token gate and returns 503 with a clear error message. This is
  // the path operators will see if Heroku config is missing the token.
  delete process.env.REPLICATE_API_TOKEN;
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/generate-art`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { scene_prompt: 'a basketball player celebrating after a clutch shot' },
    });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /REPLICATE_API_TOKEN/);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/generate-art — full-role passes auth+validation, fails at Mongo when token set', async () => {
  // With token set + valid body + valid id, the gate passes and the handler
  // tries to load the draft from Mongo (which 500s in test). Proves auth +
  // validation are in front of the data layer.
  process.env.REPLICATE_API_TOKEN = 'r8_test_dummy_token_for_gate_check';
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/generate-art`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { scene_prompt: 'a basketball player celebrating after a clutch shot' },
    });
    assert.equal(r.status, 500);
  } finally {
    delete process.env.REPLICATE_API_TOKEN;
    await stopServer(server);
  }
});

// Restore stderr in case other suites need it
test.after(() => { console.error = _origErr; });
