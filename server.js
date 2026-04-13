const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
const dotenv = require('dotenv');
const { parse } = require('csv-parse/sync');
const { MongoClient } = require('mongodb');

// Load environment variables from .env file
dotenv.config();

// Enable CORS for all routes
app.use(cors());

// Serve static files. {index: false} so express.static doesn't auto-serve
// index.html for "/" — we use an explicit route handler below.
app.use(express.static(path.join(__dirname), { index: false }));

// Middleware to parse JSON bodies
app.use(bodyParser.json());

// Page routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'leaderboard.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'register.html'));
});

// Blog index — lists all published posts
app.get('/blog', async (req, res) => {
  try {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const posts = await client.db('bcbay_automation').collection('bcb_blog_posts')
      .find({ published: true }, { projection: { body_html: 0 } })
      .sort({ published_at: -1 })
      .toArray();
    await client.close();

    const cards = posts.map(p => `
      <a href="/blog/${p.slug}" class="blog-card">
        ${p.hero_image ? `<img src="${p.hero_image}" alt="${p.hero_image_alt || p.title}" class="blog-card-img">` : ''}
        <div class="blog-card-body">
          <span class="blog-card-cat">${p.category || ''}</span>
          <h2 class="blog-card-title">${p.title}</h2>
          <p class="blog-card-excerpt">${p.excerpt || p.meta_description || ''}</p>
          <span class="blog-card-date">${new Date(p.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        </div>
      </a>
    `).join('');

    res.type('html').send(blogIndexTemplate(cards, posts.length));
  } catch (err) {
    console.error('Blog index error:', err);
    res.status(500).send('Error loading blog');
  }
});

// Blog post by slug
app.get('/blog/:slug', async (req, res) => {
  try {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const post = await client.db('bcbay_automation').collection('bcb_blog_posts')
      .findOne({ slug: req.params.slug, published: true });
    await client.close();

    if (!post) return res.status(404).sendFile(path.join(__dirname, 'index.html'));

    res.type('html').send(blogPostTemplate(post));
  } catch (err) {
    console.error('Blog post error:', err);
    res.status(500).send('Error loading post');
  }
});

// Email sending route
app.post('/send-email', (req, res) => {
  const { firstName, lastName, email, phone, promo } = req.body;

  // Create a transporter object
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL,
      pass: process.env.PASSWORD,
    }
  });

  // Email options
  const mailOptions = {
    from: process.env.EMAIL,
    to: 'bitcoinbaynotifications@gmail.com',
    subject: 'New Account Created',
    text: `First Name: ${firstName}\nLast Name: ${lastName}\nEmail: ${email}\nPhone: ${phone}\nReferred By: ${promo}`
  };

  // Send the email
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log('Error sending email:', error);
      res.status(500).send('Error sending email');
    } else {
      console.log('Email sent:', info.response);
      res.status(200).send('Email sent successfully');
    }
  });
});


// New API route for Leaderboard data using csv-parse in array mode
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const googleSheetUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQhLDCWHWkHOWYMRGoCc9CP3tHyt04d_CIRf5ydJFqo0rbAQ6Wu45XzCwyaRgElVeile0Noe3BM-vDh/pub?output=csv';
    const response = await fetch(googleSheetUrl);
    const csvText = await response.text();
    console.log('CSV Text:', csvText);

    // Parse CSV data into an array of arrays
    const records = parse(csvText, {
      skip_empty_lines: true,
      trim: true
    });
    console.log('Records (array of arrays):', records);

    // Extract subheading from cell G18 and user date from cell G19
    const subheading = (records.length >= 18 && records[17].length >= 7) ? records[17][6].trim() : "";
    const userDate = (records.length >= 19 && records[18].length >= 7) ? records[18][6].trim() : "";    
    

    console.log('Subheading (G18):', subheading);
    console.log('User Date (G19):', userDate);

    // Process data for leaderboard as before…
    const header = records[0].slice(0, 3);
    console.log('Header:', header);

    const dataRows = records.slice(1).map(row => ({
      ID: row[0] ? row[0].trim() : '',
      Count: row[1] ? row[1].trim() : '',
      Volume: row[2] ? row[2].trim() : ''
    }));
    console.log('Data Rows:', dataRows);

    const validData = dataRows.filter(row => {
      if (!row.Volume) return false;
      const vol = parseFloat(row.Volume.replace(/,/g, ''));
      return !isNaN(vol);
    });
    console.log('Valid Data:', validData);

    validData.sort((a, b) => {
      return parseFloat(b.Volume.replace(/,/g, '')) - parseFloat(a.Volume.replace(/,/g, ''));
    });
    console.log('Sorted Data:', validData);

    const topCount = Math.floor(validData.length * 0.2);
    console.log('Total valid rows:', validData.length, 'Top count:', topCount);

    const topRows = validData.slice(0, topCount);
    console.log('Top 20% Rows:', topRows);

    const leaderboardIDs = topRows.map(row => row.ID);
    console.log('Leaderboard IDs:', leaderboardIDs);

    const volumeNeeded = topRows[topRows.length - 1].Volume;
    console.log('Volume Needed to Enter top 20%:', volumeNeeded);

    res.json({ 
      leaderboard: leaderboardIDs, 
      volumeNeeded: volumeNeeded,
      subheading: subheading,
      userDate: userDate
    });
  } catch (error) {
    console.error('Error retrieving leaderboard data:', error);
    res.status(500).json({ error: 'Error retrieving leaderboard data' });
  }
});






// ---------------------------------------------------------------------------
// Blog HTML templates (inline — keeps everything in one deployable file)
// ---------------------------------------------------------------------------
function blogShell(head, body) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${head}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@700;900&display=swap" rel="stylesheet">
<!-- GTM --><script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-KTQNMNQ5');</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--gold:#F7941D;--orange:#F26522;--bg-dark:#0A1628;--bg-card:#0D2240;--text-primary:#fff;--text-secondary:#B0C4DE;--text-muted:#6B8DB5;--border:rgba(86,204,242,0.1);--font-main:'Inter',sans-serif;--font-display:'Space Grotesk','Inter',sans-serif}
html{scroll-behavior:smooth}
body{font-family:var(--font-main);background:radial-gradient(at 60% 0%,#0E2245 0%,#091830 45%,#071225 100%);color:var(--text-primary);min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:var(--gold);text-decoration:none}
a:hover{text-decoration:underline}
img{max-width:100%;height:auto}

/* Shared footer */
.blog-footer{text-align:center;padding:40px 24px;border-top:1px solid var(--border);color:var(--text-muted);font-size:12px}
.blog-footer a{color:var(--text-muted);text-decoration:none}
.blog-footer a:hover{color:var(--gold)}
.blog-footer-social{display:inline-flex;align-items:center;gap:12px;margin-left:8px;vertical-align:middle}
.blog-footer-social a{display:inline-flex;opacity:0.6}
.blog-footer-social a:hover{opacity:1}
</style>
</head><body>
<!-- GTM noscript --><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-KTQNMNQ5" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
${body}
<div class="blog-footer">
  <p>© 2026 Bitcoin Bay &nbsp;•&nbsp; <a href="/termsandcond.html">Terms &amp; Conditions</a> &nbsp;•&nbsp; <a href="/blog">Blog</a>
    <span class="blog-footer-social">
      <a href="https://www.instagram.com/bitcoin_bay/" aria-label="Instagram"><svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M7.75 2h8.5A5.75 5.75 0 0 1 22 7.75v8.5A5.75 5.75 0 0 1 16.25 22h-8.5A5.75 5.75 0 0 1 2 16.25v-8.5A5.75 5.75 0 0 1 7.75 2Zm0 1.5A4.25 4.25 0 0 0 3.5 7.75v8.5A4.25 4.25 0 0 0 7.75 20.5h8.5a4.25 4.25 0 0 0 4.25-4.25v-8.5A4.25 4.25 0 0 0 16.25 3.5Zm4.25 3.25a5.25 5.25 0 1 1 0 10.5 5.25 5.25 0 0 1 0-10.5Zm0 1.5a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Zm5.5-2a.875.875 0 1 1 0 1.75.875.875 0 0 1 0-1.75Z"/></svg></a>
      <a href="https://x.com/bitcoinbay_com" aria-label="X / Twitter"><svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z"/></svg></a>
    </span>
  </p>
</div>
</body></html>`;
}

function blogIndexTemplate(cards, count) {
  return blogShell(
    `<title>Blog · Bitcoin Bay</title>
<meta name="description" content="Bitcoin news, athlete crypto stories, and trading insights from Bitcoin Bay.">`,
    `<div style="max-width:900px;margin:0 auto;padding:60px 24px 40px">
  <a href="/" style="color:var(--text-muted);font-size:13px;display:inline-block;margin-bottom:24px">&larr; Back to Bitcoin Bay</a>
  <h1 style="font-family:var(--font-display);font-size:clamp(28px,5vw,44px);font-weight:900;margin-bottom:8px;background:linear-gradient(135deg,var(--gold),var(--orange));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Blog</h1>
  <p style="color:var(--text-secondary);margin-bottom:40px">${count} post${count !== 1 ? 's' : ''}</p>
  <div style="display:grid;gap:28px">
    ${cards || '<p style="color:var(--text-muted)">No posts yet — check back soon.</p>'}
  </div>
</div>
<style>
.blog-card{display:flex;gap:20px;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;transition:border-color .2s}
.blog-card:hover{border-color:var(--gold);text-decoration:none}
.blog-card-img{width:240px;min-height:160px;object-fit:cover;flex-shrink:0}
.blog-card-body{padding:20px;display:flex;flex-direction:column;gap:6px}
.blog-card-cat{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--gold);font-weight:600}
.blog-card-title{font-family:var(--font-display);font-size:20px;font-weight:700;color:var(--text-primary);line-height:1.3}
.blog-card-excerpt{font-size:14px;color:var(--text-secondary);line-height:1.5;flex:1}
.blog-card-date{font-size:12px;color:var(--text-muted)}
@media(max-width:600px){
  .blog-card{flex-direction:column}
  .blog-card-img{width:100%;height:180px}
}
</style>`
  );
}

function blogPostTemplate(post) {
  const seo = post.seo || {};
  const jsonLd = post.json_ld ? `<script type="application/ld+json">${JSON.stringify(post.json_ld)}</script>` : '';
  const pubDate = new Date(post.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return blogShell(
    `<title>${seo.title || post.title} · Bitcoin Bay</title>
<meta name="description" content="${seo.description || post.meta_description || ''}">
<meta name="keywords" content="${(post.keywords || []).join(', ')}">
<link rel="canonical" href="${seo.canonical || post.url || ''}">
<meta property="og:title" content="${seo.title || post.title}">
<meta property="og:description" content="${seo.description || post.meta_description || ''}">
<meta property="og:image" content="${seo.og_image || post.hero_image || ''}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
${jsonLd}
<style>
.bp-hero{position:relative;width:100%;max-height:420px;overflow:hidden}
.bp-hero img{width:100%;height:420px;object-fit:cover;display:block}
.bp-hero-overlay{position:absolute;inset:0;background:linear-gradient(transparent 50%,var(--bg-dark))}
.bp-wrap{max-width:720px;margin:0 auto;padding:0 24px 60px}
.bp-cat{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--gold);font-weight:600;margin-bottom:8px}
.bp-title{font-family:var(--font-display);font-size:clamp(26px,5vw,42px);font-weight:900;line-height:1.15;margin-bottom:12px}
.bp-meta{color:var(--text-muted);font-size:13px;margin-bottom:32px}
.bp-attribution{color:var(--text-muted);font-size:11px;margin-top:-24px;margin-bottom:32px;font-style:italic}
.bp-body{color:var(--text-secondary);font-size:16px;line-height:1.75}
.bp-body p{margin-bottom:1.25em}
.bp-body h2,.bp-body h3{color:var(--text-primary);font-family:var(--font-display);margin:1.5em 0 0.5em}
.bp-body a{color:var(--gold)}
.bp-body blockquote{border-left:3px solid var(--gold);padding-left:16px;margin:1.5em 0;color:var(--text-muted);font-style:italic}
.bp-body img{border-radius:12px;margin:1.5em 0}
.bp-back{display:inline-block;margin-bottom:32px;color:var(--text-muted);font-size:13px}
</style>`,
    `${post.hero_image ? `<div class="bp-hero"><img src="${post.hero_image}" alt="${post.hero_image_alt || post.title}"><div class="bp-hero-overlay"></div></div>` : ''}
<div class="bp-wrap">
  <a href="/blog" class="bp-back">&larr; All Posts</a>
  <div class="bp-cat">${post.category || ''}</div>
  <h1 class="bp-title">${post.title}</h1>
  <div class="bp-meta">${post.author || 'Bitcoin Bay'} &nbsp;•&nbsp; ${pubDate}</div>
  ${post.hero_image_attribution ? `<div class="bp-attribution">${post.hero_image_attribution}</div>` : ''}
  <div class="bp-body">${post.body_html}</div>
</div>`
  );
}

// 404 catch-all — anything not matched above or served by express.static
// falls through here. Keep it last so it doesn't shadow real routes.
app.use((req, res) => {
  res.status(404).type('html').send(
    '<!doctype html><html><head><meta charset="utf-8"><title>Not Found · Bitcoin Bay</title>' +
    '<style>html,body{height:100%;margin:0;font-family:Inter,-apple-system,sans-serif;' +
    'background:radial-gradient(at 60% 0%,#0E2245 0%,#091830 45%,#071225 100%);color:#fff;' +
    'display:flex;align-items:center;justify-content:center;text-align:center}' +
    'h1{font-size:48px;margin:0 0 8px;background:linear-gradient(135deg,#F7941D,#F26522);' +
    '-webkit-background-clip:text;-webkit-text-fill-color:transparent}' +
    'p{color:#6B8DB5;margin:8px 0 24px}a{color:#F7941D;text-decoration:none;font-weight:600}' +
    '</style></head><body><div><h1>404</h1><p>That page doesn\u2019t exist.</p>' +
    '<a href="/">\u2190 Back to Bitcoin Bay</a></div></body></html>'
  );
});

// Start server
const PORT = process.env.PORT || 8800;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
