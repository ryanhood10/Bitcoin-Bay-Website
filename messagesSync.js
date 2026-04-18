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
function shapeMessage(m) {
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
    raw:         m,            // keep the full payload for forward-compat
    is_player_message: m.FromType === 'C',
    direction:   'inbound',    // we only sync inbox here; replies are stored by the reply endpoint
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

  let messages;
  try {
    messages = await agentClient.listInboxMessages();
  } catch (err) {
    console.error('[sync] listInboxMessages failed:', err.message);
    return { fetched: 0, inserted: 0, alerted: 0, error: err.message };
  }

  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db(MONGO_DB).collection(MESSAGES_COLL);

    // First-run guard: if the collection is empty, mark everything currently
    // in the inbox as already-seen with `is_backfill: true`. No alerts fire.
    if (!_initialized) {
      const existingCount = await coll.estimatedDocumentCount();
      if (existingCount === 0 && messages.length > 0) {
        const backfilled = messages.map(m => ({ ...shapeMessage(m), is_backfill: true, alerted_at: null }));
        await coll.insertMany(backfilled);
        _initialized = true;
        console.log(`[sync] first-run backfill: stored ${backfilled.length} existing messages, no alerts`);
        return { fetched: messages.length, inserted: backfilled.length, alerted: 0, backfill: true };
      }
      _initialized = true;
    }

    // Find which ones are new.
    const ids = messages.map(m => m.Id).filter(Boolean);
    const existing = await coll.find({ wager_id: { $in: ids } }, { projection: { wager_id: 1 } }).toArray();
    const seenIds = new Set(existing.map(e => e.wager_id));
    const fresh = messages.filter(m => !seenIds.has(m.Id));

    if (fresh.length === 0) {
      return { fetched: messages.length, inserted: 0, alerted: 0 };
    }

    const docs = fresh.map(m => ({ ...shapeMessage(m), alerted_at: null }));
    await coll.insertMany(docs);

    let alerted = 0;
    for (const doc of docs) {
      if (!doc.is_player_message) continue;
      try {
        await notifyNewMessage(doc);
        await coll.updateOne({ wager_id: doc.wager_id }, { $set: { alerted_at: new Date() } });
        alerted++;
      } catch (err) {
        console.error(`[sync] notify failed for wager_id=${doc.wager_id}:`, err.message);
      }
    }

    console.log(`[sync] fetched=${messages.length} inserted=${docs.length} alerted=${alerted}`);
    return { fetched: messages.length, inserted: docs.length, alerted };
  } catch (err) {
    console.error('[sync] mongo error:', err.message);
    return { fetched: messages.length, inserted: 0, alerted: 0, error: err.message };
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
  notifyNewMessage,    // exported so Phase 2 can monkey-patch / test it
};
