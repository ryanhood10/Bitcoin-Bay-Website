#!/usr/bin/env node
/**
 * test-google-search.js — smoke test for the Google Custom Search wiring.
 * Verifies the API key + CSE ID pair returns image results.
 *
 * Usage:
 *   GOOGLE_API_KEY=... GOOGLE_CSE_ID=... node scripts/test-google-search.js [query]
 *   node scripts/test-google-search.js [query]   # reads from ../imageRenderer.js's env
 *
 * Default query: "Shai Gilgeous-Alexander"
 *
 * Exit codes:
 *   0  = at least one image candidate returned
 *   1  = env vars missing
 *   2  = API returned an error (full error printed)
 *   3  = API succeeded but returned zero items (CSE has no matching sites)
 */

const KEY = process.env.GOOGLE_API_KEY;
const CX  = process.env.GOOGLE_CSE_ID;
const QUERY = process.argv[2] || 'Shai Gilgeous-Alexander';

function tag(label, value) {
  return `${label}=${value ? value.slice(0, 8) + '…(' + value.length + ' chars)' : '(unset)'}`;
}

async function main() {
  console.log(`${tag('GOOGLE_API_KEY', KEY)}  ${tag('GOOGLE_CSE_ID', CX)}`);
  console.log(`Query: "${QUERY}"  searchType=image\n`);

  if (!KEY || !CX) {
    console.error('Missing env var(s). Need both GOOGLE_API_KEY and GOOGLE_CSE_ID.');
    process.exit(1);
  }

  const url = 'https://www.googleapis.com/customsearch/v1?' + new URLSearchParams({
    key: KEY, cx: CX, q: QUERY, searchType: 'image',
    num: '5', safe: 'active', imgSize: 'large',
  }).toString();

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error('Network error:', e.message);
    process.exit(2);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.error) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(2);
  }

  const items = data.items || [];
  if (items.length === 0) {
    console.warn('OK from Google but ZERO items returned.');
    console.warn('Most likely: the CSE has no sites yet OR none of its sites had matching images.');
    console.warn('Search information:', data.searchInformation);
    process.exit(3);
  }

  console.log(`OK — ${items.length} result(s):\n`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    console.log(`${i + 1}. ${it.displayLink || '?'}`);
    console.log(`   title: ${(it.title || '').slice(0, 80)}`);
    console.log(`   url:   ${it.link}`);
    console.log(`   thumb: ${it.image?.thumbnailLink}`);
    console.log();
  }
  console.log('Heroku side is ready. Set GOOGLE_CSE_ID on the dyno when this passes locally:');
  console.log(`  heroku config:set -a bitcoin-bay GOOGLE_CSE_ID=${CX}`);
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(2);
});
