// ============================================================
//  Broch Custom — Health check (Vercel Function)
//  Lives at  api/health.js  — checks EVERYTHING, read-only:
//
//   · Square token          · Gmail login        · EasyPost key
//   · Supabase: orders file · catalog file       · file sharing
//   · MinIO on the Synology NAS (reachable over Tailscale Funnel)
//   · Backends deployed: pay · quote · notify · shipping
//   · Pages up: the shop · the tools app
//
//  Never charges, never emails, never writes. All checks run
//  in parallel so the whole exam takes a few seconds.
//  Reports only ok / fail / off — no details leave the server.
// ============================================================

import nodemailer from 'nodemailer';

const timed = (p, ms = 6000) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
]);

export default async function handler(req, res) {
  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_KEY;
  const sbHdr = { 'apikey': KEY, 'Authorization': `Bearer ${KEY}` };
  const self = 'https://' + (req.headers.host || 'brochcustom.com');

  // a GET to a POST-only function returns 405 — proof it's deployed and
  // running, without triggering anything it does
  const deployed = async (path) => {
    try { const r = await timed(fetch(self + path)); return (r.status === 405 || r.ok) ? 'ok' : 'fail'; }
    catch (_) { return 'fail'; }
  };
  const sbFile = async (path) => {
    if (!SB || !KEY) return 'off';
    try { const r = await timed(fetch(`${SB}/storage/v1/object/files/${path}`, { headers: sbHdr })); return (r.ok || r.status === 404) ? 'ok' : 'fail'; }
    catch (_) { return 'fail'; }
  };
  const pageUp = async (url) => {
    try { const r = await timed(fetch(url, { redirect: 'follow' })); return r.ok ? 'ok' : 'fail'; }
    catch (_) { return 'fail'; }
  };

  const checks = {
    payments: (async () => {
      if (!process.env.SQUARE_ACCESS_TOKEN) return 'off';
      const BASE = process.env.SQUARE_ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
      try {
        const r = await timed(fetch(`${BASE}/v2/locations`, { headers: { 'Square-Version': '2025-01-23', 'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}` } }));
        return r.ok ? 'ok' : 'fail';
      } catch (_) { return 'fail'; }
    })(),
    email: (async () => {
      const U = process.env.GMAIL_USER, P = process.env.GMAIL_APP_PASSWORD;
      if (!U || !P) return 'off';
      try { await timed(nodemailer.createTransport({ service: 'gmail', auth: { user: U, pass: P } }).verify(), 8000); return 'ok'; }
      catch (_) { return 'fail'; }
    })(),
    shipping_key: (async () => {
      const K = process.env.EASYPOST_API_KEY;
      if (!K) return 'off';
      try {
        const auth = 'Basic ' + Buffer.from(K + ':').toString('base64');
        const r = await timed(fetch('https://api.easypost.com/v2/carrier_accounts', { headers: { 'Authorization': auth } }));
        return r.ok ? 'ok' : 'fail';
      } catch (_) { return 'fail'; }
    })(),
    sb_orders:  sbFile('_orders/orders.json'),
    sb_catalog: sbFile('_catalog/catalog.json'),
    sb_files: (async () => {
      if (!SB || !KEY) return 'off';
      try {
        const r = await timed(fetch(`${SB}/storage/v1/object/list/files`, {
          method: 'POST', headers: { ...sbHdr, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: '', limit: 1 })
        }));
        return r.ok ? 'ok' : 'fail';
      } catch (_) { return 'fail'; }
    })(),
    minio_nas: (async () => {
      const EP = process.env.MINIO_ENDPOINT;
      if (!EP) return 'off';
      try {
        // An unsigned request to MinIO answers 403 AccessDenied. That proves the
        // NAS is reachable over the Tailscale Funnel with a valid certificate,
        // without needing (or exposing) any credentials.
        const r = await timed(fetch(EP.replace(/\/+$/, '') + '/'), 8000);
        return (r.status === 403 || r.ok) ? 'ok' : 'fail';
      } catch (_) { return 'fail'; }
    })(),
    fn_pay:      deployed('/api/pay'),
    fn_quote:    deployed('/api/quote'),
    fn_notify:   deployed('/api/notify'),
    fn_shipping: deployed('/api/shipping'),
    page_shop:   pageUp(self + '/store.html'),   // the real address — /store (no .html) doesn't exist on this site
    page_tools:  pageUp('https://tools.brochcustom.com/')
  };

  const keys = Object.keys(checks);
  const vals = await Promise.all(keys.map(k => checks[k]));
  const out = {}; keys.forEach((k, i) => out[k] = vals[i]);

  const allOk = Object.values(out).every(v => v === 'ok' || v === 'off');
  return res.status(allOk ? 200 : 503).json({ ok: allOk, services: out, at: Date.now() });
}
