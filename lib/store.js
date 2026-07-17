'use strict';
/**
 * LAWBOR — store.js  (the conversation log behind the TWO human-facing views)
 * ============================================================================
 * Phil's correction: LAWBOR is not invisible bot-to-bot plumbing. Each human has a messaging app
 * (Telegram-shaped, richer): (1) their OWN conversations, and (2) a live VIEW of what their bot is
 * autonomously discussing with other bots. So every message is tagged with its ORIGIN:
 *   - origin 'human'  → the user wrote it (their inbox)
 *   - origin 'bot'    → their bot said it autonomously (the "watch my bot" feed)
 * Append-only JSONL (last write wins per message id), LOOPBOR_DB-overridable, zero network here.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.env.LAWBOR_DB || path.join(__dirname, '..', 'data', 'messages.jsonl');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

function readAll(file = FILE) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const byId = new Map();
  for (const l of raw.split(/\r?\n/)) { if (!l.trim()) continue; try { const m = JSON.parse(l); byId.set(m.id, m); } catch {} }
  return [...byId.values()];
}

function createStore(file = FILE) {
  return {
    /** Record a message. @param {object} env envelope · @param {{origin:'human'|'bot', dir:'in'|'out', senderScore?:number}} meta */
    record(env, meta = {}) {
      const row = { id: env.id, thread: env.thread, from: env.from, to: env.to, body: env.body,
        ts: env.ts, viaHuman: env.viaHuman || null,
        origin: meta.origin === 'bot' ? 'bot' : 'human', dir: meta.dir === 'out' ? 'out' : 'in',
        senderScore: Number.isFinite(meta.senderScore) ? meta.senderScore : null };
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      return row;
    },
    /** VIEW 1 — the human's inbox: threads where a HUMAN (this user or the peer's human) authored a message. */
    inbox(selfAddr, limit = 50) {
      const self = String(selfAddr || '').toLowerCase();
      const rows = readAll(file).filter((m) => m.origin === 'human' && (m.from.toLowerCase() === self || m.to.toLowerCase() === self));
      return groupThreads(rows).slice(0, limit);
    },
    /** VIEW 2 — watch my bot: the autonomous conversations this user's bot is having with other bots. */
    botActivity(selfAddr, limit = 50) {
      const self = String(selfAddr || '').toLowerCase();
      const rows = readAll(file).filter((m) => m.origin === 'bot' && (m.from.toLowerCase() === self || m.to.toLowerCase() === self));
      return groupThreads(rows).slice(0, limit);
    },
    thread(threadId, limit = 200) {
      return readAll(file).filter((m) => m.thread === threadId).sort((a, b) => a.ts - b.ts).slice(0, limit);
    },
    all() { return readAll(file); },
  };
}

// group flat rows into threads (newest-active first), with a preview + unread-ish count
function groupThreads(rows) {
  const t = new Map();
  for (const m of rows) {
    const g = t.get(m.thread) || { thread: m.thread, messages: 0, lastTs: 0, last: '', peers: new Set() };
    g.messages++; if (m.ts >= g.lastTs) { g.lastTs = m.ts; g.last = m.body.slice(0, 80); }
    g.peers.add(m.from); g.peers.add(m.to);
    t.set(m.thread, g);
  }
  return [...t.values()].map((g) => ({ ...g, peers: [...g.peers] })).sort((a, b) => b.lastTs - a.lastTs);
}

module.exports = { createStore, FILE };
