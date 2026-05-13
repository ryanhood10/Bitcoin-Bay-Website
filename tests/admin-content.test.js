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

// ---------------------------------------------------------------------------
// /api/cron/run-drafter — Phase 9.11 — Pi-cron drafter trigger
// ---------------------------------------------------------------------------
test('POST /api/cron/run-drafter — 503 when BCBAY_CRON_TOKEN unset', async () => {
  const previous = process.env.BCBAY_CRON_TOKEN;
  delete process.env.BCBAY_CRON_TOKEN;
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/cron/run-drafter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {},
    });
    assert.equal(r.status, 503);
  } finally {
    await stopServer(server);
    if (previous !== undefined) process.env.BCBAY_CRON_TOKEN = previous;
  }
});

test('POST /api/cron/run-drafter — 401 missing token', async () => {
  const previous = process.env.BCBAY_CRON_TOKEN;
  process.env.BCBAY_CRON_TOKEN = 'test-token-abc';
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/cron/run-drafter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {},
    });
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server);
    if (previous !== undefined) process.env.BCBAY_CRON_TOKEN = previous; else delete process.env.BCBAY_CRON_TOKEN;
  }
});

test('POST /api/cron/run-drafter — 401 wrong token', async () => {
  const previous = process.env.BCBAY_CRON_TOKEN;
  process.env.BCBAY_CRON_TOKEN = 'test-token-abc';
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/cron/run-drafter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bcbay-Cron-Token': 'wrong-token' },
      body: {},
    });
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server);
    if (previous !== undefined) process.env.BCBAY_CRON_TOKEN = previous; else delete process.env.BCBAY_CRON_TOKEN;
  }
});

test('POST /api/cron/run-drafter — 401 wrong-length token (timing-safe length check)', async () => {
  const previous = process.env.BCBAY_CRON_TOKEN;
  process.env.BCBAY_CRON_TOKEN = 'test-token-abc';
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/cron/run-drafter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bcbay-Cron-Token': 'x' },
      body: {},
    });
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server);
    if (previous !== undefined) process.env.BCBAY_CRON_TOKEN = previous; else delete process.env.BCBAY_CRON_TOKEN;
  }
});

test('POST /api/cron/run-drafter — 202 with valid token (fires drafter in background)', async () => {
  const previous = process.env.BCBAY_CRON_TOKEN;
  process.env.BCBAY_CRON_TOKEN = 'test-token-abc';
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/cron/run-drafter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bcbay-Cron-Token': 'test-token-abc' },
      body: { date: '2026-05-08' },
    });
    assert.equal(r.status, 202);
    assert.equal(r.json.success, true);
  } finally {
    await stopServer(server);
    if (previous !== undefined) process.env.BCBAY_CRON_TOKEN = previous; else delete process.env.BCBAY_CRON_TOKEN;
  }
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

// ---------------------------------------------------------------------------
// /swap-variant — Phase 6.2 — flips Twitter draft active variant
// ---------------------------------------------------------------------------
test('POST /post-drafts/:id/swap-variant — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/swap-variant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/swap-variant — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/swap-variant`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/swap-variant — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/swap-variant', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid id/);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/swap-variant — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/swap-variant`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /regenerate-all-images — Phase 6.4 — re-runs imageRenderer.saveDraftImages
// ---------------------------------------------------------------------------
test('POST /post-drafts/:id/regenerate-all-images — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/regenerate-all-images`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/regenerate-all-images — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/regenerate-all-images`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/regenerate-all-images — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/regenerate-all-images', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/regenerate-all-images — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/regenerate-all-images`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /add-cta-slide — Phase 6.4 — appends a BB-branded CTA slide
// ---------------------------------------------------------------------------
test('POST /post-drafts/:id/add-cta-slide — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/add-cta-slide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/add-cta-slide — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/add-cta-slide`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/add-cta-slide — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/add-cta-slide', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/add-cta-slide — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/add-cta-slide`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { headline: 'test', subhead: 'test' },
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /branded-overlays — Phase 9.5 — sticker library manifest + suggestions
// ---------------------------------------------------------------------------
test('GET /branded-overlays — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/branded-overlays');
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('GET /branded-overlays — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/branded-overlays', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('GET /branded-overlays — 200 returns manifest + empty suggested when no subject', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/branded-overlays', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.ok(Array.isArray(r.json.manifest));
    assert.ok(r.json.manifest.length > 10);
    assert.deepEqual(r.json.suggested, []);
  } finally { await stopServer(server); }
});

test('GET /branded-overlays?subject=bitcoin — auto-suggests btc', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/branded-overlays?subject=bitcoin%20rally', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 200);
    assert.ok(r.json.suggested.includes('btc'));
  } finally { await stopServer(server); }
});

test('GET /branded-overlays/:key.svg — 200 with SVG content for valid key', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/branded-overlays/btc.svg');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<svg'));
    assert.ok(r.text.includes('₿'));
  } finally { await stopServer(server); }
});

test('GET /branded-overlays/:key.svg — 404 for unknown key', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/branded-overlays/nonexistent.svg');
    assert.equal(r.status, 404);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /photo-search — Phase 9.2 — replace-photo candidate search
// ---------------------------------------------------------------------------
test('GET /photo-search — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/photo-search?subject=lakers');
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('GET /photo-search — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/photo-search?subject=lakers', {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('GET /photo-search — 400 when subject is missing', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/photo-search', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('GET /photo-search — 400 when subject is too long', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/photo-search?subject=${'x'.repeat(250)}`, {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /delete-slide — Phase 9.3 — removes one slide from a carousel (floor 2)
// ---------------------------------------------------------------------------
test('POST /post-drafts/:id/delete-slide — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/delete-slide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { slide_index: 0 },
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/delete-slide — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/delete-slide`, {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: { slide_index: 0 },
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/delete-slide — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/delete-slide', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { slide_index: 0 },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/delete-slide — 400 when slide_index missing', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/delete-slide`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/delete-slide — 400 when slide_index is negative', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/delete-slide`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { slide_index: -1 },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('POST /post-drafts/:id/delete-slide — full-role passes auth+validation, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/delete-slide`, {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { slide_index: 0 },
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /zip — Phase 6.5 — streams ZIP of slide JPEGs
// ---------------------------------------------------------------------------
test('GET /post-drafts/:id/zip — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/zip`);
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('GET /post-drafts/:id/zip — 403 for dashboard role', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/zip`, {
      headers: { Cookie: cookieFor('dashboard') },
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('GET /post-drafts/:id/zip — 400 invalid ObjectId', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/post-drafts/banana/zip', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('GET /post-drafts/:id/zip — full-role passes auth, fails at Mongo', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, `/api/admin/dashboard/post-drafts/${VALID_OBJECT_ID}/zip`, {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 500);
  } finally { await stopServer(server); }
});

// ---------------------------------------------------------------------------
// /game-state + /draft-from-game — Phase 8 — ESPN-driven live game tools
// ---------------------------------------------------------------------------
test('GET /game-state — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/game-state?event_id=123&league_path=basketball/nba');
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('GET /game-state — 400 missing event_id', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/game-state', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /event_id/);
  } finally { await stopServer(server); }
});

test('GET /game-state — 400 invalid event_id (non-numeric)', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/game-state?event_id=abc&league_path=basketball/nba', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /event_id/);
  } finally { await stopServer(server); }
});

test('GET /game-state — 400 league_path not in allowed list (SSRF guard)', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/game-state?event_id=123&league_path=evil/path', {
      headers: { Cookie: cookieFor('full') },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /league_path/);
  } finally { await stopServer(server); }
});

test('POST /draft-from-game — 401 unauthenticated', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/draft-from-game', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: { event_id: '123', league_path: 'basketball/nba' },
    });
    assert.equal(r.status, 401);
  } finally { await stopServer(server); }
});

test('POST /draft-from-game — 403 for dashboard role (cost-bearing)', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/draft-from-game', {
      method: 'POST',
      headers: { Cookie: cookieFor('dashboard'), 'Content-Type': 'application/json' },
      body: { event_id: '123', league_path: 'basketball/nba' },
    });
    assert.equal(r.status, 403);
  } finally { await stopServer(server); }
});

test('POST /draft-from-game — 400 invalid event_id', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/draft-from-game', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { event_id: 'banana', league_path: 'basketball/nba' },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

test('POST /draft-from-game — 400 league_path not in allowed list', async () => {
  const app = makeApp();
  const server = await startServer(app);
  try {
    const r = await request(server, '/api/admin/dashboard/draft-from-game', {
      method: 'POST',
      headers: { Cookie: cookieFor('full'), 'Content-Type': 'application/json' },
      body: { event_id: '123', league_path: 'evil/path' },
    });
    assert.equal(r.status, 400);
  } finally { await stopServer(server); }
});

// Restore stderr in case other suites need it
test.after(() => { console.error = _origErr; });
