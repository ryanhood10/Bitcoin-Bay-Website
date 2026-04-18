// ---------------------------------------------------------------------------
// messagesSync.js — periodic poll of the wager inbox into our own Mongo +
// SMS alerts to the operator when player messages arrive.
//
// The wager backend has no webhook for new messages, so we poll. Every
// SYNC_INTERVAL_MS we fetch both buckets (inbox + sent), diff against what
// we've already stored, insert the new ones, and fire SMS alerts for any
// inbound player message (FromType === 'C').
//
// First-run behavior: on a brand-new database, we treat every existing
// message as "already seen" so we don't blast SMS for an inbox-full of
// historical bonus announcements. Only NEW messages arriving after sync
// starts will trigger alerts.
//
// Alert behavior:
//   - Aggregated per-sender: 5 messages from one player in a single sync
//     window collapse into ONE SMS ("3 new from Ryan Hood").
//   - Self-retry on Twilio failure: messages with alerted_at: null from
//     the last 24h are reprocessed every sync cycle, so a Twilio outage
//     doesn't lose alerts — they fire when service recovers.
//   - Optional quiet hours via SMS_QUIET_HOURS env var ("22-8" = 10pm-8am
//     in SMS_TIMEZONE, default America/Chicago).
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');
const agentClient = require('./agentClient');

const MONGO_DB        = 'bcbay_automation';
const MESSAGES_COLL   = 'bcb_messages';
const PLAYERS_COLL    = 'bcb_player_info';
const SYNC_INTERVAL_MS = 3 * 60 * 1000;   // 3 min
const ALERT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_URL = 'bitcoinbay.com/admin/messages';

let _syncInterval = null;
let _initialized  = false;

// Tag a message with the fields our dashboard cares about, in addition to
// the raw wager fields. Keyed on `wager_id` (the wager backend's Id).
// `direction` is determined by which bucket we pulled it from: type=0 inbox
// is inbound, type=1 sent is outbound.
function shapeMessage(m, direction) {
  return {
    wager_id:    m.Id,
    from_login:  (m.FromELogin || m.FromE || '').trim(),
    to_login:    (m.ToELogin   || m.ToE   || '').trim(),
    from_type:   m.FromType,
    to_type:     m.ToType,
    subject:     m.Subject,
    body:        m.Message,
    message_type: m.MessageType,
    parent_id:   m.PadreID,
    correlation_id: m.CorrelationID,
    date_mail:   m.DateMail ? new Date(m.DateMail.replace(' ', 'T') + 'Z') : null,
    raw:         m,
    is_player_message: direction === 'inbound' && m.FromType === 'C',
    direction,
    seen_at:     new Date(),
  };
}

// ---------------------------------------------------------------------------
// Alert transports. Pushover is preferred for operator alerts (no 10DLC /
// A2P compliance — it's push notifications, not SMS). Twilio stays as a
// fallback and for other SMS uses (password resets, 2FA, client outreach
// once 10DLC registration is approved).
// ---------------------------------------------------------------------------
function isPushoverConfigured() {
  return !!(process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN);
}

function isTwilioConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_API_KEY_SID &&
    process.env.TWILIO_API_KEY_SECRET &&
    process.env.TWILIO_FROM_NUMBER &&
    process.env.OPERATOR_PHONE_NUMBER
  );
}

// Send via Pushover — a single HTTPS POST, no SDK required. Returns on
// success, throws on non-2xx or Pushover-reported error.
async function sendPushover({ title, message, url }) {
  const body = new URLSearchParams({
    token:   process.env.PUSHOVER_APP_TOKEN,
    user:    process.env.PUSHOVER_USER_KEY,
    title:   title || 'Bitcoin Bay',
    message: message || '',
  });
  if (url) body.set('url', url);

  const r = await fetch('https://api.pushover.net/1/messages.json', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.status !== 1) {
    const err = data && Array.isArray(data.errors) ? data.errors.join('; ') : `HTTP ${r.status}`;
    throw new Error('Pushover rejected: ' + err);
  }
  return { ok: true, id: data.request };
}

let _twilioClient = null;
function getTwilioClient() {
  if (_twilioClient) return _twilioClient;
  const twilio = require('twilio');
  _twilioClient = twilio(
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { accountSid: process.env.TWILIO_ACCOUNT_SID }
  );
  return _twilioClient;
}

async function sendTwilioSms({ body }) {
  const tw = getTwilioClient();
  await tw.messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to:   process.env.OPERATOR_PHONE_NUMBER,
    body,
  });
  return { ok: true };
}

// Unified alert send. Picks Pushover if configured, else Twilio. Throws if
// neither is configured (caller treats as skip).
async function sendOperatorAlert({ title, body, url }) {
  if (isPushoverConfigured()) {
    return await sendPushover({ title, message: body, url });
  }
  if (isTwilioConfigured()) {
    // SMS has no title field — prepend it to the body.
    const smsBody = title ? `${title}\n${body}` : body;
    return await sendTwilioSms({ body: smsBody });
  }
  throw new Error('no_alert_transport_configured');
}

// SMS_QUIET_HOURS=22-8 means alerts pause from 10pm to 8am in SMS_TIMEZONE.
// Pending alerts wait in alerted_at: null state and fire when quiet ends.
function isInQuietHours() {
  const range = process.env.SMS_QUIET_HOURS;
  if (!range) return false;
  const [start, end] = range.split('-').map(s => parseInt(s, 10));
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  const tz = process.env.SMS_TIMEZONE || 'America/Chicago';
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const hour = parseInt(fmt.format(new Date()), 10);
  if (start > end) return hour >= start || hour < end;   // wraps midnight
  return hour >= start && hour < end;
}

function cleanText(s, max) {
  s = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Process the alert queue: find any unalerted inbound player messages from
// the last 24h, group by sender, send one SMS per sender, mark the messages
// as alerted on success. Failed sends leave alerted_at: null so the next
// sync retries them automatically.
async function processAlertQueue(client, coll) {
  if (!isPushoverConfigured() && !isTwilioConfigured()) {
    return { groups_sent: 0, messages_alerted: 0, skipped: 'no_transport_configured' };
  }
  if (isInQuietHours()) {
    return { groups_sent: 0, messages_alerted: 0, skipped: 'quiet_hours' };
  }

  const cutoff = new Date(Date.now() - ALERT_RETRY_WINDOW_MS);
  const queue = await coll.find({
    is_player_message: true,
    direction:         'inbound',
    alerted_at:        null,
    is_backfill:       { $ne: true },
    date_mail:         { $gte: cutoff },
  }).toArray();

  if (!queue.length) return { groups_sent: 0, messages_alerted: 0 };

  // Group by sender (player ID).
  const byPlayer = new Map();
  for (const m of queue) {
    const key = (m.from_login || '').toUpperCase().trim();
    if (!key || key === 'MY AGENT') continue;
    if (!byPlayer.has(key)) byPlayer.set(key, []);
    byPlayer.get(key).push(m);
  }
  if (!byPlayer.size) return { groups_sent: 0, messages_alerted: 0 };

  // Look up display names from cache (populated lazily by dashboard clicks).
  // No cache miss → just use the player ID — never blocks an alert.
  const ids = Array.from(byPlayer.keys());
  const playerDocs = await client.db(MONGO_DB).collection(PLAYERS_COLL)
    .find({ _id: { $in: ids } }, { projection: { name_first: 1, name_last: 1 } })
    .toArray();
  const names = new Map();
  for (const p of playerDocs) {
    const name = [p.name_first, p.name_last].filter(Boolean).join(' ').trim();
    if (name) names.set(p._id, name);
  }

  const transport = isPushoverConfigured() ? 'pushover' : 'twilio';
  let groupsSent = 0;
  let totalAlerted = 0;

  for (const [playerId, msgs] of byPlayer) {
    msgs.sort((a, b) => (new Date(a.date_mail || 0)) - (new Date(b.date_mail || 0)));
    const name = names.get(playerId);
    const sender = name ? `${name} (${playerId})` : playerId;
    const latest = msgs[msgs.length - 1].body || '';

    // Pushover has a `title` field (bold heading on the notification) so we
    // split title from body. SMS has no title — sendOperatorAlert folds the
    // title into the body automatically when Pushover isn't available.
    const title = msgs.length === 1
      ? `New message from ${sender}`
      : `${msgs.length} new messages from ${sender}`;
    const body = msgs.length === 1
      ? `"${cleanText(latest, 600)}"\n\nReply: ${DASHBOARD_URL}`
      : `Latest: "${cleanText(latest, 400)}"\n\nReply: ${DASHBOARD_URL}`;

    try {
      await sendOperatorAlert({ title, body, url: 'https://www.' + DASHBOARD_URL });
      const wagerIds = msgs.map(m => m.wager_id);
      await coll.updateMany(
        { wager_id: { $in: wagerIds } },
        { $set: { alerted_at: new Date() } }
      );
      groupsSent++;
      totalAlerted += msgs.length;
      console.log(`[sync] ${transport} alert sent: ${msgs.length} msg(s) from ${playerId}`);
    } catch (err) {
      console.error(`[sync] ${transport} send failed for ${playerId}:`, err.message);
      // Don't mark alerted — next sync will retry.
    }
  }

  return { groups_sent: groupsSent, messages_alerted: totalAlerted, transport };
}

// Back-compat shim. The integrated alert path uses processAlertQueue;
// notifyNewMessage stays exported in case anything calls it directly.
async function notifyNewMessage(msg) {
  console.log(`[sync] notify (legacy single-msg path): ${msg.from_login}`);
}

async function syncOnce() {
  if (!process.env.MONGO_URI) {
    console.warn('[sync] MONGO_URI not set — skipping sync');
    return { fetched: 0, inserted: 0, alerted: 0 };
  }

  // Pull both buckets in parallel: inbox (type=0) and sent (type=1).
  // Tag each with direction so the dashboard renders sender vs recipient
  // bubbles correctly and threads include our own outbound messages.
  let inbox, sent;
  try {
    [inbox, sent] = await Promise.all([
      agentClient.listMessages('0'),
      agentClient.listMessages('1'),
    ]);
  } catch (err) {
    console.error('[sync] listMessages failed:', err.message);
    return { fetched: 0, inserted: 0, alerted: 0, error: err.message };
  }

  const tagged = [
    ...inbox.map(m => ({ msg: m, direction: 'inbound'  })),
    ...sent.map(m  => ({ msg: m, direction: 'outbound' })),
  ];
  const fetched = tagged.length;

  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db(MONGO_DB).collection(MESSAGES_COLL);

    if (!_initialized) {
      const existingCount = await coll.estimatedDocumentCount();
      if (existingCount === 0 && fetched > 0) {
        const backfilled = tagged.map(t => ({ ...shapeMessage(t.msg, t.direction), is_backfill: true, alerted_at: null }));
        await coll.insertMany(backfilled);
        _initialized = true;
        console.log(`[sync] first-run backfill: stored ${backfilled.length} existing messages, no alerts`);
        return { fetched, inserted: backfilled.length, alerted: 0, backfill: true };
      }
      _initialized = true;
    }

    const ids = tagged.map(t => t.msg.Id).filter(Boolean);
    const existing = await coll.find({ wager_id: { $in: ids } }, { projection: { wager_id: 1 } }).toArray();
    const seenIds = new Set(existing.map(e => e.wager_id));
    const fresh = tagged.filter(t => !seenIds.has(t.msg.Id));

    // Even when nothing new arrived from wager, still run processAlertQueue
    // so any unalerted messages from previous failures get retried.
    if (fresh.length === 0) {
      const retryResult = await processAlertQueue(client, coll);
      return { fetched, inserted: 0, alerted: retryResult.messages_alerted, alert_groups: retryResult.groups_sent };
    }

    const docs = fresh.map(t => ({ ...shapeMessage(t.msg, t.direction), alerted_at: null }));
    await coll.insertMany(docs);

    // Auto-reopen any resolved threads where a fresh inbound player message
    // just landed — done so the brother's "active" list always reflects new
    // activity even on threads he marked completed earlier.
    const reopenedPlayers = new Set();
    for (const doc of docs) {
      if (!doc.is_player_message || !doc.from_login) continue;
      if (reopenedPlayers.has(doc.from_login)) continue;
      try {
        await client.db(MONGO_DB).collection('bcb_thread_state').updateOne(
          { _id: doc.from_login.toUpperCase(), resolved_at: { $ne: null } },
          { $set: { resolved_at: null, reopened_at: new Date(), reopened_by: 'sync_auto' } }
        );
        reopenedPlayers.add(doc.from_login);
      } catch (err) {
        console.error(`[sync] auto-reopen failed for ${doc.from_login}:`, err.message);
      }
    }

    // Process the alert queue. This handles both the messages we just
    // inserted AND any from the last 24h that previously failed to send
    // (auto-retry for transient Twilio outages).
    const alertResult = await processAlertQueue(client, coll);

    console.log(`[sync] fetched=${fetched} inserted=${docs.length} alert_groups=${alertResult.groups_sent} alerts_sent=${alertResult.messages_alerted}${alertResult.skipped ? ' (skipped:' + alertResult.skipped + ')' : ''}`);
    return { fetched, inserted: docs.length, alerted: alertResult.messages_alerted, alert_groups: alertResult.groups_sent };
  } catch (err) {
    console.error('[sync] mongo error:', err.message);
    return { fetched, inserted: 0, alerted: 0, error: err.message };
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// Create indexes once at boot. Idempotent — Mongo silently no-ops if the
// index already exists with the same keys/options. Without these the
// queries are fine at small scale (~thousands of docs) but degrade as the
// collection grows. Cheap insurance.
async function ensureIndexes() {
  if (!process.env.MONGO_URI) return;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db(MONGO_DB);

    // Messages: wager_id is the natural primary key — unique prevents any
    // future dup-insert race. Other indexes are for the threads/thread/sync
    // queries that use them.
    await db.collection(MESSAGES_COLL).createIndex({ wager_id: 1 }, { unique: true });
    await db.collection(MESSAGES_COLL).createIndex({ date_mail: -1 });
    await db.collection(MESSAGES_COLL).createIndex({ from_login: 1 });
    await db.collection(MESSAGES_COLL).createIndex({ to_login: 1 });
    await db.collection(MESSAGES_COLL).createIndex({ direction: 1 });
    await db.collection(MESSAGES_COLL).createIndex({ is_player_message: 1, alerted_at: 1 });

    // Thread state: looked up by counterpart ID (resolve/unresolve, sync
    // auto-reopen). _id is already the player ID; no extra index needed.

    // Player info cache: TTL on expires_at would auto-evict, but we treat
    // expired docs as cache-miss + refresh in-line, so a TTL would race.
    // _id is already the player ID; no extra index needed.

    console.log('[sync] mongo indexes ensured');
  } catch (err) {
    console.error('[sync] ensureIndexes failed:', err.message);
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

function startSyncLoop() {
  if (_syncInterval) return;
  // Fire one immediate sync on boot, then on interval.
  syncOnce().catch(err => console.error('[sync] initial sync failed:', err.message));
  _syncInterval = setInterval(() => {
    syncOnce().catch(err => console.error('[sync] interval sync failed:', err.message));
  }, SYNC_INTERVAL_MS);
  if (_syncInterval.unref) _syncInterval.unref();
  console.log(`[sync] message sync loop started (every ${SYNC_INTERVAL_MS / 60000} min)`);
}

function stopSyncLoop() {
  if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null; }
}

module.exports = {
  syncOnce,
  startSyncLoop,
  stopSyncLoop,
  ensureIndexes,
  notifyNewMessage,    // exported so Phase 2 can monkey-patch / test it
};
