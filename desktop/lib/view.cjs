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
    /* ⛔ DEUX CHAMPS QUI EXISTENT POUR CETTE VUE, ET QU'ELLE JETAIT. Mesure du 2026-08-15.
     * `lib/relay.js` livre `authenticated` en disant pourquoi: « so the UI can tell a proven sender
     * from a merely-claimed one INSTEAD OF RENDERING BOTH IDENTICALLY ». `lib/node.js` stocke
     * `probation` en disant: « so no read view can present them as vouched for ». Les deux phrases
     * decrivaient exactement ce que ce mapper faisait — il portait `origin`, `viaHuman` et `score`,
     * jamais ces deux-la, donc un expediteur prouve par signature et un simplement DECLARE produisaient
     * la MEME bulle, et un probationnaire etait indiscernable d'un pair adoube.
     *
     * ⚖️ TROIS ETATS, pas deux. `authenticated:false` veut dire « ce noeud tourne en
     * allowUnauthenticated, `from` est une revendication »; `undefined` veut dire « cette ligne est
     * anterieure au champ, on ne sait pas ». Les fondre en `false` accuserait de vieux messages sur
     * notre propre incompletude. `null` porte le troisieme etat. */
    authenticated: typeof m.authenticated === 'boolean' ? m.authenticated : null,
    // `probation` est une AFFIRMATION quand il est vrai; absent ou faux ne prouve rien de plus qu'un
    // silence, donc on ne rend `true` que sur une lecture stricte.
    probation: m.probation === true,
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
    /* ⛔ UNE PHRASE JUSTE POUR UN ETAT, SERVIE A TOUS LES ETATS, DEVIENT FAUSSE DANS UN AUTRE.
     * Cette note existe pour qu'un badge « awarded » ne se lise jamais « paid » — et elle etait emise
     * a l'identique sur CHAQUE ligne, `settled` compris. Mesure du 2026-08-15 sur un job REGLE: la
     * ligne affichait « negotiated only — no funds held or released » alors qu'un transfert USDC
     * VERIFIE contre Base existait. « negotiated only » dit qu'aucun reglement n'a eu lieu: c'est le
     * sens INVERSE du defaut d'origine, et tout aussi faux.
     * ⚖️ « no funds held or released » reste vrai de LAWBOR (non-custodial) dans les deux cas — seul
     * « negotiated only » ment sur une ligne payee. On garde donc la phrase d'origine partout SAUF sur
     * `settled`, ou l'on dit le fait mesure, avec les mots de work.js: « settled means paid — never
     * delivered, never that the work was any good ». */
    settlement: j.state === 'settled'
      ? 'PAID on-chain (chain-verified) — never means DELIVERED; LAWBOR held no funds'
      : 'negotiated only — no funds held or released',
    /* LE VERDICT DE LIVRAISON, porte par work.js SUR le reglement « so a reader never has to dig
     * through claims to learn that PAID does not mean DELIVERED on this row » — et jete ici jusqu'au
     * 2026-08-15. Trois etats: 'served' (ce qui est arrive hashe l'engagement pris AVANT le paiement),
     * 'substituted' (il ne l'hashe PAS), 'unverifiable' (l'award n'a engage aucun hash).
     * ⚖️ On le rend MEME quand il vaut 'unverifiable': work.js dit explicitement pourquoi — « a buyer
     * needs to know it never had the means to check rather than believe it passed a check ». C'est le
     * module qui a tranche cet arbitrage, pas cette vue. */
    delivery: (j.settlement && j.settlement.delivery) || null,
    deliveryReason: (j.settlement && j.settlement.deliveryReason) || null,
  };
}

/**
 * A first-contact (Requests) thread → the row the panel paints. Unlike an inbox row it exposes the
 * peer's RAW address (`withAddr`), because the panel needs it to Block or Accept them — those are
 * per-address consent actions, not per-thread. Ordering "when" uses lastAt (our clock, rxAt) so a
 * spoofed sender ts cannot make cold-outreach spam look freshly arrived.
 */
function requestRow(t, self, now) {
  const me = String(self || '').toLowerCase();
  const peer = (t.peers || []).find((p) => String(p).toLowerCase() !== me) || null;
  return {
    id: t.thread,
    withAddr: peer,                                   // raw — the block/accept target
    with: peer ? shortAddr(peer) : '—',
    preview: String(t.last || '').replace(/\s+/g, ' ').trim(),
    count: Number(t.messages) || 0,
    when: relTime(Number.isFinite(t.lastAt) ? t.lastAt : t.lastTs, now),
  };
}

module.exports = { shortAddr, counterparty, relTime, threadRow, bubble, jobRow, requestRow };
