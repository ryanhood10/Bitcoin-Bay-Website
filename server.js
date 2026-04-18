const express = require('express');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
const dotenv = require('dotenv');
const { parse } = require('csv-parse/sync');
const { MongoClient } = require('mongodb');
const cookieParser = require('cookie-parser');
const agentClient = require('./agentClient');
const messagesSync = require('./messagesSync');
const adminMessagesRouter = require('./adminMessages');

// Load environment variables from .env file
dotenv.config();

// Enable CORS for all routes
app.use(cors());

// Serve static files. {index: false} so express.static doesn't auto-serve
// index.html for "/" — we use an explicit route handler below.
app.use(express.static(path.join(__dirname), { index: false }));

// Middleware to parse JSON bodies
app.use(bodyParser.json());

// Cookie parser — required by adminMessages router for signed session cookie.
app.use(cookieParser());

// Admin messaging dashboard (login + private inbox + reply UI).
app.use(adminMessagesRouter);

// Favicon fallback — browsers request /favicon.ico by default
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.png'));
});

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

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'reset-password.html'));
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

// ---------------------------------------------------------------------------
// SEO: Dynamic sitemap.xml — includes static pages + all published blog posts
// ---------------------------------------------------------------------------
const SITE = 'https://www.bitcoinbay.com';

app.get('/sitemap.xml', async (req, res) => {
  try {
    // Static pages
    const staticPages = [
      { loc: '/',                changefreq: 'weekly',  priority: '1.0' },
      { loc: '/register',       changefreq: 'monthly', priority: '0.8' },
      { loc: '/leaderboard',    changefreq: 'weekly',  priority: '0.8' },
      { loc: '/blog',           changefreq: 'daily',   priority: '0.7' },
      { loc: '/termsandcond.html', changefreq: 'yearly', priority: '0.3' },
    ];

    let blogEntries = [];
    try {
      const client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      const posts = await client.db('bcbay_automation').collection('bcb_blog_posts')
        .find({ published: true }, { projection: { slug: 1, published_at: 1, updated_at: 1 } })
        .sort({ published_at: -1 })
        .toArray();
      await client.close();
      blogEntries = posts.map(p => ({
        loc: `/blog/${p.slug}`,
        changefreq: 'monthly',
        priority: '0.6',
        lastmod: (p.updated_at || p.published_at || new Date()).toISOString().split('T')[0],
      }));
    } catch (e) {
      console.error('Sitemap blog fetch error:', e.message);
    }

    const urls = [...staticPages, ...blogEntries].map(u =>
      `  <url>\n    <loc>${SITE}${u.loc}</loc>` +
      (u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : '') +
      `\n    <changefreq>${u.changefreq}</changefreq>` +
      `\n    <priority>${u.priority}</priority>\n  </url>`
    ).join('\n');

    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
    );
  } catch (err) {
    console.error('Sitemap error:', err);
    res.status(500).send('Error generating sitemap');
  }
});

// ---------------------------------------------------------------------------
// Shared email helpers — used by both /send-email (legacy) and /api/register.
// `loginId` is optional. When present, the welcome email shows it prominently
// so the user has their login even if the wager backend's email fails.
// ---------------------------------------------------------------------------
function getMailTransport() {
  return nodemailer.createTransport({
    host: 'mail.gandi.net',
    port: 465,
    secure: true,
    auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASSWORD }
  });
}

function buildInternalMail({ firstName, lastName, email, phone, promo, loginId }) {
  const lines = [
    'New account signup:',
    '',
    `First Name: ${firstName}`,
    `Last Name:  ${lastName}`,
    `Email:      ${email}`,
    `Phone:      ${phone}`,
    `Referred By: ${promo || 'N/A'}`,
    `Login ID:   ${loginId || '(not captured — wager backend response did not include one)'}`,
    `Timestamp:  ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`
  ];
  return {
    from: `"Bitcoin Bay" <${process.env.EMAIL}>`,
    to: process.env.EMAIL,
    subject: loginId
      ? `New Signup: ${firstName} ${lastName} (${loginId})`
      : `New Signup: ${firstName} ${lastName}`,
    text: lines.join('\n')
  };
}

function buildWelcomeMail({ firstName, email, loginId }) {
  const loginIdBlock = loginId ? `
    <div style="background:linear-gradient(135deg,rgba(247,148,29,0.15),rgba(242,101,34,0.1));border:1px solid rgba(247,148,29,0.35);border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
      <p style="margin:0 0 8px;font-size:13px;color:#F7941D;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Your Login ID</p>
      <p style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:32px;font-weight:800;color:#fff;letter-spacing:2px;">${loginId}</p>
      <p style="margin:0;color:#B0C4DE;font-size:13px;">Save this — you'll need it to sign in.</p>
    </div>` : '';

  const nextStepsCopy = loginId
    ? `Your account is ready. Use the Login ID above and the password you chose to sign in. A separate email from our gaming backend will follow with additional account details.`
    : `Your account is being created right now. You'll receive a separate email shortly with your <strong style="color:#fff;">Login ID</strong> and account details.`;

  return {
    from: `"Bitcoin Bay" <${process.env.EMAIL}>`,
    to: email,
    subject: loginId
      ? `Welcome to Bitcoin Bay, ${firstName}! Your Login ID: ${loginId}`
      : `Welcome to Bitcoin Bay, ${firstName}!`,
    html: `
<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0A1628;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;">

  <!-- Logo -->
  <div style="text-align:center;margin-bottom:32px;">
    <img src="https://www.bitcoinbay.com/bb-logo.png" alt="Bitcoin Bay" width="80" style="border-radius:50%;">
  </div>

  <!-- Header -->
  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="margin:0 0 8px;font-size:28px;color:#F7941D;">Welcome to Bitcoin Bay!</h1>
    <p style="margin:0;color:#B0C4DE;font-size:16px;">Hey ${firstName}, we're glad you're here.</p>
  </div>

  ${loginIdBlock}

  <!-- Main card -->
  <div style="background:#0D2240;border:1px solid rgba(86,204,242,0.1);border-radius:16px;padding:32px;margin-bottom:24px;">
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff;">What happens next?</h2>
    <p style="color:#B0C4DE;font-size:15px;line-height:1.6;margin:0 0 20px;">
      ${nextStepsCopy}
    </p>

    <!-- CTA button -->
    <div style="text-align:center;margin:28px 0 8px;">
      <a href="https://www.bitcoinbay.com" style="display:inline-block;background:linear-gradient(135deg,#F7941D,#F26522);color:#0A1628;font-weight:800;font-size:15px;padding:14px 40px;border-radius:9999px;text-decoration:none;">Sign In to Bitcoin Bay &rarr;</a>
    </div>
  </div>

  <!-- Bonus reminder -->
  <div style="background:linear-gradient(135deg,rgba(247,148,29,0.1),rgba(242,101,34,0.1));border:1px solid rgba(247,148,29,0.2);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
    <p style="margin:0 0 4px;font-size:13px;color:#F7941D;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Don't forget</p>
    <p style="margin:0;color:#fff;font-size:18px;font-weight:700;">Every Bitcoin deposit gets a <span style="color:#F7941D;">10% Free Play Bonus</span></p>
  </div>

  <!-- Help -->
  <div style="text-align:center;margin-bottom:32px;">
    <p style="color:#6B8DB5;font-size:14px;margin:0;">
      Need help? Text us anytime: <a href="sms:7022136332" style="color:#F7941D;text-decoration:none;font-weight:600;">702-213-6332</a>
    </p>
  </div>

  <!-- Footer -->
  <div style="text-align:center;border-top:1px solid rgba(86,204,242,0.1);padding-top:24px;">
    <p style="color:#6B8DB5;font-size:12px;margin:0 0 8px;">
      &copy; 2026 Bitcoin Bay &nbsp;&bull;&nbsp;
      <a href="https://www.bitcoinbay.com/termsandcond.html" style="color:#6B8DB5;text-decoration:none;">Terms &amp; Conditions</a> &nbsp;&bull;&nbsp;
      <a href="https://www.bitcoinbay.com/blog" style="color:#6B8DB5;text-decoration:none;">Blog</a>
    </p>
    <p style="margin:0;">
      <a href="https://www.instagram.com/bitcoin_bay/" style="color:#6B8DB5;text-decoration:none;font-size:12px;">Instagram</a>
      &nbsp;&nbsp;
      <a href="https://x.com/bitcoinbay_com" style="color:#6B8DB5;text-decoration:none;font-size:12px;">X / Twitter</a>
    </p>
  </div>

</div>
</body>
</html>`
  };
}

// ---------------------------------------------------------------------------
// Password-reset email templates. The request email includes the Login ID
// so users who forgot EITHER email or password are reminded of their ID.
// The confirmation email is the post-change security notice.
// ---------------------------------------------------------------------------
function buildResetRequestMail({ firstName, email, loginId, resetUrl, expiresInMin }) {
  const who = firstName ? firstName : 'there';
  return {
    from: `"Bitcoin Bay" <${process.env.EMAIL}>`,
    to: email,
    subject: `Bitcoin Bay password reset — ${loginId ? 'Login ID ' + loginId : 'requested'}`,
    html: `
<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0A1628;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;">

  <div style="text-align:center;margin-bottom:32px;">
    <img src="https://www.bitcoinbay.com/bb-logo.png" alt="Bitcoin Bay" width="80" style="border-radius:50%;">
  </div>

  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="margin:0 0 8px;font-size:28px;color:#F7941D;">Reset your password</h1>
    <p style="margin:0;color:#B0C4DE;font-size:16px;">Hey ${who}, we got your request.</p>
  </div>

  ${loginId ? `
  <div style="background:linear-gradient(135deg,rgba(247,148,29,0.15),rgba(242,101,34,0.1));border:1px solid rgba(247,148,29,0.35);border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
    <p style="margin:0 0 8px;font-size:13px;color:#F7941D;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Your Login ID</p>
    <p style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:32px;font-weight:800;color:#fff;letter-spacing:2px;">${loginId}</p>
    <p style="margin:0;color:#B0C4DE;font-size:13px;">Save this — you'll need it to sign in.</p>
  </div>` : ''}

  <div style="background:#0D2240;border:1px solid rgba(86,204,242,0.1);border-radius:16px;padding:32px;margin-bottom:24px;">
    <p style="color:#B0C4DE;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Click the button below to set a new password. This link is single-use and expires in <strong style="color:#fff;">${expiresInMin} minutes</strong>.
    </p>

    <div style="text-align:center;margin:28px 0 16px;">
      <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#F7941D,#F26522);color:#0A1628;font-weight:800;font-size:15px;padding:14px 40px;border-radius:9999px;text-decoration:none;">Set a New Password &rarr;</a>
    </div>

    <p style="color:#6B8DB5;font-size:13px;line-height:1.6;margin:16px 0 0;word-break:break-all;">
      Button not working? Paste this into your browser:<br>
      <span style="color:#B0C4DE;">${resetUrl}</span>
    </p>
  </div>

  <div style="background:rgba(86,204,242,0.05);border:1px solid rgba(86,204,242,0.15);border-radius:12px;padding:20px;margin-bottom:24px;">
    <p style="color:#B0C4DE;font-size:13px;line-height:1.6;margin:0;">
      <strong style="color:#fff;">Didn't request this?</strong> You can safely ignore this email — nothing will change unless you click the link above. If you're worried about your account, text us at <a href="sms:7022136332" style="color:#F7941D;text-decoration:none;font-weight:600;">702-213-6332</a>.
    </p>
  </div>

  <div style="text-align:center;border-top:1px solid rgba(86,204,242,0.1);padding-top:24px;">
    <p style="color:#6B8DB5;font-size:12px;margin:0;">
      &copy; 2026 Bitcoin Bay &nbsp;&bull;&nbsp;
      <a href="https://www.bitcoinbay.com/termsandcond.html" style="color:#6B8DB5;text-decoration:none;">Terms &amp; Conditions</a>
    </p>
  </div>

</div>
</body>
</html>`
  };
}

function buildPasswordChangedMail({ firstName, email, loginId }) {
  const who = firstName ? firstName : 'there';
  return {
    from: `"Bitcoin Bay" <${process.env.EMAIL}>`,
    to: email,
    subject: `Your Bitcoin Bay password was just changed`,
    html: `
<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0A1628;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;">

  <div style="text-align:center;margin-bottom:32px;">
    <img src="https://www.bitcoinbay.com/bb-logo.png" alt="Bitcoin Bay" width="80" style="border-radius:50%;">
  </div>

  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="margin:0 0 8px;font-size:26px;color:#22C55E;">Password changed</h1>
    <p style="margin:0;color:#B0C4DE;font-size:16px;">Hey ${who}, just confirming this for you.</p>
  </div>

  ${loginId ? `
  <div style="background:linear-gradient(135deg,rgba(247,148,29,0.15),rgba(242,101,34,0.1));border:1px solid rgba(247,148,29,0.35);border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
    <p style="margin:0 0 8px;font-size:13px;color:#F7941D;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Your Login ID</p>
    <p style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:32px;font-weight:800;color:#fff;letter-spacing:2px;">${loginId}</p>
    <p style="margin:0;color:#B0C4DE;font-size:13px;">Use this with your new password to sign in.</p>
  </div>` : ''}

  <div style="background:#0D2240;border:1px solid rgba(86,204,242,0.1);border-radius:16px;padding:32px;margin-bottom:24px;">
    <p style="color:#B0C4DE;font-size:15px;line-height:1.6;margin:0 0 20px;">
      The password on your Bitcoin Bay account was just updated. You can sign in with your new password right away.
    </p>

    <div style="text-align:center;margin:28px 0 8px;">
      <a href="https://www.bitcoinbay.com" style="display:inline-block;background:linear-gradient(135deg,#F7941D,#F26522);color:#0A1628;font-weight:800;font-size:15px;padding:14px 40px;border-radius:9999px;text-decoration:none;">Sign In &rarr;</a>
    </div>
  </div>

  <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:12px;padding:20px;margin-bottom:24px;">
    <p style="color:#fff;font-size:14px;line-height:1.6;margin:0 0 6px;font-weight:700;">Didn't do this?</p>
    <p style="color:#B0C4DE;font-size:13px;line-height:1.6;margin:0;">
      Text us immediately at <a href="sms:7022136332" style="color:#F7941D;text-decoration:none;font-weight:600;">702-213-6332</a> so we can help secure your account.
    </p>
  </div>

  <div style="text-align:center;border-top:1px solid rgba(86,204,242,0.1);padding-top:24px;">
    <p style="color:#6B8DB5;font-size:12px;margin:0;">
      &copy; 2026 Bitcoin Bay &nbsp;&bull;&nbsp;
      <a href="https://www.bitcoinbay.com/termsandcond.html" style="color:#6B8DB5;text-decoration:none;">Terms &amp; Conditions</a>
    </p>
  </div>

</div>
</body>
</html>`
  };
}

// ---------------------------------------------------------------------------
// Legacy email-only endpoint. Kept for backwards compatibility — the new
// /api/register endpoint below proxies the wager backend AND sends the
// welcome email with the captured login ID, which is the preferred flow.
// ---------------------------------------------------------------------------
app.post('/send-email', (req, res) => {
  const { firstName, lastName, email, phone, promo } = req.body;
  const transporter = getMailTransport();
  const internalMail = buildInternalMail({ firstName, lastName, email, phone, promo });
  const welcomeMail = buildWelcomeMail({ firstName, email });

  Promise.all([
    transporter.sendMail(internalMail),
    transporter.sendMail(welcomeMail),
  ]).then(([internalInfo, welcomeInfo]) => {
    console.log('Internal notification sent:', internalInfo.response);
    console.log('Welcome email sent to:', email, welcomeInfo.response);
    res.status(200).send('Email sent successfully');
  }).catch((error) => {
    console.log('Error sending email:', error);
    res.status(500).send('Error sending email');
  });
});


// ---------------------------------------------------------------------------
// /api/register — proxy the wager-backend account-creation call so we can:
//   1) validate the payload server-side (catch bad emails before they create
//      orphaned accounts that never receive credentials)
//   2) verify the reCAPTCHA token (client-side check is bypassable)
//   3) parse the assigned login ID out of the wager backend's HTML response
//   4) include that login ID in the welcome email we send
//   5) log every signup attempt to MongoDB for our own audit trail
// ---------------------------------------------------------------------------
const WAGER_CREATE_URL = 'https://wager.bitcoinbay.com/sites/bitcoinbay.ag/createAccount.php';
const REG_EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]{2,})+$/;
const REG_PASS_RE = /^[a-zA-Z0-9 ]+$/;
const REG_PHONE_RE = /^\(\d{3}\) \d{3} - \d{4}$/;
// Reject obvious junk TLDs that wager backend currently accepts. This is the
// single biggest source of "no credentials email arrived" support tickets —
// users typo their address and the upstream silently creates the account.
const REG_BAD_TLDS = ['invalid', 'test', 'example', 'localhost', 'local'];

function validateRegistration(body) {
  const errors = {};
  const firstname = (body.firstname || '').trim();
  const lastname  = (body.lastname  || '').trim();
  const email     = (body.email     || '').trim().toLowerCase();
  const email2    = (body.email2    || '').trim().toLowerCase();
  const phone     = (body.phone     || '').trim();
  const password  = body.password   || '';
  const password2 = body.password2  || '';

  if (!firstname) errors.firstname = 'First name is required';
  if (!lastname)  errors.lastname  = 'Last name is required';

  if (!email || !REG_EMAIL_RE.test(email)) {
    errors.email = 'Valid email is required';
  } else {
    const tld = email.split('.').pop();
    if (REG_BAD_TLDS.includes(tld)) errors.email = 'That email address is not deliverable';
  }
  if (email && email2 && email !== email2) errors.email2 = 'Emails must match';

  if (!REG_PHONE_RE.test(phone)) errors.phone = 'Phone must be in format (xxx) xxx - xxxx';

  if (!password || password.length < 4 || password.length > 10 || !REG_PASS_RE.test(password)) {
    errors.password = 'Password must be 4–10 characters, letters and numbers only';
  }
  if (password && password2 && password !== password2) errors.password2 = 'Passwords must match';

  return { errors, clean: { firstname, lastname, email, email2, phone, password, password2,
    promo: (body.promo || '').trim() } };
}

async function verifyRecaptcha(token, remoteIp) {
  // Accept either env-var name so existing local .env files (GoogleCaptchaSecretKey)
  // and Heroku-style names (RECAPTCHA_SECRET) both work.
  const secret = process.env.GoogleCaptchaSecretKey || process.env.RECAPTCHA_SECRET;
  if (!secret) {
    console.warn('[recaptcha] No secret configured — skipping verification. Set GoogleCaptchaSecretKey (or RECAPTCHA_SECRET) on Heroku to enable bot protection.');
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, error: 'Missing reCAPTCHA token' };
  try {
    const params = new URLSearchParams({ secret, response: token });
    if (remoteIp) params.set('remoteip', remoteIp);
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await r.json();
    if (data.success) return { ok: true };
    // Log Google's response so we can diagnose mismatched-secret / wrong-domain
    // / expired-token issues. `error-codes` is the key field.
    console.error('[recaptcha] Google rejected token. response=', JSON.stringify(data),
      ' secret-prefix=', secret.slice(0, 6) + '…', ' secret-len=', secret.length);
    return { ok: false, error: 'reCAPTCHA verification failed', codes: data['error-codes'] || [] };
  } catch (err) {
    console.error('[recaptcha] verify error:', err);
    return { ok: false, error: 'reCAPTCHA verification error' };
  }
}

// Pull the assigned login ID out of the wager backend's HTML success modal.
// Response contains: <input type="hidden" name="username" value="BTCB7578">
// AND a visible "Your login ID is: <span ...>BTCB7578</span>"
function extractLoginId(html) {
  if (!html || typeof html !== 'string') return null;
  const m1 = html.match(/name=["']username["']\s+value=["']([A-Z0-9]+)["']/i);
  if (m1) return m1[1];
  const m2 = html.match(/Your login ID is:\s*<span[^>]*>\s*([A-Z0-9]+)\s*<\/span>/i);
  if (m2) return m2[1];
  return null;
}

// When the wager backend doesn't return the success modal, classify the
// response into something we can show to the user. Patterns observed:
//   - "This information has already been used to sign up previously ." (200) → dup
//   - empty body with 500 status → upstream crash
function classifyUpstreamFailure(html, status) {
  const text = (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  if (/already been used to sign up/.test(text) ||
      /already exists/.test(text) ||
      /duplicate/.test(text)) {
    return {
      code: 'duplicate_account',
      userMessage: 'An account already exists with this email or phone number. ' +
                   'If this is you, please use the Sign In page or contact support to recover your login.'
    };
  }
  if (status >= 500) {
    return {
      code: 'upstream_5xx',
      userMessage: 'Our gaming partner is having a brief issue creating accounts. Please try again in a few minutes.'
    };
  }
  return {
    code: 'unknown',
    userMessage: 'Account may not have been created. Please contact support before trying again to avoid duplicate accounts.'
  };
}

async function logSignupAttempt(record) {
  if (!process.env.MONGO_URI) return;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db('bcbay_automation').collection('bcb_signups').insertOne({
      ...record,
      created_at: new Date()
    });
  } catch (err) {
    console.error('[signups] mongo log failed:', err.message);
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

app.post('/api/register', async (req, res) => {
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  const { errors, clean } = validateRegistration(req.body);
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  const captcha = await verifyRecaptcha(req.body.captchaToken, remoteIp);
  if (!captcha.ok) {
    return res.status(400).json({ success: false, error: captcha.error || 'reCAPTCHA failed', codes: captcha.codes });
  }

  let upstreamHtml = '';
  let upstreamStatus = 0;
  try {
    const params = new URLSearchParams({
      firstname: clean.firstname,
      lastname:  clean.lastname,
      email:     clean.email,
      email2:    clean.email2,
      phone:     clean.phone,
      password:  clean.password,
      password2: clean.password2,
      promo:     clean.promo
    });
    const upstream = await fetch(WAGER_CREATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin':       'https://www.bitcoinbay.com',
        'Referer':      'https://www.bitcoinbay.com/register'
      },
      body: params.toString()
    });
    upstreamStatus = upstream.status;
    upstreamHtml = await upstream.text();
  } catch (err) {
    console.error('[register] wager backend fetch failed:', err);
    await logSignupAttempt({ ...clean, password: '[redacted]', password2: undefined,
      success: false, error: 'upstream_fetch_failed', remote_ip: remoteIp });
    return res.status(502).json({ success: false, error: 'Account creation service is unreachable. Please try again in a moment.' });
  }

  const loginId = extractLoginId(upstreamHtml);
  if (!loginId) {
    const failure = classifyUpstreamFailure(upstreamHtml, upstreamStatus);
    console.error('[register]', failure.code, '— status=', upstreamStatus,
      ' body[0..500]=', upstreamHtml.slice(0, 500));
    await logSignupAttempt({ ...clean, password: '[redacted]', password2: undefined,
      success: false, error: failure.code, upstream_status: upstreamStatus, remote_ip: remoteIp });
    // 409 for duplicates so the frontend can detect it; 502 for upstream errors
    const httpStatus = failure.code === 'duplicate_account' ? 409 : 502;
    return res.status(httpStatus).json({ success: false, error: failure.userMessage, code: failure.code });
  }

  await logSignupAttempt({ ...clean, password: '[redacted]', password2: undefined,
    success: true, login_id: loginId, remote_ip: remoteIp });

  try {
    const transporter = getMailTransport();
    await Promise.all([
      transporter.sendMail(buildInternalMail({
        firstName: clean.firstname, lastName: clean.lastname,
        email: clean.email, phone: clean.phone, promo: clean.promo, loginId
      })),
      transporter.sendMail(buildWelcomeMail({
        firstName: clean.firstname, email: clean.email, loginId
      }))
    ]);
    console.log('[register] success for', clean.email, '→ loginId=', loginId);
  } catch (err) {
    console.error('[register] email send failed (account WAS created):', err.message);
  }

  return res.json({ success: true, loginId });
});


// ---------------------------------------------------------------------------
// Password reset — /api/forgot-password + /api/reset-password
//
// Flow:
//   1) User POSTs email OR loginId to /api/forgot-password.
//   2) Server resolves a customerId + email + firstName:
//        - email path:   look up in bcb_signups (our own signups)
//        - loginId path: fetch from wager via agentClient.getPlayerInfo()
//   3) Generate a cryptographically-random 32-byte token, store in Mongo
//      (collection bcb_reset_tokens) with 1-hour expiry + single-use flag.
//   4) Email a reset link to the address on file. Response to client is
//      ALWAYS the same — no enumeration of which emails/IDs exist.
//   5) User clicks link, /reset-password page POSTs token + new password
//      to /api/reset-password. Server validates token, calls
//      agentClient.updatePlayerPassword(), marks token used, sends a
//      confirmation email.
//
// Security posture:
//   - Tokens are 256-bit random (2^256 unguessable), single-use, 1h expiry.
//   - No response leaks whether an account exists for a given email/ID.
//   - Rate limiting: 3 requests per email-or-IP per hour (soft-enforced).
//   - Agent credentials never leave the server. This endpoint is the ONLY
//     writer of passwords on the wager backend from our code.
//   - Every attempt (success + failure) logged to bcb_reset_log.
// ---------------------------------------------------------------------------
const RESET_TOKEN_TTL_MIN = 60;
const RESET_RATE_LIMIT    = 3;          // max requests per email/IP per window
const RESET_RATE_WINDOW_MS = 60 * 60 * 1000;
const PASS_RE = /^[a-zA-Z0-9]{4,10}$/;

function maskEmail(addr) {
  if (!addr || typeof addr !== 'string' || !addr.includes('@')) return '';
  const [local, domain] = addr.split('@');
  const head = local.slice(0, Math.min(2, local.length));
  const dParts = domain.split('.');
  const dHead = dParts[0].slice(0, 1);
  const dTail = dParts.slice(1).join('.');
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${dHead}${'*'.repeat(Math.max(1, dParts[0].length - 1))}.${dTail}`;
}

function normalizeCustomerId(v) {
  return (v || '').toString().trim().toUpperCase().replace(/\s+/g, '');
}

async function logResetAttempt(record) {
  if (!process.env.MONGO_URI) return;
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db('bcbay_automation').collection('bcb_reset_log').insertOne({
      ...record,
      created_at: new Date()
    });
  } catch (err) {
    console.error('[reset] log failed:', err.message);
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

async function checkResetRateLimit({ email, loginId, remoteIp }) {
  if (!process.env.MONGO_URI) return { ok: true };
  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db('bcbay_automation').collection('bcb_reset_log');
    const windowStart = new Date(Date.now() - RESET_RATE_WINDOW_MS);
    const query = { phase: 'request', created_at: { $gte: windowStart } };
    const ors = [];
    if (email)    ors.push({ input_email: email });
    if (loginId)  ors.push({ input_login_id: loginId });
    if (remoteIp) ors.push({ remote_ip: remoteIp });
    if (ors.length) query.$or = ors;
    const count = await coll.countDocuments(query);
    return { ok: count < RESET_RATE_LIMIT, count };
  } catch (err) {
    console.error('[reset] rate-limit check failed:', err.message);
    return { ok: true };   // fail-open — don't lock users out on DB blip
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// Upsert a legacy user into bcb_signups when we discover them via getPlayerInfo.
// Only fires on the loginId path (since email path only reads our own Mongo).
// Keyed on email so repeat resets don't create duplicates, and natural signups
// aren't overwritten.
async function backfillLegacyUser({ info, customerId, remoteIp }) {
  if (!process.env.MONGO_URI || !info || !info.email) return;
  const email = info.email.trim().toLowerCase();
  if (!email) return;

  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db('bcbay_automation').collection('bcb_signups');

    // Skip if this email is already in our signup log (natural or prior backfill).
    const existing = await coll.findOne({ email });
    if (existing) return;

    await coll.insertOne({
      firstname:     (info.NameFirst || '').trim(),
      lastname:      (info.NameLast  || '').trim(),
      email,
      phone:         (info.HomePhone || '').trim() || null,
      promo:         null,
      login_id:      customerId,
      source:        'reset_backfill',
      success:       true,
      backfilled_at: new Date(),
      created_at:    new Date(),
      remote_ip:     remoteIp || null
    });
    console.log('[reset] backfilled legacy user into bcb_signups (email masked)');
  } catch (err) {
    console.error('[reset] backfill insert failed:', err.message);
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }
}

// Look up {customerId, email, firstName} starting from whatever the user gave us.
// Returns null if no match found.
async function resolveAccount({ email, loginId, remoteIp }) {
  if (!process.env.MONGO_URI && !loginId) return null;

  // Path 1: loginId provided → go straight to wager backend (authoritative).
  if (loginId) {
    try {
      const info = await agentClient.getPlayerInfo(loginId);
      if (info && info.email) {
        // Fire-and-forget backfill — don't block the reset flow on this.
        backfillLegacyUser({ info, customerId: loginId, remoteIp }).catch(() => {});
        return {
          customerId: loginId,
          email:      (info.email || '').trim().toLowerCase(),
          firstName:  (info.NameFirst || '').trim() || null
        };
      }
    } catch (err) {
      console.error('[reset] getPlayerInfo failed:', err.message);
    }
    return null;
  }

  // Path 2: email provided → look in our signup log.
  if (email) {
    let client;
    try {
      client = new MongoClient(process.env.MONGO_URI);
      await client.connect();
      const signup = await client.db('bcbay_automation').collection('bcb_signups')
        .findOne(
          { email: email, success: true, login_id: { $exists: true, $ne: null } },
          { sort: { created_at: -1 } }
        );
      if (signup && signup.login_id) {
        return {
          customerId: signup.login_id,
          email:      (signup.email || email).trim().toLowerCase(),
          firstName:  (signup.firstname || '').trim() || null
        };
      }
    } catch (err) {
      console.error('[reset] signup lookup failed:', err.message);
    } finally {
      if (client) try { await client.close(); } catch (_) {}
    }
  }

  return null;
}

app.post('/api/forgot-password', async (req, res) => {
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const emailIn   = (req.body.email   || '').trim().toLowerCase();
  const loginIdIn = normalizeCustomerId(req.body.loginId);

  // Always respond with the same generic success message — never reveal
  // whether an account was found. The user knows if they have an account.
  const GENERIC_RESPONSE = {
    success: true,
    message: 'If an account matches, we just sent a reset link to the email on file. Check your inbox and spam folder.'
  };

  // Basic input shape check (not revealing — just stops empty submissions).
  if (!emailIn && !loginIdIn) {
    return res.status(400).json({ success: false, error: 'Please enter your email or Login ID.' });
  }

  // Verify reCAPTCHA (reuses same keys as register).
  const captcha = await verifyRecaptcha(req.body.captchaToken, remoteIp);
  if (!captcha.ok) {
    return res.status(400).json({ success: false, error: captcha.error || 'reCAPTCHA failed' });
  }

  // Rate limit.
  const rate = await checkResetRateLimit({ email: emailIn, loginId: loginIdIn, remoteIp });
  if (!rate.ok) {
    await logResetAttempt({
      phase: 'request', outcome: 'rate_limited',
      input_email: emailIn || null, input_login_id: loginIdIn || null,
      remote_ip: remoteIp, recent_count: rate.count
    });
    // Still return the generic message — don't tell attackers they're being throttled.
    return res.json(GENERIC_RESPONSE);
  }

  const account = await resolveAccount({ email: emailIn || null, loginId: loginIdIn || null, remoteIp });

  if (!account) {
    await logResetAttempt({
      phase: 'request', outcome: 'no_match',
      input_email: emailIn || null, input_login_id: loginIdIn || null,
      remote_ip: remoteIp
    });
    // Login IDs are not easily enumerable (random strings like BTCB1234), so
    // a specific "not found" error is a UX win with minimal security cost.
    // Emails ARE easily enumerable, so we keep that path generic.
    if (loginIdIn && !emailIn) {
      return res.status(404).json({
        success: false,
        code: 'login_id_not_found',
        error: `We couldn't find an account with Login ID "${loginIdIn}". Double-check it and try again, or switch to the email tab.`
      });
    }
    return res.json(GENERIC_RESPONSE);
  }

  // Generate token: 32 random bytes → 64-char hex. 2^256 unguessable.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000);

  let client;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db('bcbay_automation').collection('bcb_reset_tokens').insertOne({
      token,
      customer_id: account.customerId,
      email:       account.email,
      first_name:  account.firstName,
      used:        false,
      expires_at:  expiresAt,
      remote_ip:   remoteIp,
      created_at:  new Date()
    });
  } catch (err) {
    console.error('[reset] token insert failed:', err.message);
    await logResetAttempt({
      phase: 'request', outcome: 'db_error',
      input_email: emailIn || null, input_login_id: loginIdIn || null,
      remote_ip: remoteIp, error: err.message
    });
    return res.json(GENERIC_RESPONSE);
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }

  const resetUrl = `https://www.bitcoinbay.com/reset-password?token=${token}`;

  try {
    const transporter = getMailTransport();
    await transporter.sendMail(buildResetRequestMail({
      firstName:    account.firstName,
      email:        account.email,
      loginId:      account.customerId,
      resetUrl,
      expiresInMin: RESET_TOKEN_TTL_MIN
    }));
    console.log('[reset] request email sent to', maskEmail(account.email));
  } catch (err) {
    console.error('[reset] email send failed:', err.message);
  }

  await logResetAttempt({
    phase: 'request', outcome: 'sent',
    input_email: emailIn || null, input_login_id: loginIdIn || null,
    customer_id: account.customerId,
    sent_to_masked: maskEmail(account.email),
    remote_ip: remoteIp
  });

  return res.json(GENERIC_RESPONSE);
});

app.post('/api/reset-password', async (req, res) => {
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const token       = (req.body.token || '').toString().trim();
  const newPassword = (req.body.password || '').toString();
  const confirmPass = (req.body.password2 || '').toString();

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ success: false, error: 'Invalid or missing reset token. Please request a new reset link.' });
  }
  if (!newPassword || !PASS_RE.test(newPassword)) {
    return res.status(400).json({ success: false, error: 'Password must be 4–10 characters, letters and numbers only.' });
  }
  if (newPassword !== confirmPass) {
    return res.status(400).json({ success: false, error: 'Passwords must match.' });
  }

  let client;
  let tokenDoc;
  try {
    client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const coll = client.db('bcbay_automation').collection('bcb_reset_tokens');

    // Atomically claim the token: mark as used ONLY if not already used and
    // still within expiry. Prevents replay / double-click races.
    const now = new Date();
    const claim = await coll.findOneAndUpdate(
      { token, used: false, expires_at: { $gt: now } },
      { $set: { used: true, used_at: now, used_ip: remoteIp } },
      { returnDocument: 'before' }
    );
    tokenDoc = claim && (claim.value || claim);  // driver version compat
    if (!tokenDoc || !tokenDoc.customer_id) {
      await logResetAttempt({
        phase: 'reset', outcome: 'invalid_or_expired_token', remote_ip: remoteIp
      });
      return res.status(400).json({ success: false, error: 'This reset link is invalid or has expired. Please request a new one.' });
    }
  } catch (err) {
    console.error('[reset] token claim failed:', err.message);
    return res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  } finally {
    if (client) try { await client.close(); } catch (_) {}
  }

  // Update password via wager backend.
  try {
    await agentClient.updatePlayerPassword({
      customerId:  tokenDoc.customer_id,
      newPassword,
      auditTitle:  'Password Reset (website forgot-password)',
      auditInfo:   `Self-service reset from ${remoteIp} via forgot-password flow`
    });
  } catch (err) {
    console.error('[reset] updatePlayerPassword failed:', err.message);
    await logResetAttempt({
      phase: 'reset', outcome: 'upstream_error',
      customer_id: tokenDoc.customer_id, remote_ip: remoteIp, error: err.message
    });
    // Un-mark the token as used so the user can try again with the same link.
    try {
      const c2 = new MongoClient(process.env.MONGO_URI);
      await c2.connect();
      await c2.db('bcbay_automation').collection('bcb_reset_tokens').updateOne(
        { token },
        { $set: { used: false, used_at: null, used_ip: null } }
      );
      await c2.close();
    } catch (_) {}

    const msg = err && err.name === 'AgentAuthError'
      ? 'Our password-reset service is temporarily unavailable. Please try again in a few minutes or contact support.'
      : 'Could not update your password right now. Please try again or contact support.';
    return res.status(502).json({ success: false, error: msg });
  }

  // Send confirmation email.
  try {
    const transporter = getMailTransport();
    await transporter.sendMail(buildPasswordChangedMail({
      firstName: tokenDoc.first_name,
      email:     tokenDoc.email,
      loginId:   tokenDoc.customer_id
    }));
  } catch (err) {
    console.error('[reset] confirmation email failed (password WAS changed):', err.message);
  }

  await logResetAttempt({
    phase: 'reset', outcome: 'success',
    customer_id: tokenDoc.customer_id, remote_ip: remoteIp
  });

  return res.json({
    success: true,
    message: 'Your password has been updated. You can sign in with your new password now.',
    loginId: tokenDoc.customer_id
  });
});


// Leaderboard API — hardcoded for week of Apr 7–13, 2026
// TODO: Replace with MongoDB lookup once the collection is wired up
app.get('/api/leaderboard', (req, res) => {
  res.json({
    leaderboard: [
      'BTCB2577',
      'GD0288',
      'BTCB3084',
      'BTCB1931',
      'BTCB2554',
      'BCB1807',
      'BCB312',
      'BCB889',
      'SAMP153',
      'BTCB7573'
    ],
    volumeNeeded: '1,961',
    subheading: '4/7 – 4/14',
    userDate: '4-13'
  });
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
  // Keep the wager agent token warm even when the site is idle. Without
  // this, the JWT expires after 21 min of no traffic and password resets
  // fail cold. The background loop refreshes every 14 min.
  try { agentClient.startBackgroundRefresh(); } catch (err) {
    console.error('[startup] background refresh init failed:', err.message);
  }
  // Poll the wager inbox for new player messages and store them locally so the
  // admin dashboard can render them and (Phase 2) so SMS alerts can fire.
  // Make sure Mongo indexes exist before the first sync writes a row.
  // Idempotent — Mongo no-ops if the index already exists.
  messagesSync.ensureIndexes()
    .then(() => messagesSync.startSyncLoop())
    .catch(err => console.error('[startup] message sync init failed:', err.message));
});
