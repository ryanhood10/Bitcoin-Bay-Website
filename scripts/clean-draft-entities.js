#!/usr/bin/env node
/**
 * clean-draft-entities.js — one-shot scrub of literal HTML entities in
 * existing post drafts. Mirrors the render-side decode that safeText()
 * does in the dashboard, but applied at the source so old data is clean.
 *
 * Usage:
 *   node scripts/clean-draft-entities.js --dry-run     # report only
 *   node scripts/clean-draft-entities.js                # apply changes
 *
 * Requires MONGO_AUTOMATION_URI or MONGO_URI in env.
 *
 * After running, click "🔁 Regenerate images" on any carousel whose
 * composite JPEGs were baked with the entity literally drawn in. The data
 * fix only addresses the Mongo source — image pixels are baked separately.
 */

const { MongoClient } = require('mongodb');

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => {
      const c = parseInt(n, 10);
      return Number.isFinite(c) && c >= 32 && c < 0x10000 ? String.fromCharCode(c) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const c = parseInt(h, 16);
      return Number.isFinite(c) && c >= 32 && c < 0x10000 ? String.fromCharCode(c) : '';
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Walk an arbitrary value, decoding strings; preserve structure for arrays
// and objects so nested fields like slides[].headline get cleaned too.
function clean(value) {
  if (typeof value === 'string') return decodeEntities(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v);
    return out;
  }
  return value;
}

// Top-level fields that can carry text from upstream (Pi research, Claude
// drafter). We deep-walk slides[] and variants[] to catch nested headlines
// and bodies.
const FIELDS = [
  'text', 'caption', 'topic', 'image_subject', 'image_overlay_text',
  'image_attribution', 'image_scene_prompt', 'angle', 'format_hint',
  'headline', 'body_text', 'hashtags', 'slides', 'variants',
];

async function main() {
  const uri = process.env.MONGO_AUTOMATION_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_AUTOMATION_URI or MONGO_URI required');
    process.exit(1);
  }
  const dbName = process.env.MONGO_AUTOMATION_DB || 'bcbay_automation';
  const dryRun = process.argv.includes('--dry-run');

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const drafts = client.db(dbName).collection('bcb_post_drafts');
    const cursor = drafts.find({});
    let scanned = 0, dirty = 0, changed = 0;
    while (await cursor.hasNext()) {
      scanned++;
      const d = await cursor.next();
      const updates = {};
      for (const f of FIELDS) {
        if (d[f] === undefined) continue;
        const cleaned = clean(d[f]);
        if (JSON.stringify(d[f]) !== JSON.stringify(cleaned)) {
          updates[f] = cleaned;
        }
      }
      if (Object.keys(updates).length > 0) {
        dirty++;
        if (dryRun) {
          console.log(`[dry-run] ${d._id} (${d.platform}): ${Object.keys(updates).join(', ')}`);
        } else {
          await drafts.updateOne(
            { _id: d._id },
            { $set: { ...updates, updated_at: new Date() } }
          );
          changed++;
          console.log(`updated ${d._id} (${d.platform}): ${Object.keys(updates).join(', ')}`);
        }
      }
    }
    console.log(`\nScanned ${scanned}, dirty ${dirty}, ${dryRun ? 'would-change' : 'changed'} ${dryRun ? dirty : changed}.`);
    if (!dryRun && changed > 0) {
      console.log('\nNext step: open the dashboard and click "🔁 Regenerate images"');
      console.log('on any carousel whose composite JPEG was baked with the entity literally drawn in.');
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
