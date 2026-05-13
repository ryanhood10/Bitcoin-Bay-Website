#!/usr/bin/env node
// Quick read-only diagnostic of the Mongo state the dashboard depends on.
// Usage: heroku run -a bitcoin-bay node scripts/diag-mongo-state.js

const { MongoClient } = require('mongodb');

(async () => {
  const uri = process.env.MONGO_AUTOMATION_URI || process.env.MONGO_URI;
  const dbName = process.env.MONGO_AUTOMATION_DB || 'bcbay_automation';
  const c = new MongoClient(uri);
  await c.connect();
  const db = c.db(dbName);

  console.log('=== bcb_post_briefs (latest 5 by date) ===');
  const briefs = await db.collection('bcb_post_briefs').find({}).sort({ date: -1 }).limit(5).toArray();
  for (const b of briefs) {
    console.log(`  date: ${b.date}  topic: ${b.blog_research?.topic_category || '(none)'}  ig_format: ${b.per_platform_topics?.instagram?.format_hint || '?'}`);
  }

  console.log('\n=== bcb_post_drafts grouped by brief_date ===');
  const agg = await db.collection('bcb_post_drafts').aggregate([
    { $group: { _id: '$brief_date', count: { $sum: 1 }, platforms: { $addToSet: '$platform' }, statuses: { $addToSet: '$status' } } },
    { $sort: { _id: -1 } },
    { $limit: 10 },
  ]).toArray();
  for (const g of agg) {
    console.log(`  brief_date: ${g._id}  count: ${g.count}  platforms: ${g.platforms.join(',')}  statuses: ${g.statuses.join(',')}`);
  }

  console.log('\n=== bcb_post_drafts most recent 5 by created_at ===');
  const recent = await db.collection('bcb_post_drafts').find({}).sort({ created_at: -1 }).limit(5).toArray();
  for (const d of recent) {
    console.log(`  ${d._id} ${d.platform} status=${d.status} brief_date=${d.brief_date} created_at=${d.created_at?.toISOString?.() || d.created_at}`);
  }

  console.log('\n=== Engagement collections (just counts + latest) ===');
  for (const coll of ['bcb_engagement_replies', 'bcb_engagement_targets', 'bcb_engagement_drafts']) {
    try {
      const count = await db.collection(coll).estimatedDocumentCount();
      const latest = await db.collection(coll).findOne({}, { sort: { _id: -1 } });
      const ts = latest?.created_at || latest?.fetched_at || latest?.updated_at;
      console.log(`  ${coll}: ${count} docs, latest ${ts?.toISOString?.() || ts || '(none)'}`);
    } catch (e) {
      console.log(`  ${coll}: (skipped — ${e.message})`);
    }
  }

  await c.close();
})().catch((e) => { console.error(e); process.exit(1); });
