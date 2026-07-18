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
const { validateEnvelope, signablePayload } = require('./envelope');

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
  const inFlight = new Set();                                            // ids being awaited right now
  // Opt-in to the OLD, spoofable behaviour. Named loudly on purpose: with this on, `from` is a claim
  // anyone can make, so the reputation gate scores an address the sender merely typed.
  const allowUnauthenticated = cfg.allowUnauthenticated === true;
  /* PEERBOOK — owned here, or delegated to mesh.js.
   * ------------------------------------------------
   * `cfg.peers` may be an array (this relay keeps its own Set — the original behaviour) OR a
   * function (mesh.js owns the book and this relay only reads it). The delegated form is what stops
   * server.js's transport map and this Set from drifting apart: when they disagreed, the relay said
   * "forward", the transport found no url, the envelope vanished — and node.say() still told the
   * human delivered:true.
   * `cfg.selectTargets` likewise delegates FAN-OUT. Without it, an unknown destination broadcasts to
   * every peer, so amplification grows with the table. mesh.selectTargets caps it at `fanout`.
   */
  const ownPeers = new Set((Array.isArray(cfg.peers) ? cfg.peers : []).map((p) => p.toLowerCase()));
  const delegated = typeof cfg.peers === 'function';
  const peerList = delegated ? () => cfg.peers().map((p) => p.toLowerCase()) : () => [...ownPeers];
  const knows = (a) => peerList().indexOf(a) !== -1;
  const pickTargets = typeof cfg.selectTargets === 'function'
    ? (to, opts) => cfg.selectTargets(to, opts).map((p) => p.toLowerCase())
    : (to) => (knows(to) ? [to] : peerList());

  /**
   * AUTHENTICATE `from` before anything else asks the oracle about it.
   * ------------------------------------------------------------------
   * `env.from` arrives as a CLAIM. Until this existed, the reputation gate scored whatever address
   * the sender typed there, so an attacker refused under their own address was admitted with score
   * 90 by writing a reputable address instead — no key, no signature. Base addresses are public, so
   * the attack cost was zero. Proven in test/lawbor.test.js ("impersonation").
   *
   * Verification is INJECTED, exactly like preflight: recovering a secp256k1 signer needs ecrecover
   * and keccak256, and node ships neither, so a zero-dependency core cannot do it alone. The
   * operator wires viem/ethers. With no verifier the relay does NOT quietly trust `from` — it
   * refuses, unless the operator has explicitly named the risk with allowUnauthenticated:true.
   */
  async function authenticate(env) {
    if (typeof cfg.verifySig !== 'function') {
      if (allowUnauthenticated) return { ok: true, authenticated: false };
      return { ok: false, reason: 'no signature verifier configured — FAIL CLOSED (inject verifySig, or set allowUnauthenticated:true to accept spoofable `from`)' };
    }
    if (!env.sig) return { ok: false, reason: 'envelope carries no signature — `from` would be an unverified claim' };
    let v;
    try { v = await cfg.verifySig({ payload: signablePayload(env), sig: env.sig, claimed: env.from }); }
    catch (e) { return { ok: false, reason: 'signature verifier threw — FAIL CLOSED (' + e.message + ')' }; }
    if (!v || v.ok !== true || !isAddr(v.signer)) return { ok: false, reason: 'signature did not verify' };
    if (v.signer.toLowerCase() !== env.from.toLowerCase()) {
      return { ok: false, reason: 'signature is valid but signed by ' + v.signer.toLowerCase() + ', not `from` — impersonation refused' };
    }
    return { ok: true, authenticated: true };
  }

  async function gate(sender) {
    let v; try { v = await cfg.preflight(sender); } catch (e) { return { ok: false, reason: 'preflight down — FAIL CLOSED (' + e.message + ')' }; }
    if (!v || v.decision !== 'PROCEED') return { ok: false, reason: 'sender not PROCEED on MainStreet (' + ((v && v.decision) || 'UNKNOWN') + ')' };
    if (!(Number(v.score) >= minScore)) return { ok: false, reason: 'sender score ' + (v && v.score) + ' < ' + minScore + ' — too low to relay' };
    return { ok: true, score: v.score };
  }

  return {
    self, minScore, maxHops, authenticates: typeof cfg.verifySig === 'function',
    peers: peerList,
    // When mesh.js owns the book, admission is ITS job (verify the discovery card, gate on
    // reputation, first-write-wins). Silently accepting an addr here would recreate exactly the
    // ungated side-door the peer layer exists to close.
    addPeer: (p) => {
      if (delegated) return false;
      if (isAddr(p) && p.toLowerCase() !== self) { ownPeers.add(p.toLowerCase()); return true; }
      return false;
    },

    /** Handle one inbound envelope. Returns an ACTION for the caller to perform (deliver/forward/drop). */
    async accept(env) {
      const struct = validateEnvelope(env);
      if (!struct.ok) return { action: 'drop', reason: struct.reason };
      if (seen.has(env.id)) return { action: 'drop', reason: 'already seen (dedup)' };
      if (env.hops > maxHops) return { action: 'drop', reason: 'hop cap exceeded' };
      /* IN-FLIGHT RESERVATION — the same TOCTOU that voided mesh.addPeer's guarantees.
       * `seen.has` above ran, then authenticate() and gate() both await, and only THEN did seen.add
       * run. Two copies of one envelope arriving over two gossip paths in the same tick both passed
       * the check and both delivered (proven). The dedup test missed it because it is sequential.
       *
       * The naive fix — seen.add() before the awaits — is worse: `sig` is in neither envelopeId()
       * nor validateEnvelope(), so an attacker could replay an envelope with a corrupted signature,
       * burn the id, and get the genuine one dropped as a duplicate. Hence a SEPARATE in-flight set,
       * released on every failure path and only promoted to `seen` on success. */
      if (inFlight.has(env.id)) return { action: 'drop', reason: 'already in flight (concurrent duplicate)' };
      inFlight.add(env.id);
      const release = (r) => { inFlight.delete(env.id); return r; };
      // WHO is speaking, before WHETHER they are reputable. Scoring an unauthenticated `from` is
      // scoring a stranger's choice of name.
      const a = await authenticate(env);
      if (!a.ok) return release({ action: 'drop', reason: a.reason });
      const g = await gate(env.from);                          // reputation gate on the ORIGINAL sender
      if (!g.ok) return release({ action: 'drop', reason: g.reason });
      seen.add(env.id);
      inFlight.delete(env.id);                                 // promoted: `seen` owns it from here
      if (env.to.toLowerCase() === self) {
        // `authenticated` travels with the delivery so the UI can tell a proven sender from a
        // merely-claimed one instead of rendering both identically.
        return { action: 'deliver', to: 'human', envelope: env, senderScore: g.score, authenticated: a.authenticated };
      }
      // not for us → forward one hop toward peers we know (gossip); caller transports it
      const next = { ...env, hops: env.hops + 1 };
      // notFrom: never bounce an envelope back to the peer that just handed it to us.
      const targets = pickTargets(env.to.toLowerCase(), { notFrom: env.from.toLowerCase() });
      return { action: 'forward', envelope: next, targets, senderScore: g.score };
    },

    /** A human hands their bot an OUTBOUND message → build+gate is the caller's (envelope.js); the relay just
     *  marks it seen so it won't loop back, and returns the first-hop targets. */
    async originate(env) {
      if (env.from.toLowerCase() !== self) return { action: 'drop', reason: 'a bot only originates its OWN messages' };
      seen.add(env.id);
      const targets = pickTargets(env.to.toLowerCase(), {});
      if (!targets.length) return { action: 'drop', reason: 'no peers known yet — join the mesh first' };
      return { action: 'forward', envelope: env, targets };
    },
  };
}

module.exports = { createRelay };
