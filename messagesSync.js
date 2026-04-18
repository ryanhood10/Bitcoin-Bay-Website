// ---------------------------------------------------------------------------
// messagesSync.js — periodic poll of the wager inbox into our own Mongo.
//
// The wager backend has no webhook for new messages, so we poll. Every
// SYNC_INTERVAL_MS we call agentClient.listInboxMessages(), diff against
// what we've already stored, insert the new ones, and fire notifyNewMessage()
// for anything that looks like a real player message (FromType === 'C').
//
// First-run behavior: on a brand-new database, we treat every existing
// message as "already seen" so we don't blast SMS notifications for an
// inbox-full of historical bonus announcements. Only NEW messages arriving
// after sync starts will trigger alerts.
//
// Notification is a pluggable hook. notifyNewMessage() is currently a stub
// that just logs — Phase 2 fills it in with Twilio SMS.
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');
const agentClient = require('./agentClient');

const MONGO_DB        = 'bcbay_automation';
const MESSAGES_COLL   = 'bcb_messages';
const SYNC_INTERVAL_MS = 3 * 60 * 1000;   // 3 min

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

// Stub for Phase 2 (Twilio). Called once per new player message.
async function notifyNewMessage(msg) {
  console.log(`[sync] NEW PLAYER MESSAGE from ${msg.from_login}: ${(msg.body || '').slice(0, 80)}`);
  // Phase 2 will wire this to twilio.messages.create({...}).
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

    if (fresh.length === 0) {
      return { fetched, inserted: 0, alerted: 0 };
    }

    const docs = fresh.map(t => ({ ...shapeMessage(t.msg, t.direction), alerted_at: null }));
    await coll.insertMany(docs);

    let alerted = 0;
    const reopenedPlayers = new Set();
    for (const doc of docs) {
      if (!doc.is_player_message) continue;

      // If this player's thread was previously marked Done, auto-reopen it
      // so the fresh message lands in the operator's active queue.
      if (doc.from_login && !reopenedPlayers.has(doc.from_login)) {
        try {
          const stateColl = client.db(MONGO_DB).collection('bcb_thread_state');
          await stateColl.updateOne(
            { _id: doc.from_login.toUpperCase(), resolved_at: { $ne: null } },
            { $set: { resolved_at: null, reopened_at: new Date(), reopened_by: 'sync_auto' } }
          );
          reopenedPlayers.add(doc.from_login);
        } catch (err) {
          console.error(`[sync] auto-reopen failed for ${doc.from_login}:`, err.message);
        }
      }

      try {
        await notifyNewMessage(doc);
        await coll.updateOne({ wager_id: doc.wager_id }, { $set: { alerted_at: new Date() } });
        alerted++;
      } catch (err) {
        console.error(`[sync] notify failed for wager_id=${doc.wager_id}:`, err.message);
      }
    }

    console.log(`[sync] fetched=${fetched} inserted=${docs.length} alerted=${alerted}`);
    return { fetched, inserted: docs.length, alerted };
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
