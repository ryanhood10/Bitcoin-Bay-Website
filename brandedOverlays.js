// brandedOverlays.js — programmatic crypto / exchange logo marks for the
// content drafter sticker library (Phase 9.5).
//
// Each entry is a branded "badge" rendered as an SVG circle with the symbol
// or ticker glyph centered. Programmatic so we don't have to bundle a folder
// of binary PNGs (and so we can swap in real licensed logos later by editing
// this one file). The same generator is used both server-side (for sharp
// compositing onto the JPEG composite) and client-side (the picker thumbs
// load the SVG via /branded-overlays/:key.svg).

const MANIFEST = [
  // ── Bitcoin Bay (operator's own brand) ─────────────────────────────────
  { key: 'bb',         name: 'Bitcoin Bay',  kind: 'brand',    bg: '#F7941D', fg: '#FFFFFF', glyph: 'BB',    keywords: ['bitcoin bay', 'bcbay', 'bitcoinbay'] },

  // ── Top crypto coins (rough order = market cap) ────────────────────────
  { key: 'btc',        name: 'Bitcoin',      kind: 'coin',     bg: '#F7931A', fg: '#FFFFFF', glyph: '₿', keywords: ['bitcoin', 'btc', 'satoshi'] },
  { key: 'eth',        name: 'Ethereum',     kind: 'coin',     bg: '#627EEA', fg: '#FFFFFF', glyph: 'Ξ', keywords: ['ethereum', 'eth', 'ether'] },
  { key: 'usdt',       name: 'Tether',       kind: 'coin',     bg: '#26A17B', fg: '#FFFFFF', glyph: '₮', keywords: ['tether', 'usdt', 'stablecoin'] },
  { key: 'usdc',       name: 'USD Coin',     kind: 'coin',     bg: '#2775CA', fg: '#FFFFFF', glyph: 'USDC',  keywords: ['usdc', 'usd coin', 'circle', 'stablecoin'] },
  { key: 'bnb',        name: 'BNB',          kind: 'coin',     bg: '#F0B90B', fg: '#FFFFFF', glyph: 'BNB',   keywords: ['bnb', 'binance coin', 'bnb chain'] },
  { key: 'sol',        name: 'Solana',       kind: 'coin',     bg: '#9945FF', fg: '#FFFFFF', glyph: '◎', keywords: ['solana', 'sol'] },
  { key: 'xrp',        name: 'XRP',          kind: 'coin',     bg: '#23292F', fg: '#FFFFFF', glyph: 'XRP',   keywords: ['xrp', 'ripple'] },
  { key: 'ada',        name: 'Cardano',      kind: 'coin',     bg: '#0033AD', fg: '#FFFFFF', glyph: '₳', keywords: ['cardano', 'ada'] },
  { key: 'doge',       name: 'Dogecoin',     kind: 'coin',     bg: '#C2A633', fg: '#FFFFFF', glyph: 'Ð', keywords: ['dogecoin', 'doge'] },
  { key: 'avax',       name: 'Avalanche',    kind: 'coin',     bg: '#E84142', fg: '#FFFFFF', glyph: 'AVAX',  keywords: ['avalanche', 'avax'] },
  { key: 'matic',      name: 'Polygon',      kind: 'coin',     bg: '#8247E5', fg: '#FFFFFF', glyph: 'POL',   keywords: ['polygon', 'matic', 'pol'] },
  { key: 'link',       name: 'Chainlink',    kind: 'coin',     bg: '#2A5ADA', fg: '#FFFFFF', glyph: 'LINK',  keywords: ['chainlink', 'link'] },
  { key: 'ltc',        name: 'Litecoin',     kind: 'coin',     bg: '#A6A9AA', fg: '#FFFFFF', glyph: 'Ł', keywords: ['litecoin', 'ltc'] },
  { key: 'trx',        name: 'TRON',         kind: 'coin',     bg: '#EF0027', fg: '#FFFFFF', glyph: 'TRX',   keywords: ['tron', 'trx'] },

  // ── Major exchanges / brokerages ───────────────────────────────────────
  { key: 'coinbase',   name: 'Coinbase',     kind: 'exchange', bg: '#0052FF', fg: '#FFFFFF', glyph: 'C',     keywords: ['coinbase'] },
  { key: 'binance',    name: 'Binance',      kind: 'exchange', bg: '#F3BA2F', fg: '#1E2329', glyph: 'B',     keywords: ['binance'] },
  { key: 'kraken',     name: 'Kraken',       kind: 'exchange', bg: '#5848D6', fg: '#FFFFFF', glyph: 'K',     keywords: ['kraken'] },
  { key: 'bitstamp',   name: 'Bitstamp',     kind: 'exchange', bg: '#33C0FF', fg: '#FFFFFF', glyph: 'BS',    keywords: ['bitstamp'] },
  { key: 'gemini',     name: 'Gemini',       kind: 'exchange', bg: '#00DCFA', fg: '#000000', glyph: 'G',     keywords: ['gemini', 'winklevoss'] },
  { key: 'okx',        name: 'OKX',          kind: 'exchange', bg: '#000000', fg: '#FFFFFF', glyph: 'OKX',   keywords: ['okx'] },
  { key: 'bybit',      name: 'Bybit',        kind: 'exchange', bg: '#F7A600', fg: '#000000', glyph: 'BY',    keywords: ['bybit'] },
  { key: 'crypto-com', name: 'Crypto.com',   kind: 'exchange', bg: '#0033AD', fg: '#FFFFFF', glyph: 'CRO',   keywords: ['crypto.com', 'cro', 'cronos'] },
  { key: 'robinhood',  name: 'Robinhood',    kind: 'exchange', bg: '#00C805', fg: '#FFFFFF', glyph: 'RH',    keywords: ['robinhood'] },
  { key: 'cashapp',    name: 'Cash App',     kind: 'exchange', bg: '#00C244', fg: '#FFFFFF', glyph: '$',     keywords: ['cash app', 'cashapp', 'square'] },
];

function getMark(key) {
  return MANIFEST.find((m) => m.key === key) || null;
}

function escapeXml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

// Render a circular badge SVG. `size` is the square SVG width/height.
// Auto-fits font size based on glyph length so multi-char glyphs (BNB,
// AVAX, USDC) shrink to fit inside the circle.
function generateMarkSVG(key, size = 256) {
  const mark = getMark(key);
  if (!mark) return null;
  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 2;
  const glyph = mark.glyph || mark.name.slice(0, 2).toUpperCase();
  let fontSize;
  if (glyph.length === 1) fontSize = size * 0.55;
  else if (glyph.length === 2) fontSize = size * 0.42;
  else if (glyph.length === 3) fontSize = size * 0.32;
  else fontSize = size * 0.25;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${mark.bg}" stroke="rgba(0,0,0,0.18)" stroke-width="2"/>
  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
        font-family="'Space Grotesk', 'Inter', -apple-system, 'Helvetica Neue', sans-serif"
        font-size="${fontSize.toFixed(0)}" font-weight="700" fill="${mark.fg}"
        letter-spacing="-1">${escapeXml(glyph)}</text>
</svg>`;
}

// Auto-suggest: return up to `limit` mark keys whose keywords appear in the
// lowercased subject string. Keeps things deterministic; first hit wins per
// mark, MANIFEST order breaks ties.
function suggestMarks(subject, { limit = 6 } = {}) {
  if (!subject) return [];
  const lower = String(subject).toLowerCase();
  const hits = [];
  for (const mark of MANIFEST) {
    for (const kw of mark.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        hits.push(mark.key);
        break;
      }
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

module.exports = {
  MANIFEST,
  getMark,
  generateMarkSVG,
  suggestMarks,
};
