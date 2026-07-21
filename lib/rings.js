'use strict';
/**
 * LAWBOR — rings.js  (the STRUCTURAL anti-farming lens: settlement cycles = money that came back)
 * ================================================================================================
 * credit.js already makes farming pointless PER VIEWER: standing is bounded by (1+α)·spend(V), so a ring
 * recycling a float earns nothing in anyone's view. That defense is complete and needs no help. This file
 * answers a DIFFERENT, structural question an operator/analyst asks about the whole log:
 *
 *   "which addresses are settling in CLOSED LOOPS — paying each other in a cycle so the money returns to
 *    where it started?"  A directed cycle A→B→…→A in the VERIFIED settlement graph is the on-chain
 *    signature of wash/self-dealing: real value never entered the loop, it just circulated.
 *
 * This is ADVISORY and READ-ONLY. It never enters the rating (which is already safe) and never gates
 * admission (fail-closed lives in the relay). It surfaces structure a human can act on — block a ring,
 * discount a suspicious cluster in a white-label deployment — with every claim provable on Base.
 *
 * PURE, synchronous, total, zero deps. Bounded on purpose (short cycles only, capped enumeration) so a
 * hostile log cannot make it run forever — the same discipline as the fold. Two nodes with the same edges
 * compute the same rings, in the same order.
 */

const lower = (a) => String(a || '').toLowerCase();
const micro = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/**
 * detectRings — find short directed cycles in the verified settlement graph.
 * @param {Array} edges  verified settlement edges {payer, worker, amountMicro} (as work.settlementsFrom gives)
 * @param {object} [opts] { maxLen=4, maxNodes=2000 }  — bounds that keep this total on any input
 * @returns {{
 *   cycles: Array<{ members:string[], hops:number, recycledMicro:string }>,   // canonical, dedup'd, sorted
 *   addressesInRings: string[],           // every address that sits on at least one cycle
 *   totalRecycledMicro: string,           // Σ the bottleneck of each cycle — the value provably just circulated
 *   limits: string[],
 * }}
 * A cycle's `recycledMicro` is the MIN summed edge along the loop — the most that could have flowed all the
 * way around and returned, i.e. the amount that demonstrably left an address and came back to it.
 */
function detectRings(edges = [], opts = {}) {
  const maxLen = Math.max(2, Math.min(6, Number(opts.maxLen) || 4));   // 2..6, default 4 — short loops only
  const maxNodes = Number(opts.maxNodes) || 2000;
  const limits = [];

  // directed adjacency with summed micro per ordered pair (payer -> worker), self-loops dropped
  const adj = new Map();              // from -> Map<to, micro>
  const nodes = new Set();
  for (const e of (Array.isArray(edges) ? edges : [])) {
    const p = lower(e.payer), w = lower(e.worker);
    if (!p || !w || p === w) continue;
    const m = micro(e.amountMicro);
    if (m <= 0) continue;
    nodes.add(p); nodes.add(w);
    let row = adj.get(p); if (!row) { row = new Map(); adj.set(p, row); }
    row.set(w, (row.get(w) || 0) + m);
  }

  const nodeList = [...nodes].sort();
  if (nodeList.length > maxNodes) {
    limits.push('graph has ' + nodeList.length + ' addresses (> ' + maxNodes + ') — ring enumeration skipped to stay bounded; raise maxNodes to force it');
    return { cycles: [], addressesInRings: [], totalRecycledMicro: '0', limits };
  }

  const rank = new Map(nodeList.map((a, i) => [a, i]));
  const seen = new Set();             // canonical cycle key -> dedup
  const cycles = [];

  /* Enumerate simple directed cycles up to maxLen. Standard bound: only START a cycle from its MINIMUM
   * node (rank 0 of the path), and only walk to nodes ranked strictly higher than the start. Each simple
   * cycle then has exactly ONE start (its min member) and is found exactly once — no rotations, no dupes,
   * and no need for global de-rotation. Direction is preserved, so A→B→A and its reverse are distinct. */
  const start = (s) => {
    const path = [s];
    const onPath = new Set([s]);
    const dfs = (u) => {
      const row = adj.get(u); if (!row) return;
      for (const [v, mv] of row) {
        if (v === s && path.length >= 2) { record(path.slice()); continue; }   // closed the loop back to start
        if (rank.get(v) <= rank.get(s)) continue;    // keep s the unique minimum → each cycle found once
        if (onPath.has(v)) continue;                 // simple cycle: no repeated interior node
        if (path.length >= maxLen) continue;         // bound the length
        path.push(v); onPath.add(v);
        dfs(v);
        path.pop(); onPath.delete(v);
      }
    };
    dfs(s);
  };

  const record = (memberPath) => {
    // bottleneck = the smallest summed edge along the loop = the max that could circulate all the way round
    let bottleneck = Infinity;
    for (let i = 0; i < memberPath.length; i++) {
      const a = memberPath[i], b = memberPath[(i + 1) % memberPath.length];
      bottleneck = Math.min(bottleneck, adj.get(a).get(b) || 0);
    }
    if (!(bottleneck > 0)) return;
    const key = memberPath.join('>');            // already canonical: starts at the min node, fixed direction
    if (seen.has(key)) return;
    seen.add(key);
    cycles.push({ members: memberPath, hops: memberPath.length, recycledMicro: String(bottleneck) });
  };

  for (const s of nodeList) start(s);

  // deterministic order: biggest recycled first, then fewest hops, then lexicographic
  cycles.sort((a, b) => (Number(b.recycledMicro) - Number(a.recycledMicro)) || (a.hops - b.hops) || a.members.join('>').localeCompare(b.members.join('>')));

  const inRings = new Set();
  let total = 0;
  for (const c of cycles) { total += Number(c.recycledMicro); for (const m of c.members) inRings.add(m); }
  limits.push('ADVISORY only — a settlement cycle is the on-chain signature of wash/self-dealing, but a legitimate mutual-trade loop can also form one; this never enters the rating or gates admission');
  limits.push('short cycles only (length ≤ ' + maxLen + '): a ring laundered through a longer chain is not caught here — the per-viewer conservation bound in credit.js is what actually neutralizes it');
  return { cycles, addressesInRings: [...inRings].sort(), totalRecycledMicro: String(total), limits };
}

module.exports = { detectRings };
