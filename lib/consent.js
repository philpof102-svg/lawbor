'use strict';
/**
 * LAWBOR — consent.js  (WHO may reach your inbox — a LOCAL gate, separate from reputation)
 * =========================================================================================
 * WHY THIS EXISTS. Free human-to-human messaging already ships (POST /say → the inbox view). But it
 * could not be responsibly switched on as the primary surface: relay.accept delivers ANY sender
 * scoring ≥ the floor straight into a person's inbox, with no per-recipient consent, no block, no
 * report — and store.js is append-only with no delete, so a harasser's messages are permanent and
 * unstoppable. The reputation gate answers "may this bot relay into the MESH?"; it does NOT answer
 * "may this stranger reach ME?". Those are different questions, and this file answers the second.
 *
 * TWO CHECKS, KEPT SEPARATE ON PURPOSE:
 *   reputation (MainStreet PROCEED ≥ floor, in relay.js)  → mesh ADMISSION. Unchanged here.
 *   consent    (this file, folded from a LOCAL control log) → which of your buckets a delivered
 *                                                             human message lands in, and whether a
 *                                                             blocked sender is dropped before it is
 *                                                             ever stored.
 * A reputable stranger can still only land in your Requests bucket until you reply or accept them.
 *
 * LOCAL ONLY, BY DESIGN. The control log lives on your node, is folded on read (the same
 * derive-by-fold idiom as work.foldThread — no state to drift), is NEVER gossiped, holds no key and
 * touches no network. Blocking is a stop primitive, not a spam solution: bodies are still plaintext,
 * and an accepted/reputable sender is not rate-limited (see SECURITY.md deferred hardening).
 *
 * 🛑 Descriptor-only, zero deps, no I/O here — store.js supplies the folded sets, this file only decides.
 */

const lower = (a) => String(a || '').toLowerCase();

/**
 * Derive block/accept state by folding an append-only control log, LAST-WRITE-WINS per address.
 * Rows: {type:'block'|'unblock'|'accept', addr, at}. `unblock` reverses a block; `accept` whitelists.
 * Pure — the store reads the log and hands the rows here.
 * @param {Array<{type:string, addr:string, at:number}>} rows
 * @returns {{blocked:Set<string>, accepted:Set<string>}}
 */
function foldControl(rows) {
  const blocked = new Set();
  const accepted = new Set();
  // Sort by time so last-write-wins is deterministic regardless of read order (rows.at is our clock,
  // written by appendControl — never a sender-chosen value, so it is safe to order on).
  const ordered = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.addr === 'string' && r.addr)
    .slice()
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  for (const r of ordered) {
    const a = lower(r.addr);
    if (r.type === 'block') blocked.add(a);
    else if (r.type === 'unblock') blocked.delete(a);
    else if (r.type === 'accept') { accepted.add(a); blocked.delete(a); }   // accepting also un-blocks
  }
  return { blocked, accepted };
}

/**
 * Which bucket does a delivered message belong in? PURE decision — no store, no network.
 *   origin !== 'human'                        → 'bot'      (the autonomous watch feed is never quarantined)
 *   blocked                                   → 'blocked'  (caller drops before storing; hidden from views)
 *   accepted OR you have written to them      → 'inbox'    (explicit accept, or replying = implicit consent)
 *   otherwise (unknown first contact)         → 'requests' (waits until you reply or accept)
 * @param {{from:string, self:string, origin:'human'|'bot', blocked:Set, accepted:Set, hasOutboundTo:(a:string)=>boolean}} m
 * @returns {{bucket:'blocked'|'inbox'|'requests'|'bot'}}
 */
function decideInbound(m = {}) {
  if (m.origin !== 'human') return { bucket: 'bot' };
  const from = lower(m.from);
  const blocked = m.blocked || new Set();
  const accepted = m.accepted || new Set();
  if (blocked.has(from)) return { bucket: 'blocked' };
  if (accepted.has(from)) return { bucket: 'inbox' };
  if (typeof m.hasOutboundTo === 'function' && m.hasOutboundTo(from)) return { bucket: 'inbox' };
  return { bucket: 'requests' };
}

module.exports = { foldControl, decideInbound };
