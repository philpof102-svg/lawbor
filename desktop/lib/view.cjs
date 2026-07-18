'use strict';
/**
 * LAWBOR desktop — view.cjs  (thread rows → what the panel renders. PURE, no DOM, no network.)
 * =============================================================================================
 * The node's two views return the SAME thread shape (see lib/store.js groupThreads):
 *   { thread, messages, lastTs, last, peers: [addr, …] }
 * The panel needs, per row: who it is with, a preview, a relative time, and — for the bot feed —
 * an honest marker that a BOT wrote this, not the human.
 *
 * These live here (not inline in index.html) so they are unit-tested once and reused by the
 * renderer through the preload bridge. The renderer has nodeIntegration:false and cannot require().
 */

/** Short display form of an address: 0x1234…cdef. Non-addresses pass through untouched. */
function shortAddr(a) {
  const s = String(a || '');
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.slice(0, 6) + '…' + s.slice(-4) : s;
}

/**
 * Who the thread is WITH — every peer that is not us. A thread with no other peer (self-note,
 * or a malformed row) falls back to "—" rather than showing our own address as the counterparty.
 */
function counterparty(threadRow, self) {
  const me = String(self || '').toLowerCase();
  const others = (threadRow.peers || []).filter((p) => String(p).toLowerCase() !== me);
  if (!others.length) return '—';
  return others.map(shortAddr).join(', ');
}

/**
 * Envelope timestamps are UNIX SECONDS (the EIP-712 type is `ts uint64`), while the panel measures
 * "now" with Date.now() in MILLISECONDS. Mixing the two silently renders every message as ~20000d
 * old — found by running two real nodes, not by any offline test. Normalize to ms here, once.
 * The 1e12 threshold is unambiguous: as seconds it is the year 33658, as ms it is 2001.
 */
function toMs(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return null;
  return t < 1e12 ? t * 1000 : t;
}

/** Relative time, coarse on purpose: a messaging list does not need seconds. */
function relTime(ts, now) {
  const t = toMs(ts);
  const n = Number.isFinite(now) ? now : null;
  if (t === null || n === null) return '';
  const d = Math.max(0, n - t);
  if (d < 60e3) return 'now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h';
  return Math.floor(d / 86400e3) + 'd';
}

/** One thread row → the flat object the panel paints. `view` is 'inbox' | 'bot'. */
function threadRow(t, self, view, now) {
  return {
    id: t.thread,
    with: counterparty(t, self),
    preview: String(t.last || '').replace(/\s+/g, ' ').trim(),
    count: Number(t.messages) || 0,
    when: relTime(t.lastTs, now),
    autonomous: view === 'bot',
  };
}

/** A message inside an opened thread → a bubble descriptor. */
function bubble(m, self) {
  const mine = String(m.from || '').toLowerCase() === String(self || '').toLowerCase();
  return {
    id: m.id,
    side: mine ? 'out' : 'in',
    who: mine ? 'you' : shortAddr(m.from),
    body: String(m.body || ''),
    // origin is the whole point of LAWBOR's two views: 'bot' means NO human typed this.
    origin: m.origin === 'bot' ? 'bot' : 'human',
    // provenance: a human-authored message relayed by a bot names the human it came from.
    viaHuman: m.viaHuman || null,
    score: Number.isFinite(m.senderScore) ? m.senderScore : null,
    ts: m.ts,
  };
}

/**
 * One derived job → the row the panel paints.
 * The `settlement` line is not decoration: LAWBOR negotiates a price and a counterparty and stops
 * there, so the panel must never let an "awarded" badge read as "paid". It says so on every row.
 */
function jobRow(j, self, now) {
  const mine = String(j.requester || '').toLowerCase() === String(self || '').toLowerCase();
  const best = (j.bids || []).reduce((a, b) => (a === null ? b : a), null);
  return {
    id: j.jobId,
    task: String(j.task || '').replace(/\s+/g, ' ').trim(),
    state: j.state,
    mine,                                   // true = I am the requester, so I may award or cancel
    bids: (j.bids || []).length,
    best: best ? best.price : null,
    winner: j.award ? shortAddr(j.award.worker) : null,
    price: j.award ? j.award.price : null,
    // an award whose bid we never saw is shown as such rather than silently equated with a real one
    unconfirmed: !!(j.award && j.award.corroborated === false),
    when: relTime(j.at, now),
    settlement: 'negotiated only — no funds held or released',
  };
}

module.exports = { shortAddr, counterparty, relTime, threadRow, bubble, jobRow };
