// server.js — Cookie Scanner Web (Express 5 + Playwright)
const express = require('express');
const cors = require('cors');
const path = require('path');
const { chromium } = require('playwright');

const app = express();

// Middleware
app.use(express.json({ limit: '200kb' }));
app.use(cors());

// Statisk frontend
app.use(express.static(path.join(__dirname, 'public')));

// Indstillinger
const WAIT_MS = 6000;      // vent så scripts kan nå at sætte cookies
const NAV_TIMEOUT = 45000; // max navigationstid

// Typiske "Accepter alle"-knapper (DK/EN)
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

// Helpers
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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  // PRE
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(WAIT_MS);
  const pre = await capture(context, targetUrl, 'pre-consent');

  // POST (klik accept hvis muligt)
  await tryAccept(page);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
  const post = await capture(context, targetUrl, 'post-consent');

  // DIFF — kun det der kom til efter consent
  const preMap = new Map(pre.map(c => [keyOf(c), true]));
  const diff = post.filter(c => !preMap.has(keyOf(c))).map(c => ({ ...c, stage: 'added_after_consent' }));

  await browser.close();
  return { pre, post, diff };
}

// Healthcheck
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
    console.error(err);
    res.status(500).json({ error: 'Scanning fejlede', detail: String(err) });
  }
});

// ⬇️ Catch-all fallback for frontend i Express 5 (ingen path — undgår path-to-regexp)
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server kører på http://localhost:${PORT}`));
