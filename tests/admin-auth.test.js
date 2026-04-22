// Tests for adminAuth.js — cookie lifecycle + role-based middleware.
// Uses node:test (built-in, Node 20+). Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate env — these tests should not depend on the operator's real env.
process.env.ADMIN_SESSION_SECRET = 'test-secret-at-least-24-chars-long-123';
process.env.NODE_ENV = 'test';
delete process.env.ADMIN_USERNAME;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.MONGO_URI;   // disables Mongo lookup path

const adminAuth = require('../adminAuth');

// ---------------------------------------------------------------------------
// Cookie signing + verifying
// ---------------------------------------------------------------------------
test('signCookie + verifyCookie round-trip', () => {
  const payload = { user: 'ryan', role: 'full', iat: Date.now(), exp: Date.now() + 60_000 };
  const signed = adminAuth.signCookie(payload);
  const verified = adminAuth.verifyCookie(signed);
  assert.equal(verified.user, 'ryan');
  assert.equal(verified.role, 'full');
});

test('verifyCookie rejects tampered payload', () => {
  const payload = { user: 'ryan', role: 'full', iat: Date.now(), exp: Date.now() + 60_000 };
  const signed = adminAuth.signCookie(payload);
  const [json, sig] = signed.split('.');
  // Flip role to "full" payload but keep dashboard-only signature
  const evil = Buffer.from(JSON.stringify({ ...payload, role: 'full-hacked' }), 'utf8').toString('base64url');
  assert.equal(adminAuth.verifyCookie(`${evil}.${sig}`), null);
});

test('verifyCookie rejects expired cookie', () => {
  const expired = adminAuth.signCookie({ user: 'ryan', role: 'full', iat: 1, exp: 2 });
  assert.equal(adminAuth.verifyCookie(expired), null);
});

test('verifyCookie rejects malformed inputs', () => {
  assert.equal(adminAuth.verifyCookie(null), null);
  assert.equal(adminAuth.verifyCookie(''), null);
  assert.equal(adminAuth.verifyCookie('nosignature'), null);
  assert.equal(adminAuth.verifyCookie('too.many.dots.here'), null);
});

// ---------------------------------------------------------------------------
// setSessionCookie helpers
// ---------------------------------------------------------------------------
function mockRes() {
  const self = { cookies: {}, cleared: false };
  self.cookie = (name, value, opts) => { self.cookies[name] = { value, opts }; };
  self.clearCookie = () => { self.cleared = true; };
  self.status = () => self;
  self.json = (j) => { self.json_body = j; return self; };
  self.redirect = (u) => { self.redirected_to = u; return self; };
  self.type = () => self;
  self.send = (s) => { self.send_body = s; return self; };
  return self;
}

test('setSessionCookie emits signed bcb_admin cookie with user + role', () => {
  const res = mockRes();
  adminAuth.setSessionCookie(res, 'ryan', 'full');
  const c = res.cookies['bcb_admin'];
  assert.ok(c, 'bcb_admin cookie was set');
  const verified = adminAuth.verifyCookie(c.value);
  assert.equal(verified.user, 'ryan');
  assert.equal(verified.role, 'full');
  assert.equal(c.opts.httpOnly, true);
  assert.equal(c.opts.sameSite, 'lax');
});

test('setSessionCookie defaults missing role to full', () => {
  const res = mockRes();
  adminAuth.setSessionCookie(res, 'ryan');  // no role arg
  const v = adminAuth.verifyCookie(res.cookies['bcb_admin'].value);
  assert.equal(v.role, 'full');
});

// ---------------------------------------------------------------------------
// requireAdmin(role?) middleware — decides based on cookie + required role
// ---------------------------------------------------------------------------
function mockReq(cookie, pathStr) {
  return { cookies: cookie ? { bcb_admin: cookie } : {}, path: pathStr || '/admin/dashboard' };
}

test('requireAdmin() — missing cookie on API path returns 401 JSON', () => {
  const mw = adminAuth.requireAdmin();
  const res = mockRes();
  let nexted = false;
  mw(mockReq(null, '/api/admin/dashboard/report'), (() => (res.status = () => res), res)[0] === undefined ? res : res, () => nexted = true);
  // Re-do with cleaner call
  const res2 = mockRes();
  res2.status = (code) => { res2.status_code = code; return res2; };
  res2.json = (j) => { res2.json_body = j; return res2; };
  mw(mockReq(null, '/api/admin/dashboard/report'), res2, () => { throw new Error('next should not be called'); });
  assert.equal(res2.status_code, 401);
  assert.equal(res2.json_body.success, false);
});

test('requireAdmin() — missing cookie on page path redirects to /admin/login', () => {
  const mw = adminAuth.requireAdmin();
  const res = mockRes();
  mw(mockReq(null, '/admin/dashboard'), res, () => { throw new Error('next should not be called'); });
  assert.equal(res.redirected_to, '/admin/login');
});

test('requireAdmin() — any valid role passes when no role required', () => {
  const cookie = adminAuth.signCookie({ user: 'brother', role: 'dashboard', iat: Date.now(), exp: Date.now() + 60_000 });
  const mw = adminAuth.requireAdmin();
  const req = mockReq(cookie, '/api/admin/dashboard/report');
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.admin.user, 'brother');
  assert.equal(req.admin.role, 'dashboard');
});

test("requireAdmin('full') — rejects dashboard-only user with 403 on API", () => {
  const cookie = adminAuth.signCookie({ user: 'brother', role: 'dashboard', iat: Date.now(), exp: Date.now() + 60_000 });
  const mw = adminAuth.requireAdmin('full');
  const req = mockReq(cookie, '/api/admin/threads');
  const res = mockRes();
  res.status = (code) => { res.status_code = code; return res; };
  res.json = (j) => { res.json_body = j; return res; };
  mw(req, res, () => { throw new Error('should not pass'); });
  assert.equal(res.status_code, 403);
  assert.equal(res.json_body.success, false);
});

test("requireAdmin('full') — accepts full role", () => {
  const cookie = adminAuth.signCookie({ user: 'ryan', role: 'full', iat: Date.now(), exp: Date.now() + 60_000 });
  const mw = adminAuth.requireAdmin('full');
  const req = mockReq(cookie, '/api/admin/threads');
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.admin.role, 'full');
});

test("requireAdmin('full') — legacy cookie without role defaults to full (backwards compat)", () => {
  // Mimic the pre-migration cookie shape that adminMessages used to emit.
  const cookie = adminAuth.signCookie({ user: 'ryan', iat: Date.now(), exp: Date.now() + 60_000 });
  const mw = adminAuth.requireAdmin('full');
  const req = mockReq(cookie, '/admin/messages');
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, true, 'legacy cookie should pass full-role gate');
});

// ---------------------------------------------------------------------------
// findAdmin — env-var admin resolves with role=full; unknown returns null.
// (Mongo path is not tested here — requires a live Mongo; we skip that in unit
//  tests and cover it separately if/when a Mongo test harness is added.)
// ---------------------------------------------------------------------------
test('findAdmin — matches env ADMIN_USERNAME (case-insensitive)', async () => {
  process.env.ADMIN_USERNAME = 'ryan';
  process.env.ADMIN_PASSWORD_HASH = '$2b$12$Dummy.Hash.Used.Only.For.Test.Resolution.No.Verify';
  const doc = await adminAuth.findAdmin('RYAN');
  assert.equal(doc.username, 'ryan');
  assert.equal(doc.role, 'full');
  assert.equal(doc.source, 'env');
  assert.equal(doc.passwordHash, process.env.ADMIN_PASSWORD_HASH);
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD_HASH;
});

test('findAdmin — null when no env admin and no Mongo', async () => {
  const doc = await adminAuth.findAdmin('nobody');
  assert.equal(doc, null);
});

test('findAdmin — trims + lowercases input', async () => {
  process.env.ADMIN_USERNAME = 'ryan';
  process.env.ADMIN_PASSWORD_HASH = 'x';
  const doc = await adminAuth.findAdmin('  Ryan  ');
  assert.ok(doc);
  assert.equal(doc.username, 'ryan');
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD_HASH;
});

test('findAdmin — empty username returns null', async () => {
  assert.equal(await adminAuth.findAdmin(''), null);
  assert.equal(await adminAuth.findAdmin(null), null);
});

// ---------------------------------------------------------------------------
// verifyPassword — bcrypt wrapper returns false on bad/missing hash.
// ---------------------------------------------------------------------------
test('verifyPassword — rejects empty hash', async () => {
  assert.equal(await adminAuth.verifyPassword('anything', ''), false);
  assert.equal(await adminAuth.verifyPassword('anything', null), false);
});

test('verifyPassword — rejects wrong password, accepts correct password', async () => {
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('correct horse battery staple', 4);  // low rounds for test speed
  assert.equal(await adminAuth.verifyPassword('wrong', hash), false);
  assert.equal(await adminAuth.verifyPassword('correct horse battery staple', hash), true);
});
