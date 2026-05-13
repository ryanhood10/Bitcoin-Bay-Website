#!/usr/bin/env node
/**
 * test-image-search.js — smoke test for the operator-side photo-replace
 * sources (Brave Search Images and Google Custom Search). Prints exactly
 * what the picker would see in the UI.
 *
 * Usage:
 *   BRAVE_API_KEY=...                                    node scripts/test-google-search.js [query]
 *   GOOGLE_API_KEY=... GOOGLE_CSE_ID=...                 node scripts/test-google-search.js [query]
 *   BRAVE_API_KEY=... GOOGLE_API_KEY=... GOOGLE_CSE_ID=... node scripts/test-google-search.js [query]
 *
 * Default query: "Shai Gilgeous-Alexander"
 *
 * Exits 0 if at least one source returned candidates; 2 on any API error;
 * 3 if all configured sources returned zero results.
 */

const QUERY = process.argv[2] || 'Shai Gilgeous-Alexander';

function tag(label, value) {
  return `${label}=${value ? value.slice(0, 8) + '…(' + value.length + ' chars)' : '(unset)'}`;
}

async function testBrave() {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return { skipped: true };
  const url = 'https://api.search.brave.com/res/v1/images/search?' + new URLSearchParams({
    q: QUERY, count: '5', safesearch: 'strict', country: 'us', search_lang: 'en',
  }).toString();
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: { status: res.status, body: data } };
  return { items: (data.results || []).map((r) => ({
    source: r.source || r.meta_url?.hostname,
    title: (r.title || '').slice(0, 70),
    url: r.properties?.url || r.url,
    thumb: r.thumbnail?.src,
  })) };
}

async function testGoogle() {
  const key = process.env.GOOGLE_API_KEY;
  const cx  = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return { skipped: true };
  const url = 'https://www.googleapis.com/customsearch/v1?' + new URLSearchParams({
    key, cx, q: QUERY, searchType: 'image', num: '5', safe: 'active', imgSize: 'large',
  }).toString();
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) return { error: { status: res.status, body: data } };
  return { items: (data.items || []).map((it) => ({
    source: it.displayLink,
    title: (it.title || '').slice(0, 70),
    url: it.link,
    thumb: it.image?.thumbnailLink,
  })) };
}

function printResult(name, result) {
  console.log(`\n=== ${name} ===`);
  if (result.skipped) {
    console.log('  skipped (env vars not set)');
    return 'skipped';
  }
  if (result.error) {
    console.log(`  ❌ HTTP ${result.error.status}`);
    console.log(`  ${JSON.stringify(result.error.body).slice(0, 300)}`);
    return 'error';
  }
  if (!result.items.length) {
    console.log('  ⚠️  zero results');
    return 'empty';
  }
  console.log(`  ✅ ${result.items.length} result(s):`);
  for (let i = 0; i < result.items.length; i++) {
    const it = result.items[i];
    console.log(`    ${i + 1}. ${it.source} — ${it.title}`);
  }
  return 'ok';
}

async function main() {
  console.log(`Query: "${QUERY}"`);
  console.log(`${tag('BRAVE_API_KEY', process.env.BRAVE_API_KEY)}  ${tag('GOOGLE_API_KEY', process.env.GOOGLE_API_KEY)}  ${tag('GOOGLE_CSE_ID', process.env.GOOGLE_CSE_ID)}`);

  const [brave, google] = await Promise.all([testBrave(), testGoogle()]);
  const braveStatus  = printResult('Brave Search Images', brave);
  const googleStatus = printResult('Google Custom Search', google);

  if (braveStatus === 'error' || googleStatus === 'error') process.exit(2);
  if (braveStatus === 'ok' || googleStatus === 'ok') process.exit(0);
  if (braveStatus === 'skipped' && googleStatus === 'skipped') {
    console.log('\nNo sources configured. Set BRAVE_API_KEY and/or (GOOGLE_API_KEY + GOOGLE_CSE_ID).');
    process.exit(1);
  }
  process.exit(3);
}

main().catch((e) => { console.error('Unhandled:', e); process.exit(2); });
