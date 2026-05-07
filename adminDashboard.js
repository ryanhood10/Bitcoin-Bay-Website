// ---------------------------------------------------------------------------
// adminDashboard.js — Express router for the internal analytics dashboard.
//
// Ported from the Flask bcbay_reports_server.py that ran on the Raspberry Pi.
// All routes are mounted under /admin/dashboard (HTML) or /api/admin/dashboard/*
// (JSON) and are protected by the shared adminAuth middleware. Any admin role
// (full or dashboard) can access this dashboard.
//
// Dashboard reads from Mongo `bcbay_automation`. Writes are limited to:
//   - bcb_engagement_drafts (PATCH status)
//   - bcb_instagram_drafts (PATCH status)
//   - bcb_run_jobs (POST /run queues a discovery-finder job for the Pi to pick up)
//
// Endpoints:
//   GET  /admin/dashboard                                       — serves dashboard HTML
//   GET  /api/admin/dashboard/report?date=YYYY-MM-DD|latest     — one daily snapshot
//   GET  /api/admin/dashboard/reports?days=N&fields=...         — historical slice
//   GET  /api/admin/dashboard/dates                             — list of known report dates
//   GET  /api/admin/dashboard/signups?status=all|success|failed — signup audit list
//   GET  /api/admin/dashboard/tickets/live                      — open support threads + counts
//   GET  /api/admin/dashboard/engagement-drafts?status=pending  — Twitter drafts
//   PATCH /api/admin/dashboard/engagement-drafts/:id            — update Twitter draft status
//   GET  /api/admin/dashboard/engagement-drafts/stats           — Twitter drafts counters
//   POST /api/admin/dashboard/engagement-drafts/run             — queue a Twitter discovery run
//   GET  /api/admin/dashboard/instagram-drafts?status=pending   — IG drafts
//   PATCH /api/admin/dashboard/instagram-drafts/:id             — update IG draft status
//   GET  /api/admin/dashboard/instagram-drafts/stats            — IG drafts counters
//   POST /api/admin/dashboard/instagram-drafts/run              — queue an IG discovery run
//   GET  /admin/dashboard/bonus-calculator                      — bonus-calculator page (FULL role only)
//   GET  /api/admin/dashboard/bonus-reports                     — last 20 weekly leaderboards (FULL role only)
//   POST /api/admin/dashboard/bonus-report                      — upsert one weekly leaderboard (FULL role only)
//
//   GET  /admin/dashboard/content                               — content-drafts page (FULL role only)
//   GET  /api/admin/dashboard/post-briefs/latest                — most recent brief metadata
//   GET  /api/admin/dashboard/post-drafts?date=...&platform=... — list draft posts
//   PATCH /api/admin/dashboard/post-drafts/:id                  — edit text/hashtags/manual-image-URL (FULL)
//   POST /api/admin/dashboard/post-drafts/:id/regenerate        — re-prompt Claude (FULL)
//   POST /api/admin/dashboard/post-drafts/:id/swap-variant      — flip Twitter draft active variant (meme ↔ professional) (FULL)
//   POST /api/admin/dashboard/post-drafts/:id/generate-art      — Replicate InstantID AI scene gen (FULL, ~$0.05/call)
//   POST /api/admin/dashboard/post-drafts/:id/regenerate-all-images — re-run image pipeline for the whole draft (FULL)
//   POST /api/admin/dashboard/post-drafts/:id/add-cta-slide     — append a BB-branded CTA slide to a carousel (FULL)
//   POST /api/admin/dashboard/post-drafts/:id/delete-slide      — remove one slide from a carousel (floor: 2 slides) (FULL)
//   GET  /api/admin/dashboard/post-drafts/:id/zip               — stream ZIP of all carousel slide images (FULL)
//   POST /api/admin/dashboard/post-drafts/:id/skip              — mark skipped (FULL)
//   POST /api/admin/dashboard/post-drafts/:id/approve           — mark approved (Phase 7 wires publish) (FULL)
//   POST /api/admin/dashboard/run-drafter                       — fire-and-forget drafter run (FULL)
//   GET  /api/admin/dashboard/game-state?event_id=&league_path=  — ESPN proxy: live score + recent plays + status (any admin)
//   POST /api/admin/dashboard/draft-from-game                    — Claude draft from current game state (FULL, ~$0.04/call)
//
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const adminAuth = require('./adminAuth');

const router = express.Router();

const MONGO_DB       = process.env.MONGO_AUTOMATION_DB || 'bcbay_automation';
const REPORTS_COLL   = process.env.MONGO_AUTOMATION_DAILY_REPORTS_COLLECTION || 'daily_reports';
const TW_DRAFTS      = 'bcb_engagement_drafts';
const IG_DRAFTS      = 'bcb_instagram_drafts';
const SIGNUPS        = 'bcb_signups';
const THREADS_COLL   = 'bcb_thread_state';
const MESSAGES_COLL  = 'bcb_messages';
const PLAYERS_COLL   = 'bcb_player_info';
const RUN_JOBS       = 'bcb_run_jobs';
const BONUS_COLL     = 'weekly_leaderboard';
const ADMIN_LOG_COLL = 'bcb_admin_log';
const POST_BRIEFS    = 'bcb_post_briefs';
const POST_DRAFTS    = 'bcb_post_drafts';

// Lazy-load contentDrafter so server boot doesn't pay the Anthropic SDK +
// sharp init cost up front. Only the /run-drafter and /:id/regenerate
// handlers ever need it. Same for imageRenderer (loads sharp + replicate
// transitively when generate-art fires).
let _contentDrafter = null;
function getContentDrafter() {
  if (!_contentDrafter) _contentDrafter = require('./contentDrafter');
  return _contentDrafter;
}
let _imageRenderer = null;
function getImageRenderer() {
  if (!_imageRenderer) _imageRenderer = require('./imageRenderer');
  return _imageRenderer;
}

// Allowed values for the Mongo update fields. Anything else is rejected at
// PATCH so a malformed UI patch can't sneak arbitrary fields into a draft doc.
const PATCH_ALLOWED = new Set([
  'text', 'caption', 'hashtags',
  'image_subject', 'image_overlay_text', 'image_scene_prompt',
  'image_url', 'image_attribution',
  'slides',
  // status changes go through dedicated endpoints (skip/approve), not PATCH
]);

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

// Coerce a date value to an ISO 8601 UTC string JS Date() can parse unambiguously.
// Mongo gives back native Date objects; Flask was emitting naive strings which we
// had to hack with a Z suffix. With mongodb driver it's simpler.
function isoUTC(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  try { return new Date(d).toISOString(); } catch (_) { return null; }
}

// Walk a Mongo doc and turn every Date into an ISO string, strip _id.
function clean(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (doc._id !== undefined) delete doc._id;
  for (const k of Object.keys(doc)) {
    const v = doc[k];
    if (v instanceof Date) doc[k] = v.toISOString();
  }
  return doc;
}

// Build a Mongo projection from a comma-separated fields list. Always include `date`.
function fieldsToProjection(fieldsParam) {
  const proj = { _id: 0 };
  if (!fieldsParam) return proj;
  proj.date = 1;
  for (const raw of fieldsParam.split(',')) {
    const f = raw.trim();
    if (f) proj[f] = 1;
  }
  return proj;
}

// ===========================================================================
// HTML page — requires any admin
// ===========================================================================
router.get('/admin/dashboard', adminAuth.requireAdmin(), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-dashboard.html'));
});

// Current admin identity — used by the dashboard JS to conditionally show
// role-specific UI (e.g., "Back to messages" button only for full admins).
router.get('/api/admin/dashboard/me', adminAuth.requireAdmin(), (req, res) => {
  res.json({ user: req.admin.user, role: req.admin.role });
});

// ===========================================================================
// ANALYTICS — reports collection
// ===========================================================================

router.get('/api/admin/dashboard/report', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const dateParam = (req.query.date || '').trim();
    const doc = await withDb(async (db) => {
      const coll = db.collection(REPORTS_COLL);
      if (dateParam === 'latest') {
        return coll.findOne({}, { sort: { date: -1 } });
      }
      if (dateParam) {
        const exact = await coll.findOne({ date: dateParam });
        if (exact) return exact;
        // Fallback: most recent
        return coll.findOne({}, { sort: { date: -1 } });
      }
      const today = new Date().toISOString().slice(0, 10);
      return (await coll.findOne({ date: today })) || coll.findOne({}, { sort: { date: -1 } });
    });
    if (!doc) return res.status(404).json({ error: 'No reports found.' });
    res.json(clean(doc));
  } catch (e) {
    console.error('[admin-dashboard] /report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/admin/dashboard/reports', adminAuth.requireAdmin(), async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days)) days = 30;
    days = Math.max(1, Math.min(days, 365));
    const projection = fieldsToProjection((req.query.fields || '').trim());
    const docs = await withDb(async (db) =>
      db.collection(REPORTS_COLL).find({}, { projection }).sort({ date: -1 }).limit(days).toArray(),
    );
    docs.sort((a, b) => (a.date || '').localeCompare(b.date || '')); // oldest-first for charts
    res.json(docs.map(clean));
  } catch (e) {
    console.error('[admin-dashboard] /reports error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/admin/dashboard/dates', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const docs = await withDb(async (db) =>
      db.collection(REPORTS_COLL).find({}, { projection: { date: 1, _id: 0 } }).sort({ date: -1 }).toArray(),
    );
    res.json(docs.map((d) => d.date).filter(Boolean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================================
// SIGNUPS — bcb_signups collection (password fields stripped)
// ===========================================================================

router.get('/api/admin/dashboard/signups', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const status = (req.query.status || 'all').trim();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 500));
    let query = {};
    if (status === 'success') query = { success: true };
    else if (status === 'failed') query = { success: false };
    const docs = await withDb(async (db) =>
      db.collection(SIGNUPS)
        .find(query, { projection: { password: 0, password2: 0 } })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray(),
    );
    res.json(docs.map(clean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================================
// TICKETS — live snapshot + currently open threads
// ===========================================================================

router.get('/api/admin/dashboard/tickets/live', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 100));
    const data = await withDb(async (db) => {
      const threads = db.collection(THREADS_COLL);
      const messages = db.collection(MESSAGES_COLL);
      const players = db.collection(PLAYERS_COLL);

      const [openCount, resolvedCount, unreadCount] = await Promise.all([
        threads.countDocuments({ resolved_at: null }),
        threads.countDocuments({ resolved_at: { $ne: null } }),
        messages.countDocuments({ direction: 'inbound', is_player_message: true, read_at: null }),
      ]);

      const openDocs = await threads.find({ resolved_at: null }).sort({ reopened_at: -1 }).limit(limit).toArray();
      const ids = openDocs.map((d) => d._id);
      const playerMap = {};
      for (const p of await players.find({ _id: { $in: ids } }).toArray()) playerMap[p._id] = p;

      const now = Date.now();
      const rows = [];
      for (const t of openDocs) {
        const pid = t._id;
        // Case-insensitive regex for login fields (they're stored mixed-case sometimes)
        const pidRe = new RegExp('^' + pid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');

        const [latest, threadUnread, lastIn, lastOut] = await Promise.all([
          messages.findOne(
            { $or: [{ from_login: pid }, { to_login: pid }] },
            { projection: { body: 1, subject: 1, direction: 1, date_mail: 1, is_player_message: 1, read_at: 1 },
              sort: { date_mail: -1 } },
          ),
          messages.countDocuments({ direction: 'inbound', is_player_message: true, from_login: pidRe, read_at: null }),
          messages.findOne({ direction: 'inbound', is_player_message: true, from_login: pidRe },
                          { projection: { date_mail: 1 }, sort: { date_mail: -1 } }),
          messages.findOne({ direction: 'outbound', to_login: pidRe },
                          { projection: { date_mail: 1 }, sort: { date_mail: -1 } }),
        ]);

        let waitingMinutes = null;
        if (lastIn && lastIn.date_mail) {
          const tIn = lastIn.date_mail.getTime();
          if (!lastOut || !lastOut.date_mail || lastOut.date_mail.getTime() < tIn) {
            waitingMinutes = +((now - tIn) / 60000).toFixed(1);
          }
        }

        const pi = playerMap[pid] || {};
        const name = ((pi.name_first || '') + ' ' + (pi.name_last || '')).trim() || null;
        rows.push({
          player_id: pid,
          player_name: name,
          email: pi.email || null,
          latest_message_text: latest ? (latest.body || '').slice(0, 200) : '',
          latest_message_direction: latest ? latest.direction : null,
          latest_message_at: latest ? isoUTC(latest.date_mail) : null,
          unread_from_player: threadUnread,
          waiting_minutes: waitingMinutes,
          reopened_at: isoUTC(t.reopened_at),
          admin_url: '/admin/messages',
        });
      }

      // Sort: unread first, then longest-waiting
      rows.sort((a, b) =>
        (b.unread_from_player - a.unread_from_player) ||
        ((b.waiting_minutes || 0) - (a.waiting_minutes || 0)),
      );

      return {
        summary: { open_count: openCount, resolved_count: resolvedCount, unread_count: unreadCount },
        threads: rows,
        admin_url: '/admin/messages',
      };
    });
    res.json(data);
  } catch (e) {
    console.error('[admin-dashboard] /tickets/live error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================================
// DRAFTS — shared helpers for Twitter + Instagram engagement drafts
// ===========================================================================

function makeDraftEndpoints(basePath, collName) {
  router.get(`${basePath}`, adminAuth.requireAdmin(), async (req, res) => {
    try {
      const status = (req.query.status || 'pending').trim();
      const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
      const query = status === 'all' ? {} : { status };
      const docs = await withDb(async (db) =>
        db.collection(collName).find(query).sort({ created_at: -1 }).limit(limit).toArray(),
      );
      res.json(docs.map((d) => { d._id = d._id.toString(); return clean(d); }));
    } catch (e) {
      console.error(`[admin-dashboard] GET ${basePath} error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.patch(`${basePath}/:id`, adminAuth.requireAdmin(), async (req, res) => {
    try {
      const newStatus = (req.body && req.body.status) || '';
      if (!['pending', 'posted', 'dismissed'].includes(newStatus)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      const update = { status: newStatus };
      if (newStatus === 'posted') update.posted_at = new Date();
      else if (newStatus === 'dismissed') update.dismissed_at = new Date();
      let objectId;
      try { objectId = new ObjectId(req.params.id); } catch (_) {
        return res.status(400).json({ error: 'invalid id' });
      }
      const result = await withDb(async (db) =>
        db.collection(collName).updateOne({ _id: objectId }, { $set: update }),
      );
      res.json({ matched: result.matchedCount, modified: result.modifiedCount });
    } catch (e) {
      console.error(`[admin-dashboard] PATCH ${basePath}/:id error:`, e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.get(`${basePath}/stats`, adminAuth.requireAdmin(), async (req, res) => {
    try {
      const data = await withDb(async (db) => {
        const coll = db.collection(collName);
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 86400000);
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const byStatus = { pending: 0, posted: 0, dismissed: 0 };
        for (const row of await coll.aggregate([
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ]).toArray()) {
          if (byStatus[row._id] !== undefined) byStatus[row._id] = row.n;
        }

        const [postedThisWeek, draftedThisWeek, postedToday, latest] = await Promise.all([
          coll.countDocuments({ status: 'posted', posted_at: { $gte: weekAgo } }),
          coll.countDocuments({ created_at: { $gte: weekAgo } }),
          coll.countDocuments({ status: 'posted', posted_at: { $gte: todayStart } }),
          coll.findOne({}, { projection: { created_at: 1 }, sort: { created_at: -1 } }),
        ]);

        return {
          pending: byStatus.pending,
          posted: byStatus.posted,
          dismissed: byStatus.dismissed,
          total: byStatus.pending + byStatus.posted + byStatus.dismissed,
          drafted_this_week: draftedThisWeek,
          posted_this_week: postedThisWeek,
          posted_today: postedToday,
          latest_draft_at: latest ? isoUTC(latest.created_at) : null,
        };
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

makeDraftEndpoints('/api/admin/dashboard/engagement-drafts', TW_DRAFTS);
makeDraftEndpoints('/api/admin/dashboard/instagram-drafts', IG_DRAFTS);

// ===========================================================================
// RUN-NOW — queue a discovery-finder job for the Pi to pick up.
// The Pi runs a tiny poller that watches bcb_run_jobs for new queued jobs and
// executes the corresponding Python script.
// ===========================================================================

async function queueRunJob(jobName, requestedBy) {
  return await withDb(async (db) =>
    db.collection(RUN_JOBS).insertOne({
      job: jobName,
      status: 'queued',
      requested_by: requestedBy,
      requested_at: new Date(),
      started_at: null,
      finished_at: null,
      error: null,
    }),
  );
}

router.post('/api/admin/dashboard/engagement-drafts/run', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const r = await queueRunJob('twitter_engagement', req.admin?.user || 'unknown');
    res.status(202).json({ started: true, queued: true, job_id: r.insertedId.toString(),
                          message: 'Twitter engagement finder queued — Pi will pick up within ~60s' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/dashboard/instagram-drafts/run', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const r = await queueRunJob('instagram_engagement', req.admin?.user || 'unknown');
    res.status(202).json({ started: true, queued: true, job_id: r.insertedId.toString(),
                          message: 'Instagram engagement finder queued — Pi will pick up within ~60s' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================================
// BONUS CALCULATOR — weekly leaderboard tool. FULL role only — this writes
// to the same `weekly_leaderboard` collection that the public /leaderboard
// page reads from, so a bad save would corrupt the live leaderboard.
// ===========================================================================

// Fire-and-forget audit log. Mirrors adminMessages.logAdminAction so both
// admin surfaces write to the same bcb_admin_log collection.
async function logAdminAction(record) {
  try {
    await withDb(async (db) =>
      db.collection(ADMIN_LOG_COLL).insertOne({ ...record, created_at: new Date() })
    );
  } catch (err) {
    console.error('[admin-dashboard] audit log failed:', err.message);
  }
}

router.get('/admin/dashboard/bonus-calculator', adminAuth.requireAdmin(adminAuth.ROLE_FULL), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'bonus-calculator.html'));
});

router.get('/api/admin/dashboard/bonus-reports', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const docs = await withDb(async (db) =>
      db.collection(BONUS_COLL)
        .find({}, { projection: { _id: 0, week_start: 1, week_end: 1, volume_threshold: 1, generated_at: 1, updated_at: 1, bonuses: 1 } })
        .sort({ updated_at: -1 })
        .limit(limit)
        .toArray(),
    );
    res.json(docs.map(clean));
  } catch (e) {
    console.error('[admin-dashboard] /bonus-reports error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/dashboard/bonus-report', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.week_start || !payload.week_end) {
      return res.status(400).json({ error: 'Missing week_start or week_end in payload' });
    }
    if (!Array.isArray(payload.bonuses)) {
      return res.status(400).json({ error: 'Missing bonuses array in payload' });
    }
    const result = await withDb(async (db) =>
      db.collection(BONUS_COLL).updateOne(
        { week_start: payload.week_start, week_end: payload.week_end },
        { $set: { ...payload, updated_at: new Date() } },
        { upsert: true },
      ),
    );
    const action = result.upsertedCount ? 'inserted' : 'updated';
    // Audit — non-blocking, best-effort
    logAdminAction({
      user: req.admin?.user || 'unknown',
      role: req.admin?.role || null,
      action: 'bonus_report_' + action,
      week_start: payload.week_start,
      week_end: payload.week_end,
      accounts: payload.bonuses.length,
    }).catch(() => {});
    res.json({
      success: true,
      action,
      week_start: payload.week_start,
      week_end: payload.week_end,
      accounts: payload.bonuses.length,
    });
  } catch (e) {
    console.error('[admin-dashboard] /bonus-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================================
// CONTENT DRAFTER (Phase 5+6)
// All write/regen/approve endpoints FULL-role only — these trigger Anthropic
// spend (regenerate, run-drafter) and will eventually publish to live X/IG
// accounts (Phase 7). The dashboard-role admin can never touch them.
// ===========================================================================

// HTML page (Phase 5) — full-role only because every action on this page is
// full-role anyway, no point teasing dashboard-role admins with a UI they
// can't use.
router.get('/admin/dashboard/content', adminAuth.requireAdmin(adminAuth.ROLE_FULL), (req, res) => {
  // No-store: the SPA's JS lives inline in this HTML, so caching it would
  // pin operators on stale code after a deploy. The page is small and only
  // requested by full-role admins, so the cache miss is cheap.
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'views', 'content-drafts.html'));
});

// Latest brief metadata — used by the dashboard to render an "as of" chip.
// Read-only; any admin role can see this.
router.get('/api/admin/dashboard/post-briefs/latest', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const doc = await withDb(async (db) =>
      db.collection(POST_BRIEFS).findOne({}, { sort: { date: -1 }, projection: {
        _id: 0, date: 1, saved_at: 1,
        'blog_research.topic_category': 1, 'blog_research.topic': 1,
        'per_platform_topics.twitter': 1, 'per_platform_topics.instagram.format_hint': 1,
      } })
    );
    if (!doc) return res.status(404).json({ success: false, error: 'No brief found' });
    res.json({ success: true, brief: clean(doc) });
  } catch (e) {
    console.error('[admin-dashboard] /post-briefs/latest error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// List drafts. Filters: ?date=YYYY-MM-DD (defaults to latest brief),
//                       ?platform=twitter|instagram_single|instagram_carousel,
//                       ?status=draft|approved|posted|skipped (default: all).
router.get('/api/admin/dashboard/post-drafts', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const filter = {};
    if (req.query.date) filter.brief_date = String(req.query.date);
    if (req.query.platform) filter.platform = String(req.query.platform);
    if (req.query.status) filter.status = String(req.query.status);

    const docs = await withDb(async (db) => {
      const coll = db.collection(POST_DRAFTS);
      // If no date filter, default to the latest brief_date so the operator
      // sees today's batch by default.
      if (!filter.brief_date) {
        const latest = await coll.findOne({}, { sort: { brief_date: -1 }, projection: { brief_date: 1 } });
        if (latest?.brief_date) filter.brief_date = latest.brief_date;
      }
      return coll.find(filter).sort({ platform: 1, created_at: 1 }).toArray();
    });

    // Stringify _ids and clean dates so the dashboard JS can pass them
    // back as path parameters easily.
    const out = docs.map((d) => {
      const id = d._id?.toString();
      delete d._id;
      for (const k of Object.keys(d)) {
        if (d[k] instanceof Date) d[k] = d[k].toISOString();
      }
      return { _id: id, ...d };
    });
    res.json({ success: true, drafts: out });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts list error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Edit a draft. Whitelist of allowed fields: text/caption/hashtags/image_*/slides.
// Status transitions go through dedicated /skip and /approve endpoints — not here.
router.patch('/api/admin/dashboard/post-drafts/:id', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const body = req.body || {};
    const updates = {};
    for (const k of Object.keys(body)) {
      if (PATCH_ALLOWED.has(k)) updates[k] = body[k];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'no allowed fields in body' });
    }
    // Light shape checks on the riskier fields
    if (updates.hashtags && !Array.isArray(updates.hashtags)) {
      return res.status(400).json({ success: false, error: 'hashtags must be an array' });
    }
    if (updates.slides && !Array.isArray(updates.slides)) {
      return res.status(400).json({ success: false, error: 'slides must be an array' });
    }
    updates.updated_at = new Date();

    const result = await withDb(async (db) =>
      db.collection(POST_DRAFTS).updateOne({ _id: new ObjectId(id) }, { $set: updates })
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    await logAdminAction({
      action: 'content-drafter:patch',
      admin: req.admin?.user, draft_id: id, fields: Object.keys(updates).filter((k) => k !== 'updated_at'),
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts PATCH error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Regenerate a draft. Body: { humor_pass?: bool, slide_index?: number, new_angle?: string }
// slide_index regenerates one carousel slide; full-card regen otherwise.
router.post('/api/admin/dashboard/post-drafts/:id/regenerate', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const body = req.body || {};
    const opts = {
      humorPass: !!body.humor_pass,
      slideIndex: Number.isInteger(body.slide_index) ? body.slide_index : null,
      newAngle: typeof body.new_angle === 'string' ? body.new_angle : null,
    };
    const result = await getContentDrafter().regenerateDraft(id, opts);
    await logAdminAction({
      action: 'content-drafter:regenerate',
      admin: req.admin?.user, draft_id: id, ...opts,
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/regenerate error:', e.message);
    const code = /not found/i.test(e.message) ? 404 : 500;
    res.status(code).json({ success: false, error: e.message });
  }
});

// Swap the active variant on a Twitter draft (meme ↔ professional). No Claude
// call — both variants are pre-generated by runDrafter (Phase 6.2). The
// top-level fields (text, hashtags, image_overlay_text, image_scene_prompt,
// takeaway_one_liner) are mirrored from the new active variant so the rest
// of the pipeline (PATCH/approve/render) keeps using the same shape.
router.post('/api/admin/dashboard/post-drafts/:id/swap-variant', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const draft = await withDb((db) => db.collection(POST_DRAFTS).findOne({ _id: new ObjectId(id) }));
    if (!draft) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    if (!Array.isArray(draft.variants) || draft.variants.length < 2) {
      return res.status(409).json({ success: false, error: 'draft has no alternate variant' });
    }
    const currentIdx = Number.isInteger(draft.active_variant_index) ? draft.active_variant_index : 0;
    const newIdx = currentIdx === 0 ? 1 : 0;
    const newActive = draft.variants[newIdx];
    if (!newActive) {
      return res.status(409).json({ success: false, error: `variants[${newIdx}] missing` });
    }
    await withDb((db) => db.collection(POST_DRAFTS).updateOne(
      { _id: new ObjectId(id) },
      { $set: {
        active_variant_index: newIdx,
        text: newActive.text,
        hashtags: newActive.hashtags,
        image_overlay_text: newActive.image_overlay_text,
        image_scene_prompt: newActive.image_scene_prompt,
        takeaway_one_liner: newActive.takeaway_one_liner,
        updated_at: new Date(),
      }}
    ));
    await logAdminAction({
      action: 'content-drafter:swap-variant',
      admin: req.admin?.user, draft_id: id,
      new_index: newIdx, new_kind: newActive.variant_kind,
    });
    res.json({ success: true, active_variant_index: newIdx, variant_kind: newActive.variant_kind });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/swap-variant error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Generate AI scene image for a draft (Replicate InstantID). Operator-only
// via the dashboard 🎨 button. Real-person face preservation: takes a
// reference image (Wikimedia photo of the athlete) + a scene prompt, returns
// a generated JPEG with the athlete's actual likeness in the new scene.
//
// Body:
//   - scene_prompt        : string, required, min 10 chars
//   - reference_image_url : string, optional — defaults to draft.image_url
//                           (or slides[i].image_url for carousel), or a fresh
//                           Wikimedia lookup of image_subject if neither
//   - slide_index         : integer, required for instagram_carousel only
//
// Returns 503 if REPLICATE_API_TOKEN is missing. Cost ~$0.05/call,
// audit-logged with the model + prompt.
router.post('/api/admin/dashboard/post-drafts/:id/generate-art', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const body = req.body || {};
    const scenePrompt = String(body.scene_prompt || '').trim();
    if (scenePrompt.length < 10) {
      return res.status(400).json({ success: false, error: 'scene_prompt required (min 10 chars)' });
    }
    if (!process.env.REPLICATE_API_TOKEN) {
      return res.status(503).json({ success: false, error: 'REPLICATE_API_TOKEN not configured' });
    }
    const slideIndex = Number.isInteger(body.slide_index) ? body.slide_index : null;
    const refOverride = typeof body.reference_image_url === 'string' && body.reference_image_url.trim()
      ? body.reference_image_url.trim() : null;

    const draft = await withDb((db) => db.collection(POST_DRAFTS).findOne({ _id: new ObjectId(id) }));
    if (!draft) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }

    let isCarouselSlide = false;
    let referenceImageUrl;
    if (draft.platform === 'instagram_carousel') {
      if (slideIndex == null) {
        return res.status(400).json({ success: false, error: 'slide_index required for carousel drafts' });
      }
      const slide = (draft.slides || [])[slideIndex];
      if (!slide) {
        return res.status(400).json({ success: false, error: `slide_index ${slideIndex} out of range` });
      }
      isCarouselSlide = true;
      referenceImageUrl = refOverride || slide.image_url || null;
    } else {
      referenceImageUrl = refOverride || draft.image_url || null;
    }

    // No reference yet — fall back to a fresh Wikimedia lookup of the subject
    // so InstantID can preserve the athlete's actual face. Without a face
    // reference, InstantID degrades to vanilla SDXL with no likeness.
    if (!referenceImageUrl) {
      const subject = isCarouselSlide
        ? draft.slides[slideIndex].image_subject
        : draft.image_subject;
      if (subject) {
        const hit = await getImageRenderer().findHeroImage(subject);
        if (hit?.url) referenceImageUrl = hit.url;
      }
    }
    if (!referenceImageUrl) {
      return res.status(400).json({ success: false,
        error: 'no reference image available — paste one via reference_image_url or set image_subject so we can fetch one' });
    }

    const date = draft.brief_date || new Date().toISOString().slice(0, 10);
    const outPath = isCarouselSlide
      ? path.join(__dirname, 'public', 'post-images', date, id, `slide-${slideIndex}-ai.jpg`)
      : path.join(__dirname, 'public', 'post-images', date, id, 'main-ai.jpg');

    const generated = await getImageRenderer().generateAIScene({
      scenePrompt, referenceImageUrl, outPath,
    });

    // Persist new URL; preserve old one as `image_url_previous` so the operator
    // can revert from the UI without re-rendering.
    let updateOp;
    if (isCarouselSlide) {
      updateOp = {
        $set: {
          [`slides.${slideIndex}.image_url`]: generated.url,
          [`slides.${slideIndex}.image_url_previous`]: draft.slides[slideIndex].image_url || null,
          [`slides.${slideIndex}.composite_url`]: null,
          [`slides.${slideIndex}.image_attribution`]: generated.attribution,
          [`slides.${slideIndex}.image_source`]: 'replicate',
          updated_at: new Date(),
        },
      };
    } else {
      updateOp = {
        $set: {
          image_url: generated.url,
          image_url_previous: draft.image_url || null,
          image_attribution: generated.attribution,
          image_source: 'replicate',
          updated_at: new Date(),
        },
      };
    }
    await withDb((db) => db.collection(POST_DRAFTS).updateOne({ _id: new ObjectId(id) }, updateOp));
    await logAdminAction({
      action: 'content-drafter:generate-art',
      admin: req.admin?.user,
      draft_id: id,
      slide_index: slideIndex,
      model: generated.model,
      cost_estimate_usd: 0.05,
      scene_prompt: scenePrompt,
      reference_image_url: referenceImageUrl,
    });
    res.json({ success: true, image_url: generated.url, source: 'replicate', model: generated.model });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/generate-art error:', e.message);
    const code = /not found/i.test(e.message) ? 404 : 500;
    res.status(code).json({ success: false, error: e.message });
  }
});

// Re-run the image pipeline for the entire draft. Use case: operator edited
// slide subjects / overlay coords / colors and wants fresh composites without
// re-prompting Claude for the deck text. Fire-and-forget — returns 202.
router.post('/api/admin/dashboard/post-drafts/:id/regenerate-all-images', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const draft = await withDb((db) => db.collection(POST_DRAFTS).findOne({ _id: new ObjectId(id) }));
    if (!draft) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    // Fire and forget — don't block the response
    Promise.resolve()
      .then(async () => {
        const patch = await getImageRenderer().saveDraftImages(draft, { draftId: id });
        await withDb((db) => db.collection(POST_DRAFTS).updateOne(
          { _id: new ObjectId(id) },
          { $set: { ...patch, updated_at: new Date() } }
        ));
        await logAdminAction({
          action: 'content-drafter:regenerate-all-images',
          admin: req.admin?.user, draft_id: id,
          slides_count: Array.isArray(patch.slides) ? patch.slides.length : null,
        });
      })
      .catch((err) => console.error('[admin-dashboard] regenerate-all-images bg error:', err.message));
    res.status(202).json({ success: true, accepted: true,
      note: 'Image regeneration started. Poll /post-drafts in ~30s for fresh URLs.' });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/regenerate-all-images error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Append a BB-branded CTA slide to a carousel draft. Body:
//   - headline?: string (default "Sharp picks. Bitcoin only.")
//   - subhead?:  string (default "bitcoinbay.com")
// Renders via composeBrandedCard (BB logo + headline + brand palette).
// Caps the slides[] at 10 (Meta's hard limit; we typically cap at 5 in Claude
// output but allow this manual extension up to 10).
router.post('/api/admin/dashboard/post-drafts/:id/add-cta-slide', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const draft = await withDb((db) => db.collection(POST_DRAFTS).findOne({ _id: new ObjectId(id) }));
    if (!draft) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    if (draft.platform !== 'instagram_carousel') {
      return res.status(409).json({ success: false, error: 'CTA slide only valid on instagram_carousel drafts' });
    }
    const slides = Array.isArray(draft.slides) ? draft.slides : [];
    if (slides.length >= 10) {
      return res.status(409).json({ success: false, error: 'carousel already at max 10 slides' });
    }

    const headline = (req.body?.headline || 'Sharp picks. Bitcoin only.').toString().slice(0, 80);
    const subhead = (req.body?.subhead || 'bitcoinbay.com').toString().slice(0, 80);

    const date = draft.brief_date || new Date().toISOString().slice(0, 10);
    const newIdx = slides.length;
    const outPath = path.join(__dirname, 'public', 'post-images', date, id, `slide-${newIdx}.jpg`);
    const composite = await getImageRenderer().composeBrandedCard({
      headline, subhead, kind: 'promo', outPath,
    });

    const newSlide = {
      slide_role: 'cta',
      image_subject: 'Bitcoin Bay CTA',
      headline,
      body_text: subhead,
      image_url: composite.url,
      composite_url: composite.url,
      image_attribution: composite.attribution,
      image_source: 'branded',
      source_url: null,
      is_cta_slide: true,
    };
    const newSlides = [...slides, newSlide];

    await withDb((db) => db.collection(POST_DRAFTS).updateOne(
      { _id: new ObjectId(id) },
      { $set: { slides: newSlides, updated_at: new Date() } }
    ));
    await logAdminAction({
      action: 'content-drafter:add-cta-slide',
      admin: req.admin?.user, draft_id: id, headline, subhead,
    });
    res.json({ success: true, slide_index: newIdx, slides_count: newSlides.length });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/add-cta-slide error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Remove one slide from a carousel. Body: { slide_index: <number> }.
// Floor at 2 slides — Meta requires at least 2 images for a carousel and
// operator confirmed minimum during Phase 9 planning.
router.post('/api/admin/dashboard/post-drafts/:id/delete-slide', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const slideIndex = Number(req.body?.slide_index);
    if (!Number.isInteger(slideIndex) || slideIndex < 0) {
      return res.status(400).json({ success: false, error: 'slide_index required (non-negative integer)' });
    }
    const draft = await withDb((db) => db.collection(POST_DRAFTS).findOne({ _id: new ObjectId(id) }));
    if (!draft) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    if (draft.platform !== 'instagram_carousel') {
      return res.status(409).json({ success: false, error: 'delete-slide only valid on instagram_carousel drafts' });
    }
    const slides = Array.isArray(draft.slides) ? draft.slides : [];
    if (slideIndex >= slides.length) {
      return res.status(400).json({ success: false, error: `slide_index ${slideIndex} out of range` });
    }
    if (slides.length <= 2) {
      return res.status(409).json({ success: false, error: 'carousel must have at least 2 slides' });
    }

    const removed = slides[slideIndex];
    const newSlides = slides.filter((_, i) => i !== slideIndex);

    await withDb((db) => db.collection(POST_DRAFTS).updateOne(
      { _id: new ObjectId(id) },
      { $set: { slides: newSlides, updated_at: new Date() } }
    ));
    await logAdminAction({
      action: 'content-drafter:delete-slide',
      admin: req.admin?.user,
      draft_id: id,
      slide_index: slideIndex,
      removed_role: removed?.slide_role || null,
      removed_subject: removed?.image_subject || null,
      slides_count_after: newSlides.length,
    });
    res.json({ success: true, slide_index: slideIndex, slides_count: newSlides.length });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/delete-slide error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stream a ZIP of all carousel slide JPEGs for one draft. Source files live
// on the dyno's local filesystem under public/post-images/{date}/{id}/. Heads
// up: Heroku's filesystem is ephemeral — files older than the last dyno
// restart will be missing and the endpoint returns 404.
router.get('/api/admin/dashboard/post-drafts/:id/zip', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const draft = await withDb((db) => db.collection(POST_DRAFTS).findOne({ _id: new ObjectId(id) }));
    if (!draft) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    const slides = Array.isArray(draft.slides) ? draft.slides : [];
    if (slides.length === 0) {
      return res.status(400).json({ success: false, error: 'draft has no slides' });
    }
    const date = draft.brief_date || new Date().toISOString().slice(0, 10);
    const dir = path.join(__dirname, 'public', 'post-images', date, id);

    // Inventory which slide files exist on disk (prefer AI scene over composite)
    const filesToZip = [];
    for (let i = 0; i < slides.length; i++) {
      const aiPath = path.join(dir, `slide-${i}-ai.jpg`);
      const compositePath = path.join(dir, `slide-${i}.jpg`);
      const filePath = fs.existsSync(aiPath) ? aiPath
                     : (fs.existsSync(compositePath) ? compositePath : null);
      if (filePath) filesToZip.push({ filePath, name: `slide-${i + 1}.jpg` });
    }
    if (filesToZip.length === 0) {
      return res.status(404).json({ success: false,
        error: 'no slide images found on disk (dyno restart wiped them — re-render via 🔁 Regen all images)' });
    }

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('[admin-dashboard] ZIP archive error:', err.message);
      try { res.status(500).end(); } catch (_) {}
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="bbay-${id}-slides.zip"`);
    archive.pipe(res);
    for (const f of filesToZip) archive.file(f.filePath, { name: f.name });
    await archive.finalize();

    await logAdminAction({
      action: 'content-drafter:zip-download',
      admin: req.admin?.user, draft_id: id, slides_count: filesToZip.length,
    });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/zip error:', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
  }
});

// Skip a draft. Body: { reason?: string }
router.post('/api/admin/dashboard/post-drafts/:id/skip', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const reason = (req.body?.reason || '').toString().trim().slice(0, 500);
    const result = await withDb(async (db) =>
      db.collection(POST_DRAFTS).updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'skipped', skip_reason: reason || null, updated_at: new Date() } }
      )
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    await logAdminAction({
      action: 'content-drafter:skip',
      admin: req.admin?.user, draft_id: id, reason,
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/skip error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Approve. Phase 6 just marks status='approved' and audit-logs. Phase 7 will
// extend this handler to call socialPublisher and flip to 'posted' on success.
router.post('/api/admin/dashboard/post-drafts/:id/approve', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const draft = await withDb((db) => db.collection(POST_DRAFTS).findOne({ _id: new ObjectId(id) }));
    if (!draft) {
      return res.status(404).json({ success: false, error: 'draft not found' });
    }
    if (draft.status === 'posted') {
      return res.status(409).json({ success: false, error: 'already posted' });
    }
    await withDb((db) => db.collection(POST_DRAFTS).updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'approved', approved_at: new Date(), updated_at: new Date(),
                approved_by: req.admin?.user || null } }
    ));
    await logAdminAction({
      action: 'content-drafter:approve',
      admin: req.admin?.user, draft_id: id, platform: draft.platform,
    });
    // Phase 7 will inline-call socialPublisher.publishX(draft) here.
    res.json({ success: true, status: 'approved', published: false,
               note: 'Publish wiring lands in Phase 7 — for now, copy text/image to native X/IG manually.' });
  } catch (e) {
    console.error('[admin-dashboard] /post-drafts/approve error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Phase 8 — game state on demand ───────────────────────────────────────
// ESPN's free public scoreboard/summary API drives a "Today's games" panel.
// The Pi nightly populates `bcb_post_briefs.todays_games` with the day's
// most popular games. Operator clicks "Live state" → /game-state proxies
// to ESPN summary. Operator clicks "Draft tweet" → /draft-from-game pulls
// state + drafts via Claude. ESPN is free; only Claude costs money and
// only when operator clicks Draft (~$0.04/call, 2 variants like normal X).

// Whitelist the 7 league paths the Pi populates. Prevents SSRF (operator
// could otherwise paste any league_path; defense-in-depth even though
// /game-state is GET-only and the host is hardcoded ESPN below).
const ESPN_ALLOWED_LEAGUES = new Set([
  'basketball/nba',
  'football/nfl',
  'baseball/mlb',
  'hockey/nhl',
  'mma/ufc',
  'football/college-football',
  'soccer/usa.1',
]);

// Tiny in-memory cache so back-to-back operator clicks don't hammer ESPN.
// 30s TTL is enough — game state moves slower than that anyway.
const _gameStateCache = new Map();
function _cacheKey(eventId, leaguePath) { return `${leaguePath}|${eventId}`; }

async function fetchEspnGameState(eventId, leaguePath) {
  const cacheKey = _cacheKey(eventId, leaguePath);
  const cached = _gameStateCache.get(cacheKey);
  if (cached && (Date.now() - cached.t) < 30_000) return cached.data;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/summary?event=${encodeURIComponent(eventId)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'BitcoinBay-Dashboard/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  const raw = await r.json();
  // Trim to just what the dashboard / drafter needs
  const header = raw.header || {};
  const comp = (header.competitions || [{}])[0];
  const comps = comp.competitors || [];
  const away = comps.find((c) => c.homeAway === 'away') || {};
  const home = comps.find((c) => c.homeAway === 'home') || {};
  const plays = (raw.plays || []).slice(-5).map((p) => ({
    period: (p.period || {}).number,
    clock: (p.clock || {}).displayValue,
    text: (p.text || '').slice(0, 200),
    score_value: p.scoreValue,
  }));
  const winProb = raw.winprobability;
  const last_winprob = Array.isArray(winProb) && winProb.length
    ? winProb[winProb.length - 1] : null;
  const trimmed = {
    away: { name: (away.team || {}).displayName, abbr: (away.team || {}).abbreviation, score: away.score },
    home: { name: (home.team || {}).displayName, abbr: (home.team || {}).abbreviation, score: home.score },
    status: (comp.status || {}).type ? (comp.status.type.shortDetail || '') : '',
    state: (comp.status || {}).type ? (comp.status.type.state || '') : '',  // pre|in|post
    plays,
    win_probability: last_winprob ? {
      away_pct: Math.round((last_winprob.awayWinPercentage || 0) * 100),
      home_pct: Math.round((last_winprob.homeWinPercentage || 0) * 100),
    } : null,
    broadcast: ((comp.broadcasts || []).flatMap((b) => b.names || []).join(', ')) || null,
  };
  _gameStateCache.set(cacheKey, { t: Date.now(), data: trimmed });
  return trimmed;
}

// GET /game-state?event_id=X&league_path=basketball/nba
router.get('/api/admin/dashboard/game-state', adminAuth.requireAdmin(), async (req, res) => {
  try {
    const eventId = String(req.query.event_id || '').trim();
    const leaguePath = String(req.query.league_path || '').trim();
    if (!eventId || !/^\d+$/.test(eventId)) {
      return res.status(400).json({ success: false, error: 'event_id (numeric) required' });
    }
    if (!ESPN_ALLOWED_LEAGUES.has(leaguePath)) {
      return res.status(400).json({ success: false, error: `league_path must be one of: ${[...ESPN_ALLOWED_LEAGUES].join(', ')}` });
    }
    const state = await fetchEspnGameState(eventId, leaguePath);
    res.json({ success: true, ...state });
  } catch (e) {
    console.error('[admin-dashboard] /game-state error:', e.message);
    res.status(502).json({ success: false, error: `ESPN fetch failed: ${e.message}` });
  }
});

// POST /draft-from-game  body: { event_id, league_path }
// Pulls ESPN game state, calls contentDrafter.draftFromGameState() to build
// a one-shot Twitter draft (2 variants), inserts into bcb_post_drafts, and
// returns the new draft id. Audit-logged with the cost estimate.
router.post('/api/admin/dashboard/draft-from-game', adminAuth.requireAdmin(adminAuth.ROLE_FULL), async (req, res) => {
  try {
    const eventId = String(req.body?.event_id || '').trim();
    const leaguePath = String(req.body?.league_path || '').trim();
    if (!eventId || !/^\d+$/.test(eventId)) {
      return res.status(400).json({ success: false, error: 'event_id (numeric) required' });
    }
    if (!ESPN_ALLOWED_LEAGUES.has(leaguePath)) {
      return res.status(400).json({ success: false, error: 'league_path not in allowed list' });
    }
    const state = await fetchEspnGameState(eventId, leaguePath);
    const result = await getContentDrafter().draftFromGameState({
      gameState: state,
      eventId,
      leaguePath,
    });
    await logAdminAction({
      action: 'content-drafter:draft-from-game',
      admin: req.admin?.user,
      event_id: eventId,
      league_path: leaguePath,
      cost_estimate_usd: 0.04,
      draft_id: result.draft_id,
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[admin-dashboard] /draft-from-game error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Run drafter — fire-and-forget. Returns 202 immediately so the dashboard
// can poll /post-drafts to see drafts land. Async pattern matches Eldrin's.
router.post('/api/admin/dashboard/run-drafter', adminAuth.requireAdmin(adminAuth.ROLE_FULL), (req, res) => {
  const briefDate = (req.body?.date || '').toString().trim() || undefined;
  const adminUser = req.admin?.user;

  // Fire and forget — don't await
  Promise.resolve()
    .then(() => getContentDrafter().runDrafter({ briefDate }))
    .then((out) => {
      logAdminAction({
        action: 'content-drafter:run',
        admin: adminUser, brief_date: out.brief_date, drafts_count: out.drafts_count,
      }).catch(() => {});
      console.log(`[admin-dashboard] runDrafter complete for ${out.brief_date}: ${out.drafts_count} drafts`);
    })
    .catch((e) => {
      console.error('[admin-dashboard] runDrafter background error:', e.message);
      logAdminAction({
        action: 'content-drafter:run-failed',
        admin: adminUser, brief_date: briefDate, error: e.message,
      }).catch(() => {});
    });

  res.status(202).json({ success: true, accepted: true,
    note: 'Drafter started in background. Poll /api/admin/dashboard/post-drafts in ~30-60s for results.' });
});

module.exports = router;
