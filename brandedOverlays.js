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

// Standard luminance (0-255). Used to pick a legible fill color for the
// transparent overlay style — dark-bg marks (XRP, OKX, near-black) need
// the fill flipped to white or the glyph disappears against dark photos.
function luminance(hex) {
  const m = String(hex || '').match(/^#([0-9a-f]{6})$/i);
  if (!m) return 200;
  const v = parseInt(m[1], 16);
  return 0.299 * ((v >> 16) & 0xff) + 0.587 * ((v >> 8) & 0xff) + 0.114 * (v & 0xff);
}

// Render a transparent logo-style mark SVG. The glyph alone (no circle
// background) in the brand color, with a white halo (stroke painted under
// fill) + soft drop shadow for legibility on any photo. Auto-fits font
// size based on glyph length so multi-char marks (BNB, AVAX, USDC) shrink
// to fit. The SVG itself has no background — fully transparent so it
// composites cleanly onto a photo.
function generateMarkSVG(key, size = 256) {
  const mark = getMark(key);
  if (!mark) return null;
  const cx = size / 2, cy = size / 2;
  const glyph = mark.glyph || mark.name.slice(0, 2).toUpperCase();
  // Larger fonts than the circle version since we no longer have to fit
  // inside a disc — the glyph itself is the whole mark.
  let fontSize;
  if (glyph.length === 1) fontSize = size * 0.78;
  else if (glyph.length === 2) fontSize = size * 0.50;
  else if (glyph.length === 3) fontSize = size * 0.38;
  else fontSize = size * 0.30;
  const strokeWidth = Math.max(3, Math.round(size * 0.025));
  const shadowOffset = Math.max(2, Math.round(size * 0.012));
  const filterId = `sh-${key}`;
  // Pick the more legible of {bg, fg} as fill: brand-color when bright
  // enough to read, otherwise flip to fg (the alternate brand color, often
  // white for dark-bg marks). Stroke is always the contrasting halo so
  // the mark shows up on any photo.
  const bgLum = luminance(mark.bg);
  const fillColor = bgLum > 80 ? mark.bg : (mark.fg || '#FFFFFF');
  const strokeColor = luminance(fillColor) > 128 ? '#000000' : '#FFFFFF';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <filter id="${filterId}" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="${shadowOffset}" stdDeviation="${shadowOffset}" flood-color="#000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
        font-family="'Space Grotesk', 'Inter', -apple-system, 'Helvetica Neue', sans-serif"
        font-size="${fontSize.toFixed(0)}" font-weight="800"
        fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}"
        paint-order="stroke fill"
        filter="url(#${filterId})"
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
