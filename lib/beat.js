'use strict';
/**
 * LAWBOR — beat.js  (WHICH peers to contact now, and WHEN to wake again. PURE — no timers, no I/O.)
 * ==================================================================================================
 * mesh.js deliberately schedules nothing and opens nothing, so somebody has to drive liveness — and
 * until this existed, nobody did: prune() was never called and dead peers accumulated forever. That
 * is the same class of mistake as shipping a peer layer nothing imports, one size smaller.
 *
 * The DECISIONS live here (pure, testable offline); the sockets and the setTimeout live in the
 * caller. Three properties this file exists to guarantee:
 *
 *   - THUNDERING HERD. Every node waking on the same round number turns a mesh into a synchronised
 *     broadcast storm, and it gets worse as the network grows. Every delay is jittered by ±jitterFrac
 *     off the injected rng, so wake-ups spread out instead of aligning.
 *   - HEARTBEAT AMPLIFICATION. A tick that pings the whole table makes contact cost O(peers). Each
 *     tick contacts at most `batch` peers, oldest-contact-first, so cost is bounded and no peer
 *     starves.
 *   - POINTLESS TRAFFIC. A peer contacted a second ago does not need contacting again. Only peers
 *     whose lastSeen is older than intervalMs are due.
 *
 * Anchors are included in the due list — an operator's seed can be down like anything else, and
 * knowing that is useful — but mesh.prune() never removes them, so a quiet anchor is reported, not
 * evicted.
 */

/** Peers due for contact, oldest first, capped at `batch`.
 *  @param {Array<{addr:string,lastSeen:number}>} peers · @param {number} now
 *  @param {{intervalMs?:number, batch?:number}} opts */
function dueFor(peers, now, opts = {}) {
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 60_000;
  const batch = Number.isInteger(opts.batch) && opts.batch > 0 ? opts.batch : 4;
  return (Array.isArray(peers) ? peers : [])
    .filter((p) => p && typeof p.addr === 'string')
    // a peer with no lastSeen at all is maximally overdue, not skipped
    .map((p) => ({ addr: p.addr, lastSeen: Number.isFinite(p.lastSeen) ? p.lastSeen : -Infinity }))
    .filter((p) => now - p.lastSeen >= intervalMs)
    .sort((a, b) => a.lastSeen - b.lastSeen)
    .slice(0, batch)
    .map((p) => p.addr);
}

/** A jittered delay before the next tick. Never returns <= 0, or the caller busy-loops.
 *  @param {{intervalMs?:number, jitterFrac?:number, rng?:Function}} opts */
function nextDelay(opts = {}) {
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 60_000;
  const jitterFrac = Number.isFinite(opts.jitterFrac) ? Math.max(0, Math.min(opts.jitterFrac, 0.9)) : 0.3;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const spread = intervalMs * jitterFrac;
  const delay = intervalMs - spread + rng() * spread * 2;      // uniform in [i-spread, i+spread]
  return Math.max(1, Math.round(delay));
}

/**
 * Who to offer our peer sample to this tick, if anyone.
 * Peer exchange is how a node grows past its seed list, but it also LEAKS the graph (see mesh.js
 * limit 3), so it is deliberately stingy: at most one peer per tick, and only every `everyNTicks`.
 * Returns null when this tick should not gossip.
 */
function offerTarget(peerAddrs, tick, opts = {}) {
  const everyN = Number.isInteger(opts.everyNTicks) && opts.everyNTicks > 0 ? opts.everyNTicks : 5;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const list = (Array.isArray(peerAddrs) ? peerAddrs : []).filter((a) => typeof a === 'string');
  if (!list.length || tick % everyN !== 0) return null;
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

module.exports = { dueFor, nextDelay, offerTarget };
