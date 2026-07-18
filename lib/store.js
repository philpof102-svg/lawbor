'use strict';
/**
 * LAWBOR — store.js  (the conversation log behind the human-facing views + the LOCAL consent log)
 * ================================================================================================
 * Phil's correction: LAWBOR is not invisible bot-to-bot plumbing. Each human has a messaging app
 * (Telegram-shaped, richer): (1) their OWN conversations, (2) a live VIEW of what their bot is
 * autonomously discussing, and (3) a REQUESTS quarantine for first contact from strangers. Every
 * message is tagged with its ORIGIN:
 *   - origin 'human'  → the user wrote it (inbox / requests, split by consent)
 *   - origin 'bot'    → their bot said it autonomously (the "watch my bot" feed — never quarantined)
 * Append-only JSONL (last write wins per message id), LAWBOR_DB-overridable, zero network here.
 *
 * CONSENT is LOCAL and lives in a SEPARATE append-only control log (LAWBOR_CONTROL, a sibling of the
 * messages file), folded on read (lib/consent.js). It is never gossiped and never leaves the node.
 * The inbox/requests split is derived at READ time from that log + who you've written to — no new
 * field on the message row, the append-only message log is untouched.
 */
const fs = require('fs');
const path = require('path');
const { foldControl, decideInbound } = require('./consent');

const FILE = process.env.LAWBOR_DB || path.join(__dirname, '..', 'data', 'messages.jsonl');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

const lower = (a) => String(a || '').toLowerCase();

function readAll(file = FILE) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const byId = new Map();
  for (const l of raw.split(/\r?\n/)) { if (!l.trim()) continue; try { const m = JSON.parse(l); byId.set(m.id, m); } catch {} }
  return [...byId.values()];
}

// control rows are EVENTS, not id-keyed — read them all in order; foldControl resolves last-write-wins.
function readControlRows(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function createStore(file = FILE, controlFile) {
  const ctrlFile = controlFile || process.env.LAWBOR_CONTROL || (file + '.control');
  const subsFile = process.env.LAWBOR_SUBS || (file + '.subs');
  const readControl = () => foldControl(readControlRows(ctrlFile));
  // addrs this node has an OUTBOUND human message to — replying is implicit consent.
  const knownContactsOf = (selfAddr) => {
    const self = lower(selfAddr);
    const set = new Set();
    for (const m of readAll(file)) if (m.origin === 'human' && m.dir === 'out' && lower(m.from) === self) set.add(lower(m.to));
    return set;
  };
  // human threads whose peer falls in a given consent bucket ('inbox' | 'requests')
  const humanThreads = (selfAddr, bucketWanted, limit) => {
    const self = lower(selfAddr);
    const { blocked, accepted } = readControl();
    const known = knownContactsOf(self);
    const rows = readAll(file).filter((m) => m.origin === 'human' && (lower(m.from) === self || lower(m.to) === self));
    return groupThreads(rows).filter((t) => bucketForThread(t, self, blocked, accepted, known) === bucketWanted).slice(0, limit);
  };

  return {
    /** Record a message. @param {object} env envelope · @param {{origin:'human'|'bot', dir:'in'|'out', senderScore?:number}} meta */
    record(env, meta = {}) {
      const row = { id: env.id, thread: env.thread, from: env.from, to: env.to, body: env.body,
        ts: env.ts, viaHuman: env.viaHuman || null,
        origin: meta.origin === 'bot' ? 'bot' : 'human', dir: meta.dir === 'out' ? 'out' : 'in',
        senderScore: Number.isFinite(meta.senderScore) ? meta.senderScore : null,
        // false = `from` was claimed, not proven. Recorded so the distinction survives to the UI.
        authenticated: meta.authenticated === true,
        /* rxAt — OUR clock, not the sender's. `env.ts` is chosen by whoever built the envelope and
         * nothing validates it, so ordering threads by it let a stranger date a message ten years
         * ahead and pin their spam to the top of a human's inbox permanently (proven). Display may
         * still show env.ts; ordering must never trust it. */
        rxAt: Number.isFinite(meta.rxAt) ? meta.rxAt : Date.now() };
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      return row;
    },

    /* ---- LOCAL consent control log (block / unblock / accept) — never gossiped, holds no key ---- */
    appendControl(type, addr) {
      if (!['block', 'unblock', 'accept'].includes(type)) throw new Error('bad control type: ' + type);
      fs.mkdirSync(path.dirname(ctrlFile), { recursive: true });
      const row = { type, addr: lower(addr), at: Date.now() };
      fs.appendFileSync(ctrlFile, JSON.stringify(row) + '\n');
      return row;
    },
    /** The single source of block/accept truth (folded from the control log). */
    control() { return readControl(); },

    /* ---- x402 subscription ledger (premium tier) — append-only, folded to the max expiry per payer.
       Records that a payer paid; the paywall (lib/paywall.js) decides. Never gossiped, holds no key. */
    appendSub(payer, until) {
      fs.mkdirSync(path.dirname(subsFile), { recursive: true });
      const row = { payer: lower(payer), until: Number(until) || 0, at: Date.now() };
      fs.appendFileSync(subsFile, JSON.stringify(row) + '\n');
      return row;
    },
    /** The latest expiry timestamp for a payer (0 if never paid). */
    subUntil(payer) {
      const p = lower(payer); let until = 0;
      for (const l of readControlRows(subsFile)) if (lower(l.payer) === p && Number(l.until) > until) until = Number(l.until);
      return until;
    },
    /** Addrs this node has written to (outbound human) — supplies "replying = consent". */
    knownContacts(selfAddr) { return knownContactsOf(selfAddr); },

    /** VIEW 1 — inbox: known/accepted human conversations only (Requests and blocked are excluded). */
    inbox(selfAddr, limit = 50) { return humanThreads(selfAddr, 'inbox', limit); },
    /** VIEW 3 — requests: first contact from an unknown, un-blocked sender, awaiting reply/accept. */
    requests(selfAddr, limit = 50) { return humanThreads(selfAddr, 'requests', limit); },
    /** VIEW 2 — watch my bot: the autonomous conversations this user's bot is having with other bots. */
    botActivity(selfAddr, limit = 50) {
      const self = lower(selfAddr);
      const rows = readAll(file).filter((m) => m.origin === 'bot' && (lower(m.from) === self || lower(m.to) === self));
      return groupThreads(rows).slice(0, limit);
    },
    thread(threadId, limit = 200) {
      return readAll(file).filter((m) => m.thread === threadId).sort((a, b) => orderOf(a) - orderOf(b)).slice(0, limit);
    },
    all() { return readAll(file); },
  };
}

// Ordering runs on rxAt (our clock). Rows written before rxAt existed fall back to ts, which is the
// only place a sender-chosen value is still trusted — and only for already-stored history.
const orderOf = (m) => (Number.isFinite(m.rxAt) ? m.rxAt : Number(m.ts) * 1000);

// The peer of a human thread → the bucket that thread belongs in. A self-only note has no peer → inbox.
function bucketForThread(thread, self, blocked, accepted, known) {
  const peer = (thread.peers || []).map(lower).find((p) => p !== self);
  if (!peer) return 'inbox';
  return decideInbound({ from: peer, self, origin: 'human', blocked, accepted, hasOutboundTo: (a) => known.has(lower(a)) }).bucket;
}

function groupThreads(rows) {
  const t = new Map();
  for (const m of rows) {
    const g = t.get(m.thread) || { thread: m.thread, messages: 0, lastTs: 0, lastAt: -Infinity, last: '', peers: new Set() };
    g.messages++;
    const at = orderOf(m);
    if (at >= g.lastAt) { g.lastAt = at; g.lastTs = m.ts; g.last = m.body.slice(0, 80); }
    g.peers.add(m.from); g.peers.add(m.to);
    t.set(m.thread, g);
  }
  return [...t.values()].map((g) => ({ ...g, peers: [...g.peers] })).sort((a, b) => b.lastAt - a.lastAt);
}

module.exports = { createStore, FILE };
