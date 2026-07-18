'use strict';
/**
 * LAWBOR — node.js  (a bot node: ties the relay + store + transport into one running bot)
 * =========================================================================================
 * This is what "runs autonomous" (Phil): a bot node that
 *   - a HUMAN drives via say()  → builds the envelope, records it (origin:'human'), relays to peers
 *   - RECEIVES peer envelopes via receive() → reputation-gated relay → delivers to the human's inbox
 *     or forwards on; delivered peer messages are recorded so the human sees them
 *   - can speak AUTONOMOUSLY via botSay() → recorded origin:'bot' so it shows in the "watch my bot" view
 * Transport is INJECTED (send(target, envelope) → your HTTP/openclaude transport); the node never opens a
 * socket or holds a key itself. The operator's signer signs each envelope's descriptor before send.
 */
const { buildEnvelope } = require('./envelope');
const { createRelay } = require('./relay');
const { createStore } = require('./store');

/** @param {{self:string, preflight:Function, send:Function, minScore?:number, peers?:string[], store?:object, human?:string}} cfg */
function createNode(cfg = {}) {
  if (typeof cfg.send !== 'function') throw new Error('send(target, envelope) transport required (inject your HTTP/openclaude transport)');
  // verifySig / allowUnauthenticated travel straight through to the relay: authenticating `from` is
  // the relay's job, and the node must not be able to silently soften it.
  const relay = createRelay({ self: cfg.self, preflight: cfg.preflight, minScore: cfg.minScore, peers: cfg.peers,
    verifySig: cfg.verifySig, allowUnauthenticated: cfg.allowUnauthenticated,
    selectTargets: cfg.selectTargets });
  const store = cfg.store || createStore();
  const human = cfg.human || null;

  async function dispatch(env, targets) {
    for (const to of targets) { try { await cfg.send(to, env); } catch (e) { /* transport retriable — dedup makes resend safe */ } }
  }

  return {
    self: relay.self, relay, store, addPeer: relay.addPeer, peers: relay.peers,

    /** The HUMAN sends a message through their bot. Returns the built envelope (descriptor to sign) + action. */
    async say(to, body, opts = {}) {
      const { envelope, sign } = buildEnvelope({ from: cfg.self, to, body, thread: opts.thread, viaHuman: human });
      store.record(envelope, { origin: 'human', dir: 'out' });
      const r = await relay.originate(envelope);
      if (r.action === 'forward') await dispatch(r.envelope, r.targets);
      return { envelope, sign, delivered: r.action === 'forward', reason: r.reason || null };
    },

    /** The BOT speaks autonomously (shows up in the human's "watch my bot" feed). */
    async botSay(to, body, opts = {}) {
      const { envelope, sign } = buildEnvelope({ from: cfg.self, to, body, thread: opts.thread, viaHuman: null });
      store.record(envelope, { origin: 'bot', dir: 'out' });
      const r = await relay.originate(envelope);
      if (r.action === 'forward') await dispatch(r.envelope, r.targets);
      return { envelope, sign, delivered: r.action === 'forward' };
    },

    /** A peer bot delivered an envelope to us. Reputation-gate → deliver to human OR forward. Records what we keep. */
    async receive(env) {
      const r = await relay.accept(env);
      if (r.action === 'deliver') {
        /* CONSENT block — reputation decided this bot may RELAY into the mesh; a block decides whether
         * this address reaches ME AT ALL. It applies to EVERY inbound surface (human message, bot
         * chatter, AND job/negotiation messages) — a block means "I hear nothing from you, anywhere",
         * or a blocked sender simply switches to sending jobs `as:'bot'` to keep spamming you (found
         * by adversarial probing: consent used to check only viaHuman, so bot-origin job spam sailed
         * past a block and showed up in /jobs). Quarantine (the Requests bucket) is SEPARATE and
         * read-time, and only splits human first-contact — it is not this check.
         * Dropped BEFORE the append-only store records anything (there is no delete, so a stored
         * abusive body is permanent), with no delivery confirmation, so a block is indistinguishable
         * from silence. Without this seam lib/consent.js would be decorative. */
        const { blocked } = store.control();
        if (blocked.has(String(env.from).toLowerCase())) return { action: 'drop', reason: 'blocked' };
        // authenticated:false means the sender's `from` was never cryptographically proven — the
        // store keeps that distinction so a UI can show it rather than implying every sender is real.
        // origin = the peer's intent: a human-authored msg (viaHuman set) vs a bot's autonomous msg.
        store.record(env, { origin: env.viaHuman ? 'human' : 'bot', dir: 'in', senderScore: r.senderScore, authenticated: r.authenticated === true });
      } else if (r.action === 'forward') {
        await dispatch(r.envelope, r.targets);   // relay onward, decentralized
      }
      return r; // {action, reason?} — caller (the HTTP endpoint) can 200/drop accordingly
    },

    /* LOCAL consent controls — the operator's own block/accept list. Never gossiped, no key, no funds.
     * block: stop a sender (inbound dropped before storage). accept: promote a Requests thread to the
     * inbox. unblock: reverse a block. All three just append to the local control log. */
    block(addr) { store.appendControl('block', addr); return { ok: true, addr: String(addr).toLowerCase() }; },
    unblock(addr) { store.appendControl('unblock', addr); return { ok: true, addr: String(addr).toLowerCase() }; },
    accept(addr) { store.appendControl('accept', addr); return { ok: true, addr: String(addr).toLowerCase() }; },
  };
}

module.exports = { createNode };
