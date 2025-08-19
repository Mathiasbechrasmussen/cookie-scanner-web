// server.js — Cookie Scanner Web (Express 5 + Playwright; tolerant body parsing; Render-ready)
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();

/* ──────────────────────────────────────────────────────────────
   Statisk frontend
   ────────────────────────────────────────────────────────────── */
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : __dirname));

/* ──────────────────────────────────────────────────────────────
   CORS + explicit preflight
   ────────────────────────────────────────────────────────────── */
app.use(cors());
app.options('/api/scan', cors());

/* ──────────────────────────────────────────────────────────────
   Indstillinger
   ────────────────────────────────────────────────────────────── */
const WAIT_MS = 6000;
const NAV_TIMEOUT = 45000;
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
  'button#acceptAll', 'button#cmpbntyestxt', 'button#cmpwelcomebtnyes'
];

/* ──────────────────────────────────────────────────────────────
   Hjælpere
   ────────────────────────────────────────────────────────────── */
function toIso(ts){ if(!ts || ts < 0) return ''; try{ return new Date(ts*1000).toISOString(); }catch{ return ''; } }
function keyOf(c){ return `${c.name}|${c.domain}|${c.path}`; }

async function capture(context, url, stage){
  const cookies = await context.cookies();
  const host = new URL(url).hostname;
  return cookies.map(c => {
    const dom = (c.domain||'').replace(/^\./,'');
    const firstParty = dom ? (host === dom || host.endsWith(`.${dom}`)) : true;
    return {
      url, stage, name:c.name, domain:c.domain, path:c.path,
      secure:!!c.secure, httpOnly:!!c.httpOnly, sameSite:c.sameSite||'',
      expires_iso: toIso(c.expires), firstParty
    };
  });
}

async function tryAccept(page){
  for (const sel of CONSENT_SELECTORS){
    try{
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })){
        await el.click({ timeout: 2000 }).catch(()=>{});
        await page.waitForTimeout(1500);
        return true;
      }
    }catch{}
  }
  return false;
}

async function scanUrl(targetUrl){
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  });
  try{
    const context = await browser.newContext({ viewport:{ width:1280, height:900 } });
    const page = await context.newPage();

    // PRE
    await page.goto(targetUrl, { waitUntil:'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle').catch(()=>{});
    await page.waitForTimeout(WAIT_MS);
    const pre = await capture(context, targetUrl, 'pre-consent');

    // POST
    await tryAccept(page);
    await page.waitForLoadState('networkidle').catch(()=>{});
    await page.waitForTimeout(2000);
    const post = await capture(context, targetUrl, 'post-consent');

    // DIFF
    const preMap = new Map(pre.map(c => [keyOf(c), true]));
    const diff = post.filter(c => !preMap.has(keyOf(c))).map(c => ({ ...c, stage:'added_after_consent' }));

    return { pre, post, diff };
  } finally {
    await browser.close().catch(()=>{});
  }
}

/* ──────────────────────────────────────────────────────────────
   Routes
   ────────────────────────────────────────────────────────────── */

// Health check
app.get('/healthz', (_req, res) => res.json({ ok:true }));

// TOLERANT BODY PARSING her (accepter JSON, tekst, form-encoded)
// Vi lægger parseren PÅ ruten for at undgå konflikter med OPTIONS mm.
app.post(
  '/api/scan',
  // accepter alle content-types som tekst (så raw-body ikke fejler), max 1 MB
  express.text({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    try {
      let url;

      // 1) Prøv JSON
      if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        try {
          const j = JSON.parse(req.body || '{}');
          url = j.url;
        } catch (e) {
          console.error('JSON parse error:', e?.message);
        }
      }

      // 2) Hvis ikke, prøv form-encoded
      if (!url) {
        try {
          const params = new URLSearchParams(req.body || '');
          if (params.has('url')) url = params.get('url');
        } catch {}
      }

      // 3) Sidste udvej: query param ?url=
      if (!url && req.query && req.query.url) url = String(req.query.url);

      if (!url) {
        return res.status(400).json({
          error: 'Manglende url / kunne ikke læse request body',
          hint: 'Send JSON: {"url":"https://eksempel.dk/"} med Content-Type: application/json'
        });
      }

      let parsed;
      try{
        parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error('Bad protocol');
      }catch{
        return res.status(400).json({ error:'Ugyldig URL. Husk https://...' });
      }

      const result = await scanUrl(parsed.href);
      res.json(result);
    } catch (err) {
      console.error('Scan error:', err?.stack || err?.message || err);
      res.status(500).json({ error:'Scanning fejlede', detail:String(err?.message || err) });
    }
  }
);

// Catch-all til frontend
app.use((_req, res) => {
  const indexInPublic = path.join(__dirname, 'public', 'index.html');
  const indexInRoot   = path.join(__dirname, 'index.html');
  res.sendFile(fs.existsSync(indexInPublic) ? indexInPublic : indexInRoot);
});

/* ──────────────────────────────────────────────────────────────
   Start server
   ────────────────────────────────────────────────────────────── */
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`✅ Server lytter på http://${HOST}:${PORT} (PORT=${PORT})`);
});
