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
//
// ---------------------------------------------------------------------------

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

module.exports = router;
