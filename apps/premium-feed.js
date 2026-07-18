'use strict';
/**
 * LAWBOR app — premium-feed  (the paid tier, made concrete: 5 USDC / month via x402)
 * ================================================================================================
 * THE HONESTY MODEL (PLATFORM.md). You cannot paywall open-source software — a fork deletes the gate in
 * one line. So this app's CODE is free, and what is sold is the OPERATOR'S CURATED CONTENT hosted on
 * their node: entries they write and maintain. A fork of LAWBOR gets this app with an EMPTY feed, because
 * the curation is the product. You pay for the meal, not the recipe.
 *
 * `premium: true` ⇒ every route and tool here is gated by lib/paywall.js: an unsubscribed caller gets an
 * HTTP 402 with the x402 payment pointer (USDC on Base, to the operator's own wallet — LAWBOR never holds
 * a key or receives funds), and is served only once a payment is verified. No verifier wired ⇒ fail closed.
 *
 * Content source: markdown files in LAWBOR_PREMIUM_DIR (default `data/premium/`, gitignored — it is the
 * operator's, not the repo's). One file = one entry; the first `# heading` is the title, newest first.
 * Nothing is invented: an empty directory returns an explicit "the operator has not published yet".
 *
 *   GET /app/premium-feed/        → the members page (HTML)      | 402 until subscribed
 *   GET /app/premium-feed/latest  → the newest entry (JSON)      | 402 until subscribed
 *   GET /app/premium-feed/list    → titles + dates (JSON)        | 402 until subscribed
 *   MCP app_premium-feed_latest / _list                          | 402-equivalent refusal until subscribed
 */
const fs = require('fs');
const path = require('path');

const feedDir = () => process.env.LAWBOR_PREMIUM_DIR || path.join(__dirname, '..', 'data', 'premium');

/** Read the operator's entries, newest first. Pure w.r.t. the directory; never fabricates. */
function entries(dir = feedDir()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let body = '', at = 0;
    try { body = fs.readFileSync(full, 'utf8'); at = fs.statSync(full).mtimeMs; } catch { continue; }
    const m = body.match(/^#\s+(.+)$/m);
    out.push({ id: f.replace(/\.md$/i, ''), title: (m ? m[1] : f.replace(/\.md$/i, '')).trim(), body, at });
  }
  return out.sort((a, b) => b.at - a.at);
}

const EMPTY_NOTE = 'This node\'s operator has not published any premium entries yet. (A fork of LAWBOR ships this app with an empty feed by design — the curated content is the operator\'s, and it is what the subscription pays for.)';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(list) {
  const items = list.length
    ? list.map((e) => `<article><h2>${esc(e.title)}</h2><div class="meta">${new Date(e.at).toISOString().slice(0, 10)}</div><pre>${esc(e.body)}</pre></article>`).join('')
    : `<div class="empty">${esc(EMPTY_NOTE)}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LAWBOR · members feed</title>
<style>
  :root{ --bg:#0b0e14; --panel:#121722; --line:#1e2735; --ink:#e6edf3; --dim:#8b98a9; --accent:#22c55e }
  @media (prefers-color-scheme:light){ :root{ --bg:#f6f8fa; --panel:#fff; --line:#d7dee6; --ink:#0b0e14; --dim:#5a6675 } }
  *{ box-sizing:border-box } body{ margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
  header{ padding:18px 22px; border-bottom:1px solid var(--line) } header b{ font-size:16px }
  header .tag{ margin-left:10px; color:var(--accent); border:1px solid var(--accent); border-radius:20px; padding:2px 10px; font-size:11px; letter-spacing:.4px }
  main{ max-width:74ch; margin:0 auto; padding:22px }
  article{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:16px }
  article h2{ margin:0 0 4px; font-size:16px } .meta{ color:var(--dim); font-size:12px; margin-bottom:10px }
  pre{ white-space:pre-wrap; word-wrap:break-word; margin:0; font:inherit }
  .empty{ color:var(--dim); background:var(--panel); border:1px dashed var(--line); border-radius:10px; padding:20px }
</style></head><body>
<header><b>LAWBOR · members feed</b><span class="tag">PREMIUM · x402</span></header>
<main>${items}</main></body></html>`;
}

module.exports = {
  name: 'premium-feed',
  description: 'the operator\'s curated members feed — PREMIUM, 5 USDC/month via x402 to the operator\'s wallet',
  premium: true,
  _entries: entries,   // exported for tests
  routes: [
    { method: 'GET', path: '/', handle: () => ({ contentType: 'text/html; charset=utf-8', body: page(entries()) }) },
    { method: 'GET', path: '/latest', handle: () => { const e = entries(); return { body: e[0] || { empty: true, note: EMPTY_NOTE } }; } },
    { method: 'GET', path: '/list', handle: () => ({ body: { entries: entries().map(({ id, title, at }) => ({ id, title, at })), note: entries().length ? undefined : EMPTY_NOTE } }) },
  ],
  tools: [
    { name: 'latest', description: 'Read the newest entry in this node operator\'s curated members feed. Requires an active x402 subscription (5 USDC/month).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: () => { const e = entries(); return e[0] || { empty: true, note: EMPTY_NOTE }; } },
    { name: 'list', description: 'List the entries in the operator\'s curated members feed (titles + dates). Requires an active x402 subscription.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: () => ({ entries: entries().map(({ id, title, at }) => ({ id, title, at })) }) },
  ],
};
