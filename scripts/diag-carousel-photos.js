#!/usr/bin/env node
// Inspect the actual rendered photos on today's IG carousel — for verifying
// the auto cascade picked the right athlete photo (Phase 10.3 Brave addition).
const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient(process.env.MONGO_AUTOMATION_URI || process.env.MONGO_URI);
  await c.connect();
  const date = process.argv[2];
  const filter = { platform: 'instagram_carousel' };
  if (date) filter.brief_date = date;
  const docs = await c.db(process.env.MONGO_AUTOMATION_DB || 'bcbay_automation')
    .collection('bcb_post_drafts')
    .find(filter).sort({ created_at: -1 }).limit(1).toArray();
  for (const d of docs) {
    console.log(`draft ${d._id}  image_status=${d.image_status}`);
    for (let i = 0; i < (d.slides || []).length; i++) {
      const s = d.slides[i];
      console.log(`  [${i}] subject:     ${JSON.stringify(s.image_subject)}`);
      console.log(`       image_url:   ${s.image_url || '(none)'}`);
      console.log(`       attribution: ${s.image_attribution || '(none)'}`);
      console.log();
    }
  }
  await c.close();
})().catch(e => { console.error(e); process.exit(1); });
