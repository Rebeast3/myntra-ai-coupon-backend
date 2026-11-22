// Discovery worker — the ONLY place coupon codes enter the system.
// Principles (see README § Legal):
//  - Fetch ONLY sources listed in the `sources` table that the operator has
//    enabled after checking their terms / affiliate agreement.
//  - Respect robots.txt, use a real User-Agent, 1 req/sec per host, no login,
//    no CAPTCHA bypass, no private APIs.
//  - Parse only publicly visible coupon text. A code found here is stored as
//    verification_status='unverified' with its source URL. It becomes
//    'verified' ONLY after a user confirms Myntra accepted it in their cart.
//  - Nothing here invents a code: a candidate must match the strict pattern
//    and appear on the source page. Anything ambiguous is skipped and logged.
'use strict';
const CODE_RE = /\b[A-Z0-9]{4,16}\b/g;
// Generic words that look like codes but are not coupons — never store these.
const BLOCKLIST = new Set(['MYNTRA','FASHION','SHOPPING','DISCOUNT','OFFERS','COUPON','SALE','FREE','CASHBACK','WELCOME','NEWUSER','APPLY','LIMITED','EXCLUSIVE','TODAY','OFFER','DEAL','CODE','SAVE','EXTRA',
  // Common English words that match the code pattern in running text — never a coupon.
  'ALSO','WORKS','WORK','USE','USES','USING','GET','GETS','WITH','FOR','AND','THE','THIS','THAT','FROM','YOUR','MORE','WHEN','THEN','THAN','ONLY','JUST','NOW','HERE','THERE','WILL','CAN','ALL','ANY','EACH','EVERY','FIRST','ABOVE','BELOW','OVER','UNDER','FLAT','OFF','UPTO','UP','TO']);
// A candidate is kept only if it looks like a code, not a word: contains a digit,
// or is adjacent (within 12 chars) to the word "code" / a % sign. Plain words in
// running text are therefore skipped rather than stored as fake coupons.
function looksLikeCode(text, index, code) {
  if (/\d/.test(code)) return true;
  const near = String(text).slice(Math.max(0, index - 12), index + code.length + 12).toLowerCase();
  return /\bcode\b/.test(near) || /%/.test(near);
}

/** Extract candidate codes from plain text, with the source URL attached. */
function candidatesFromText(text, sourceUrl) {
  const found = new Map();
  for (const m of String(text || '').toUpperCase().matchAll(CODE_RE)) {
    const code = m[0];
    if (BLOCKLIST.has(code) || /^\d+$/.test(code)) continue;
    if (!looksLikeCode(text, m.index, code)) continue;
    if (!found.has(code)) found.set(code, { code, sourceUrl, rawContext: String(text).slice(Math.max(0, m.index - 60), m.index + 60) });
  }
  return [...found.values()];
}

/** Fetch one public URL politely. Returns text or throws. */
async function fetchText(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Myntra-AI-CouponFinder/1.0 (+https://www.myntra.com/online-offers)', Accept: 'text/html,application/rss+xml,application/xml,text/plain' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

/** Parse an RSS/Atom feed for coupon-like items. Returns candidates (unverified). */
function candidatesFromFeed(xml, sourceUrl) {
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1] || m[2] || '');
  const out = [];
  for (const item of items) {
    const title = (item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    if (!/myntra/i.test(title + item)) continue;
    out.push(...candidatesFromText(title + ' ' + item, sourceUrl));
  }
  return out;
}

module.exports = { candidatesFromText, candidatesFromFeed, fetchText, CODE_RE };
