// server.js — Cookie Scanner Web (Express 5 + Playwright, klar til Render / Native Node)
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();

// ──────────────────────────────────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '200kb' }));
app.use(cors());

// Servér statiske filer.
// Hvis der findes en /public mappe, brug den, ellers servér fra roden.
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
} else {
  app.use(express.static(__dirname));
}

// ──────────────────────────────────────────────────────────────────────────────
const WAIT_MS = 6000;       // ventetid så scripts kan nå at sætte cookies
const NAV_TIMEOUT = 45000;  // maks navigationstid pr. side

// Typiske "Accepter alle"-knapper (DK/EN på populære CMPs)
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '[aria-label="Accept all"]',
  '[data-testid="uc-accept-all-button"]',
  'button:has-text("Accepter alle")',
  'button:has-text("Acceptér")',
  'button:has-text("Tillad alle")',
  'button:has-text("Accept All")',
  'button[title="Accept all"]',
  'button[title="Accept All"]',
  '.ot-sdk-container .accept-btn-handler',
  'button#acceptAll',
  'button#cmpbntyestxt',
  'button#cmpwelcomebtnyes'
];

// ──────────────────────────────────────────────────────────────────────────────
// Hjælpefunktioner
// ──────────────────────────────────────────────────────────────────────────────
function toIso(ts) { if (!ts || ts < 0) return ''; try { return new Date(ts * 1000).toISOString(); } catch { return ''; } }
function keyOf(c) { return `${c.name}|${c.domain}|${c.path}`; }

async function capture(context, url, stage) {
  const cookies = await context.cookies();
  const host = new URL(url).hostname;
  return cookies.map(c => {
    const dom = (c.domain || '').replace(/^\./, '');
    const firstParty = dom ? (host === dom || host.endsWith(`.${dom}`)) : true;
    return {
      url,
      stage,
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || '',
      expires_iso: toIso(c.expires),
      firstParty
    };
  });
}

async function tryAccept(page) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {}
  }
  return false;
}

async function scanUrl(targetUrl) {
  const browser = await chromium.launch({
    headless: true,
    // Flags hjælper i hosted miljøer (Render/Heroku m.fl.)
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    // PRE
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(WAIT_MS);
    const pre = await capture(context, targetUrl, 'pre-consent');

    // POST (klik "Accepter", hvis muligt)
    await tryAccept(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    const post = await capture(context, targetUrl, 'post-consent');

    // DIFF — kun det der kom til efter consent
    const preMap = new Map(pre.map(c => [keyOf(c), true]));
    const diff = post.filter(c => !preMap.has(keyOf(c))).map(c => ({ ...c, stage: 'added_after_consent' }));

    return { pre, post, diff };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────────

// Healthcheck (Render → Settings → Health Check Path: /healthz)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// API
app.post('/api/scan', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Manglende url' });

    let parsed;
    try {
      parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('Bad protocol');
    } catch {
      return res.status(400).json({ error: 'Ugyldig URL. Husk https://...' });
    }

    const result = await scanUrl(parsed.href);
    res.json(result);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Scanning fejlede', detail: String(err) });
  }
});

// Catch-all til frontend (Express 5-kompatibel)
// Finder index.html i /public hvis den findes, ellers i roden.
app.use((_req, res) => {
  const indexInPublic = path.join(__dirname, 'public', 'index.html');
  const indexInRoot = path.join(__dirname, 'index.html');
  const target = fs.existsSync(indexInPublic) ? indexInPublic : indexInRoot;
  res.sendFile(target);
});

// ──────────────────────────────────────────────────────────────────────────────
// Start server (klar til hosting)
// ──────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000; // Render sætter PORT
const HOST = '0.0.0.0';                         // lyt på alle interfaces
app.listen(PORT, HOST, () => {
  console.log(`✅ Server lytter på http://${HOST}:${PORT} (PORT=${PORT})`);
});
