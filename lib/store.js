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
  // A delete is an append: {id, deleted:true}. It rides the same last-write-wins-by-id rule as any
  // other row, so the log stays append-only (nothing is mutated in place). The tombstone is STICKY —
  // once an id is retired, an identical envelope redelivered afterwards stays hidden, so a harasser
  // cannot un-delete their message by resending it (envelopeId is deterministic → same id).
  const tombstoned = new Set();
  for (const l of raw.split(/\r?\n/)) {
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.deleted) { tombstoned.add(m.id); byId.delete(m.id); continue; }
    if (tombstoned.has(m.id)) continue;
    byId.set(m.id, m);
  }
  return [...byId.values()];
}

// control rows are EVENTS, not id-keyed — read them all in order; foldControl resolves last-write-wins.
function readControlRows(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function createStore(file = FILE, controlFile, opts = {}) {
  const ctrlFile = controlFile || process.env.LAWBOR_CONTROL || (file + '.control');
  const subsFile = process.env.LAWBOR_SUBS || (file + '.subs');

  /* Retention — bound how much history one node keeps. Before this, the log grew forever; and once the
   * in-memory index landed (below), "forever" meant unbounded RAM too, not just disk. Compaction is the
   * ONLY operation that rewrites the file; it drops tombstoned + superseded rows and anything past the
   * cap. 0 = unbounded (the default, so nothing changes for a node that doesn't opt in). */
  const maxMessages = Number.isFinite(opts.maxMessages) ? opts.maxMessages : 0;   // keep newest N live msgs
  const maxAgeMs    = Number.isFinite(opts.maxAgeMs)    ? opts.maxAgeMs    : 0;    // drop msgs older than this
  const compactEvery = Number.isFinite(opts.compactEvery) ? opts.compactEvery : 0; // auto-compact every N records
  let sinceCompact = 0;

  /* In-memory message index, loaded once and kept in sync by record(). Before this, every
   * inbox/requests/jobs/thread call re-read AND re-parsed the WHOLE JSONL — so a flooder amplified
   * their cost into O(n) work on every read (the DoS surface named in SECURITY.md). Now the file is
   * parsed once; record() appends to disk AND to the index, so reads are O(1) amortized.
   * Single-writer assumption: two node processes on one LAWBOR_DB would desync (already warned against
   * — DESKTOP.md). The read path falls back to the file if the cache was never primed. */
  let msgCache = null;
  const deletedIds = new Set();   // ids retired by a tombstone — keeps warm reads sticky, same as readAll
  const primeCache = () => {
    // One pass that builds the live index AND remembers tombstoned ids, so record() can refuse to
    // re-admit a redelivered-after-delete envelope to the warm cache exactly as readAll hides it on a
    // cold read. Mirrors readAll's tombstone logic (kept in lockstep with it).
    msgCache = new Map();
    let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch {}
    for (const l of raw.split(/\r?\n/)) {
      if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.deleted) { deletedIds.add(m.id); msgCache.delete(m.id); continue; }
      if (deletedIds.has(m.id)) continue;
      msgCache.set(m.id, m);
    }
  };
  const readMsgs = () => { if (!msgCache) primeCache(); return [...msgCache.values()]; };

  /* Physically shrink the on-disk log to the retention bounds and rebuild the index. This is the only
   * place the file is rewritten, so it is the only place tombstoned bodies actually leave the disk.
   * Written to a temp file then renamed — libuv's rename passes MOVEFILE_REPLACE_EXISTING, an atomic
   * overwrite on Windows and POSIX, so a crash mid-compact leaves the old log intact, never a half-file.
   * Single-writer only (same as record()): running this while another process appends would drop that
   * process's writes — a node must compact its OWN store, in-process. */
  function compact({ now } = {}) {
    const clock = typeof now === 'function' ? now : Date.now;
    let rawCount = 0;
    try { for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) if (l.trim()) rawCount++; }
    catch { return { totalBefore: 0, kept: 0, removed: 0 }; }
    let rows = readAll(file);                                   // live msgs, tombstones already resolved away
    if (maxAgeMs > 0) { const floor = clock() - maxAgeMs; rows = rows.filter((m) => orderOf(m) >= floor); }
    rows.sort((a, b) => orderOf(a) - orderOf(b));               // oldest → newest
    if (maxMessages > 0 && rows.length > maxMessages) rows = rows.slice(rows.length - maxMessages); // keep newest N
    const tmp = file + '.compact.' + process.pid;
    fs.writeFileSync(tmp, rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
    msgCache = new Map(rows.map((r) => [r.id, r]));             // rebuild the index from the compacted set
    // Compaction physically removes the tombstones, so it also forgets the deletions — the body is gone,
    // which was the whole point. A still-active harasser should be BLOCKED (permanent in the control
    // log); delete is for scrubbing a stored body, block is for stopping a sender.
    deletedIds.clear();
    sinceCompact = 0;
    return { totalBefore: rawCount, kept: rows.length, removed: rawCount - rows.length };
  }

  const readControl = () => foldControl(readControlRows(ctrlFile));
  // addrs this node has an OUTBOUND human message to — replying is implicit consent.
  const knownContactsOf = (selfAddr) => {
    const self = lower(selfAddr);
    const set = new Set();
    for (const m of readMsgs()) if (m.origin === 'human' && m.dir === 'out' && lower(m.from) === self) set.add(lower(m.to));
    return set;
  };
  // human threads whose peer falls in a given consent bucket ('inbox' | 'requests')
  const humanThreads = (selfAddr, bucketWanted, limit) => {
    const self = lower(selfAddr);
    const { blocked, accepted } = readControl();
    const known = knownContactsOf(self);
    const rows = readMsgs().filter((m) => m.origin === 'human' && (lower(m.from) === self || lower(m.to) === self));
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
      // A redelivered envelope whose id a tombstone already retired stays out of the warm cache, so
      // warm reads agree with readAll's cold path (the delete is sticky, not undone by a resend).
      if (msgCache && !deletedIds.has(row.id)) msgCache.set(row.id, row);
      // Auto-compact keeps a busy node bounded without a separate scheduler; off unless a cap is set.
      if (compactEvery > 0 && (maxMessages > 0 || maxAgeMs > 0) && ++sinceCompact >= compactEvery) compact();
      return row;
    },

    /** Local delete: retire a stored message by id (appends a sticky tombstone; body leaves disk on the
     *  next compact). Gives a harassment victim the "remove an already-stored body" the store lacked. */
    deleteMsg(id) {
      if (!id) return { ok: false, reason: 'no id' };
      fs.appendFileSync(file, JSON.stringify({ id, deleted: true, at: Date.now() }) + '\n');
      deletedIds.add(id);              // so a redelivery is refused on the warm path, sticky like readAll
      if (msgCache) msgCache.delete(id);
      return { ok: true, id };
    },
    /** Physically shrink the log to the retention bounds; drops tombstoned + over-cap rows from disk. */
    compact,

    /** How many INBOUND messages we've stored from `addr` since `sinceMs` (our clock). Feeds the
     *  receive-time rate-limit — bounds how fast one sender can fill your store, even a reputable one. */
    countRecentFrom(addr, sinceMs) {
      const a = lower(addr); let n = 0;
      for (const m of readMsgs()) if (m.dir === 'in' && lower(m.from) === a && Number(m.rxAt) >= sinceMs) n++;
      return n;
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
      const rows = readMsgs().filter((m) => m.origin === 'bot' && (lower(m.from) === self || lower(m.to) === self));
      return groupThreads(rows).slice(0, limit);
    },
    thread(threadId, limit = 200) {
      return readMsgs().filter((m) => m.thread === threadId).sort((a, b) => orderOf(a) - orderOf(b)).slice(0, limit);
    },
    all() { return readMsgs(); },
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
