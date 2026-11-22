// Backend: Express + Postgres (+ optional Redis cache). No scraping of Myntra itself.
// Serves the coupon list the extension consumes, and records user reports.
// Env: DATABASE_URL (optional — runs in memory-only mode without it, with an
// explicit warning), REDIS_URL (optional), PORT (default 3000), ADMIN_TOKEN.
'use strict';
const express = require('express');
const cors = require('cors');
const { candidatesFromText } = require('./discovery/sources');

const app = express();
app.use(cors({ origin: true })); // extension origin is chrome-extension:// / moz-extension://
app.use(express.json({ limit: '64kb' }));

const PORT = process.env.PORT || 3000;
const hasDb = !!process.env.DATABASE_URL;
let pool = null;
if (hasDb) { const { Pool } = require('pg'); pool = new Pool({ connectionString: process.env.DATABASE_URL }); pool.on('error', (e) => console.error('[db]', e.message)); }
else console.warn('[backend] No DATABASE_URL — running in-memory mode. Coupons added via POST /api/admin/coupons are lost on restart. Set DATABASE_URL and run src/db/schema.sql for persistence.');

// In-memory fallback store. Seeded ONLY from data/coupons.seed.json — codes copied
// from a named public source page (see data/README.md), all unverified. No invented codes.
const mem = { coupons: [], reports: [] };
try {
  const seed = require('../data/coupons.seed.json');
  if (Array.isArray(seed)) {
    for (const c of seed) {
      if (c && /^[A-Z0-9]{4,16}$/.test(c.code)) {
        mem.coupons.push({ ...c, expiresAt: c.expiresAt || null, lastVerifiedAt: null, source: 'coupondunia.in', paymentMethods: c.paymentMethods || [], excludedBrands: c.excludedBrands || [], excludedCategories: c.excludedCategories || [] });
      }
    }
  }
} catch (e) { console.warn('[backend] no seed file loaded:', e.message); }
const isCode = (s) => typeof s === 'string' && /^[A-Z0-9]{4,16}$/.test(s.trim().toUpperCase());

app.get('/health', (_req, res) => res.json({ ok: true, db: hasDb ? 'postgres' : 'memory-only', time: new Date().toISOString() }));

// GET /api/coupons — only non-expired rows, newest verification first. Never invents rows.
app.get('/api/coupons', async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
  try {
    if (pool) {
      const { rows } = await pool.query(
        `SELECT code,title,discount_type AS "discountType",discount_value AS "discountValue",max_discount AS "maxDiscount",min_order_value AS "minOrderValue",brands,categories,excluded_brands AS "excludedBrands",excluded_categories AS "excludedCategories",payment_methods AS "paymentMethods",payment_note AS "paymentNote",first_order_only AS "firstOrderOnly",app_only AS "appOnly",expires_at AS "expiresAt",source_url AS "sourceUrl",verification_status AS "verificationStatus",last_verified_at AS "lastVerifiedAt" FROM coupons WHERE expires_at IS NULL OR expires_at > now() ORDER BY verification_status='verified' DESC, updated_at DESC LIMIT $1`, [limit]);
      return res.json({ coupons: rows, source: 'postgres' });
    }
    return res.json({ coupons: mem.coupons.slice(0, limit), source: 'memory-only' });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Database error' }); }
});

// POST /api/coupons/:code/report — user report (worked/failed). Stored as a report, NOT as verification.
app.post('/api/coupons/:code/report', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { outcome, note } = req.body || {};
  if (!isCode(code) || !['worked', 'failed'].includes(outcome)) return res.status(400).json({ error: 'code and outcome=worked|failed required' });
  if (pool) { try { await pool.query('INSERT INTO coupon_reports(coupon_code,outcome,note) VALUES($1,$2,$3)', [code, outcome, String(note || '').slice(0, 500)]); await pool.query(`UPDATE coupons SET ${outcome === 'worked' ? 'success_reports' : 'failure_reports'} = ${outcome === 'worked' ? 'success_reports' : 'failure_reports'} + 1 WHERE code=$1`, [code]); } catch (e) { console.error(e); } }
  else mem.reports.push({ code, outcome, note, at: new Date().toISOString() });
  return res.json({ ok: true });
});

// POST /api/coupons/:code/verify — ONLY call this after Myntra's UI accepted the code in a real cart.
// Body: { verified: true } + optional cartTotal/saving. Operator/user-confirmed only.
app.post('/api/coupons/:code/verify', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!isCode(code)) return res.status(400).json({ error: 'invalid code' });
  if (pool) { try { await pool.query("UPDATE coupons SET verification_status='verified', last_verified_at=now(), updated_at=now() WHERE code=$1", [code]); } catch (e) { console.error(e); return res.status(500).json({ error: 'db error' }); } }
  const c = mem.coupons.find(x => x.code === code); if (c) { c.verificationStatus = 'verified'; c.lastVerifiedAt = new Date().toISOString(); }
  return res.json({ ok: true, code, verificationStatus: 'verified' });
});

// Admin: add a coupon ONLY after checking its source page. Requires ADMIN_TOKEN header when set.
app.post('/api/admin/coupons', async (req, res) => {
  if (process.env.ADMIN_TOKEN && req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorised' });
  const b = req.body || {};
  if (!isCode(b.code) || !['percent', 'flat'].includes(b.discountType) || !(b.discountValue > 0)) return res.status(400).json({ error: 'code, discountType percent|flat, discountValue>0 required' });
  if (!b.sourceUrl || !/^https?:\/\//.test(b.sourceUrl)) return res.status(400).json({ error: 'sourceUrl (the public page where you saw this code) is required' });
  const row = { code: b.code.toUpperCase(), title: String(b.title || '').slice(0, 200), discountType: b.discountType, discountValue: +b.discountValue, maxDiscount: b.maxDiscount ? +b.maxDiscount : null, minOrderValue: +b.minOrderValue || 0, brands: b.brands || [], categories: b.categories || [], excludedBrands: b.excludedBrands || [], excludedCategories: b.excludedCategories || [], paymentMethods: b.paymentMethods || [], paymentNote: b.paymentNote || null, firstOrderOnly: !!b.firstOrderOnly, appOnly: !!b.appOnly, expiresAt: b.expiresAt || null, sourceUrl: b.sourceUrl, verificationStatus: 'unverified', lastVerifiedAt: null };
  if (pool) { try { await pool.query(`INSERT INTO coupons(code,title,discount_type,discount_value,max_discount,min_order_value,brands,categories,excluded_brands,excluded_categories,payment_methods,payment_note,first_order_only,app_only,expires_at,source_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(code) DO UPDATE SET title=EXCLUDED.title,discount_type=EXCLUDED.discount_type,discount_value=EXCLUDED.discount_value,max_discount=EXCLUDED.max_discount,min_order_value=EXCLUDED.min_order_value,expires_at=EXCLUDED.expires_at,source_url=EXCLUDED.source_url,updated_at=now()`, [row.code, row.title, row.discountType, row.discountValue, row.maxDiscount, row.minOrderValue, row.brands, row.categories, row.excludedBrands, row.excludedCategories, row.paymentMethods, row.paymentNote, row.firstOrderOnly, row.appOnly, row.expiresAt, row.sourceUrl]); } catch (e) { console.error(e); return res.status(500).json({ error: 'db error' }); } }
  else { const i = mem.coupons.findIndex(x => x.code === row.code); if (i >= 0) mem.coupons[i] = row; else mem.coupons.push(row); }
  return res.status(201).json({ ok: true, coupon: row });
});

// Demo helper for the discovery parser (no network): POST {text, sourceUrl} -> candidates. Used by tests.
app.post('/api/admin/parse-text', (req, res) => {
  const { text, sourceUrl } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  return res.json({ candidates: candidatesFromText(text, sourceUrl || '') });
});

module.exports = app;
// Only listen when run directly (node src/server.js / Render). Vercel requires
// api/index.js instead and must NOT start a listener on import.
if (require.main === module) {
  app.listen(PORT, () => console.log(`[backend] listening on http://localhost:${PORT} — db: ${hasDb ? 'postgres' : 'memory-only'} — seed coupons: ${mem.coupons.length}`));
}
