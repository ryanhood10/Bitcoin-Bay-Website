#!/usr/bin/env node
// Inspect today's IG carousel draft for cohesion. Prints the lead slide
// + every following slide's image_subject + headline + body, so we can
// eyeball whether slides 2..N stay anchored on slide 1's specific story
// (Phase 10.1 cohesion mandate).
//
// Usage:
//   heroku run -a bitcoin-bay node scripts/diag-carousel-cohesion.js
//   heroku run -a bitcoin-bay node scripts/diag-carousel-cohesion.js 2026-05-14

const { MongoClient } = require('mongodb');

(async () => {
  const uri = process.env.MONGO_AUTOMATION_URI || process.env.MONGO_URI;
  const dbName = process.env.MONGO_AUTOMATION_DB || 'bcbay_automation';
  const dateArg = process.argv[2];

  const c = new MongoClient(uri);
  await c.connect();
  try {
    const drafts = c.db(dbName).collection('bcb_post_drafts');
    let filter = { platform: 'instagram_carousel' };
    if (dateArg) filter.brief_date = dateArg;
    const cards = await drafts.find(filter).sort({ created_at: -1 }).limit(5).toArray();
    if (!cards.length) {
      console.log(`(no carousel drafts found${dateArg ? ' for ' + dateArg : ''})`);
      process.exit(0);
    }
    for (const d of cards) {
      console.log(`\n=== ${d._id} brief_date=${d.brief_date} ===`);
      console.log(`Topic:   ${d.topic || '(none)'}`);
      console.log(`Angle:   ${d.angle || '(none)'}`);
      console.log(`Caption: ${JSON.stringify((d.caption || '').slice(0, 200))}`);
      console.log(`Hashtags: ${(d.hashtags || []).join(' ')}`);
      console.log(`Slides (${(d.slides || []).length}):\n`);
      for (let i = 0; i < (d.slides || []).length; i++) {
        const s = d.slides[i];
        console.log(`  [${i}] role=${s.slide_role}`);
        console.log(`      headline:      ${JSON.stringify(s.headline || '')}`);
        console.log(`      body_text:     ${JSON.stringify((s.body_text || '').slice(0, 160))}`);
        console.log(`      image_subject: ${JSON.stringify(s.image_subject || '')}`);
        console.log();
      }
    }
  } finally {
    await c.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
