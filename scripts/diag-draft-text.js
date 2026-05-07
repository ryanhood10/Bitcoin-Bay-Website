#!/usr/bin/env node
/**
 * diag-draft-text.js — print the raw text of every draft so we can see
 * exactly what bytes are stored. Helps diagnose entity-render bugs that
 * the cleanup script's regex didn't flag.
 *
 * Usage:  heroku run -a bitcoin-bay node scripts/diag-draft-text.js
 */

const { MongoClient } = require('mongodb');

const FIELDS_FLAT = ['text', 'caption', 'topic', 'image_overlay_text', 'image_subject', 'angle'];
const FIELDS_SLIDE = ['headline', 'body_text', 'image_subject'];

function showStr(label, s) {
  if (!s) return;
  const str = String(s);
  // Surface any literal entities or apostrophe-like chars
  const flags = [];
  if (/&#?\w+;/.test(str)) flags.push('HAS_ENTITY');
  if (str.includes("'")) flags.push('has_apos');
  if (str.includes('’')) flags.push('has_curly_apos');
  const tag = flags.length ? ` [${flags.join(',')}]` : '';
  // Print with JSON.stringify so we see escape sequences
  console.log(`    ${label}${tag}: ${JSON.stringify(str.slice(0, 220))}`);
}

async function main() {
  const uri = process.env.MONGO_AUTOMATION_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_AUTOMATION_URI or MONGO_URI required');
    process.exit(1);
  }
  const dbName = process.env.MONGO_AUTOMATION_DB || 'bcbay_automation';
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const drafts = await client.db(dbName).collection('bcb_post_drafts').find({}).toArray();
    console.log(`\n=== ${drafts.length} drafts ===\n`);
    for (const d of drafts) {
      console.log(`---- ${d._id} (${d.platform}, ${d.status}) ----`);
      for (const f of FIELDS_FLAT) showStr(f, d[f]);
      if (Array.isArray(d.variants)) {
        d.variants.forEach((v, i) => {
          console.log(`  variant[${i}] (${v.variant_kind}):`);
          for (const f of FIELDS_FLAT) showStr(`    ${f}`, v[f]);
        });
      }
      if (Array.isArray(d.slides)) {
        d.slides.forEach((s, i) => {
          console.log(`  slides[${i}] (${s.slide_role || '—'}):`);
          for (const f of FIELDS_SLIDE) showStr(`    ${f}`, s[f]);
        });
      }
      console.log();
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
