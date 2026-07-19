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
    // admitProbation travels through for the same reason: the onboarding policy is the relay's gate to
    // apply, and the node must not be able to soften — or silently widen — it on its own.
    admitProbation: cfg.admitProbation,
    selectTargets: cfg.selectTargets });
  const store = cfg.store || createStore(undefined, undefined, {
    maxMessages: cfg.maxMessages, maxAgeMs: cfg.maxAgeMs, compactEvery: cfg.compactEvery,
  });
  const human = cfg.human || null;
  // Inbound rate-limit: at most `maxInbound` stored messages from one sender per `rateWindowMs`.
  // Reputation and consent decide WHO may reach you; this bounds HOW FAST — so a reputable (or a
  // just-accepted, or a floor-passing sybil) sender cannot flood your store. 0 disables it.
  const maxInbound = Number.isFinite(cfg.maxInbound) ? cfg.maxInbound : 120;
  const rateWindowMs = Number.isFinite(cfg.rateWindowMs) ? cfg.rateWindowMs : 60_000;
  const now = typeof cfg.clock === 'function' ? cfg.clock : Date.now;

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
         * Dropped BEFORE the store records anything — cheaper than storing then deleting, and a block
         * needs no cleanup. (store.deleteMsg now also exists for bodies that DID get stored before a
         * block; this drop path means a blocked sender never creates one.) No delivery confirmation is
         * returned, so a block is indistinguishable from silence. Without this seam consent is decorative. */
        const { blocked } = store.control();
        if (blocked.has(String(env.from).toLowerCase())) return { action: 'drop', reason: 'blocked' };
        // RATE-LIMIT — bound how fast this sender can fill our store, before we store anything.
        if (maxInbound > 0 && typeof store.countRecentFrom === 'function' &&
            store.countRecentFrom(env.from, now() - rateWindowMs) >= maxInbound) {
          return { action: 'drop', reason: 'rate-limited' };
        }
        // authenticated:false means the sender's `from` was never cryptographically proven — the
        // store keeps that distinction so a UI can show it rather than implying every sender is real.
        // origin = the peer's intent: a human-authored msg (viaHuman set) vs a bot's autonomous msg.
        /* A PROBATION sender is stored as `probation` so no read view can present them as vouched for.
         * They were admitted only so a newcomer can speak at all (see lib/relay.js); they hold no
         * standing (conservation makes a stranger worth 0) and the operator still decides, by hand,
         * whether they ever reach the inbox. Being admitted is not being trusted. */
        store.record(env, { origin: env.viaHuman ? 'human' : 'bot', dir: 'in', senderScore: r.senderScore, authenticated: r.authenticated === true, probation: r.probation === true, rxAt: now() });
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
    /* Local delete of an already-stored body (a block only stops FUTURE messages) + on-demand retention
     * compaction. Both are operator-local, gossip nothing, hold no key — same rule as block/accept. */
    deleteMsg(id) { return typeof store.deleteMsg === 'function' ? store.deleteMsg(id) : { ok: false, reason: 'unsupported' }; },
    compact(o) { return typeof store.compact === 'function' ? store.compact(o) : { totalBefore: 0, kept: 0, removed: 0 }; },
  };
}

module.exports = { createNode };
