'use strict';
/**
 * LAWBOR — relay.js  (the bot's message relay: reputation-gated, dedup'd, decentralized routing)
 * ================================================================================================
 * Each bot runs a relay. It ACCEPTS envelopes from peer bots and either delivers them to its human
 * (when to === self) or forwards them one hop toward the destination. The relay is what makes the mesh
 * decentralized AND safe:
 *   - REPUTATION-GATED: a bot only accepts/forwards from a sender whose MainStreet score ≥ minScore.
 *     Anti-spam + "safe-to-talk" — a burner bot can't flood the mesh. Injectable preflight, FAIL CLOSED.
 *   - DEDUP: each envelope id is delivered/forwarded once (idempotent — gossip can retry safely).
 *   - HOP CAP: hops can't exceed maxHops (no infinite relay loops).
 * No central server: a relay only knows its peers (mesh.js); messages gossip hop-by-hop.
 *
 * 🛑 No keys, no network here — the relay decides accept/deliver/forward; the caller does the actual
 *   transport (openclaude bot loop / OpenGateway). Everything injectable + testable offline.
 */
const { validateEnvelope } = require('./envelope');

const isAddr = (a) => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);

/** Create a relay for one bot.
 *  @param {{self:string, minScore?:number, maxHops?:number, preflight:Function, peers?:string[], seen?:Set}} cfg
 *  preflight(addr) → {decision:'PROCEED'|..., score} (wire to MainStreet /api/agent/preflight/<addr>). */
function createRelay(cfg = {}) {
  if (!isAddr(cfg.self)) throw new Error('self must be the bot 0x address');
  if (typeof cfg.preflight !== 'function') throw new Error('preflight required (wire to MainStreet preflight)');
  const self = cfg.self.toLowerCase();
  const minScore = Number.isFinite(cfg.minScore) ? cfg.minScore : 40;   // MainStreet SAFE floor
  const maxHops = Number.isInteger(cfg.maxHops) ? cfg.maxHops : 6;
  const seen = cfg.seen || new Set();                                    // dedup by envelope id
  let peers = new Set((cfg.peers || []).map((p) => p.toLowerCase()));

  async function gate(sender) {
    let v; try { v = await cfg.preflight(sender); } catch (e) { return { ok: false, reason: 'preflight down — FAIL CLOSED (' + e.message + ')' }; }
    if (!v || v.decision !== 'PROCEED') return { ok: false, reason: 'sender not PROCEED on MainStreet (' + ((v && v.decision) || 'UNKNOWN') + ')' };
    if (!(Number(v.score) >= minScore)) return { ok: false, reason: 'sender score ' + (v && v.score) + ' < ' + minScore + ' — too low to relay' };
    return { ok: true, score: v.score };
  }

  return {
    self, peers: () => [...peers], addPeer: (p) => { if (isAddr(p) && p.toLowerCase() !== self) peers.add(p.toLowerCase()); },

    /** Handle one inbound envelope. Returns an ACTION for the caller to perform (deliver/forward/drop). */
    async accept(env) {
      const struct = validateEnvelope(env);
      if (!struct.ok) return { action: 'drop', reason: struct.reason };
      if (seen.has(env.id)) return { action: 'drop', reason: 'already seen (dedup)' };
      if (env.hops > maxHops) return { action: 'drop', reason: 'hop cap exceeded' };
      const g = await gate(env.from);                          // reputation gate on the ORIGINAL sender
      if (!g.ok) return { action: 'drop', reason: g.reason };
      seen.add(env.id);
      if (env.to.toLowerCase() === self) {
        return { action: 'deliver', to: 'human', envelope: env, senderScore: g.score }; // it's for us → hand to the human
      }
      // not for us → forward one hop toward peers we know (gossip); caller transports it
      const next = { ...env, hops: env.hops + 1 };
      const targets = peers.has(env.to.toLowerCase()) ? [env.to.toLowerCase()] : [...peers]; // direct peer, else gossip to all
      return { action: 'forward', envelope: next, targets, senderScore: g.score };
    },

    /** A human hands their bot an OUTBOUND message → build+gate is the caller's (envelope.js); the relay just
     *  marks it seen so it won't loop back, and returns the first-hop targets. */
    async originate(env) {
      if (env.from.toLowerCase() !== self) return { action: 'drop', reason: 'a bot only originates its OWN messages' };
      seen.add(env.id);
      const targets = peers.has(env.to.toLowerCase()) ? [env.to.toLowerCase()] : [...peers];
      if (!targets.length) return { action: 'drop', reason: 'no peers known yet — join the mesh first' };
      return { action: 'forward', envelope: env, targets };
    },
  };
}

module.exports = { createRelay };
