'use strict';
/**
 * LAWBOR — credit.js  (rating between bots, and the reason it is not farmable)
 * ================================================================================================
 * Five rating designs were proposed and a dedicated adversary FARMED every one (see RATING-DESIGN.md).
 * The single repair four of the five attackers converged on is the whole content of this file:
 *
 *   rating is a CONSERVED, DEBITED quantity, bounded by the VIEWER's own irrecoverable spend —
 *   never a metric computed over gross flow, and never a global score.
 *
 * There is no score, no leaderboard, no network-wide number. For a viewer V and any address W we derive
 * two per-viewer USDC quantities from the VERIFIED settlement edges (lib/work.js::settlementsFrom):
 *   direct(W) — net USDC V ITSELF paid W, under an award V signed, verified on Base.
 *   circle(W) — credit conferred by the addresses V paid, out of a FINITE budget equal to α · what V paid
 *               them, spent down on conferral (depth-2 personalised trust flow, TrustRank idiom).
 *
 * THE CONSERVATION THEOREM (this IS the anti-farming argument):
 *   Σ_W direct(W) ≤ spend(V)          — every direct edge is V's own outgoing payment, netted
 *   Σ_W circle(W) ≤ α · spend(V)       — budget is α·(what V paid), debited on conferral, never restored
 *   ──────────────────────────────────
 *   total standing in V's view ≤ (1+α) · spend(V)          exactly, by construction.
 *
 * Consequences, each answering a specific farmer:
 *   - A ring recycling a float 200× raises NOTHING: the money never came from V, so no budget exists.
 *   - 20 or 20,000 sybils sum to the SAME bound — a sybil with no credit from V is worth 0 to V.
 *   - To display D dollars in V's view, V must have irrecoverably parted with ~D dollars. An attacker
 *     cannot pay this on V's behalf. Cost-to-fake is denominated in the viewer's own money.
 *
 * NETTING: net(R→W) = max(0, paid(R→W) − returnFlow(W→R)), where returnFlow counts ALL usdc W→R in the
 * window, INCLUDING plain ERC-20 transfers never cited in a settle — the return leg every attacker used.
 * returnFlow is network I/O, so it is INJECTED. With none wired we net settlements only and SAY SO; that
 * is fail-honest (the direct-spend bound still holds), labelled at the call site.
 *
 * Pure, synchronous, total, zero deps. Two nodes with the same edges + returnFlow compute the same result.
 */

const lower = (a) => String(a || '').toLowerCase();
const micro = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/**
 * @param {string} viewer  the address whose view this is (this node's operator)
 * @param {Array}  edges   verified settlement edges {payer, worker, amountMicro, blockTime, txHash, jobId}
 * @param {object} [opts]  { returnFlow?: Map<"payee|payer", micro>, alpha=0.5 }
 * @returns {{direct:Map, circle:Map, evidence:Array, netted:string, limits:string[]}}
 */
function creditFor(viewer, edges = [], opts = {}) {
  const V = lower(viewer);
  const alpha = Number.isFinite(Number(opts.alpha)) ? Number(opts.alpha) : 0.5;
  const rf = opts.returnFlow || null;
  const back = (payee, payer) => {
    if (!rf) return 0;
    const k = payee + '|' + payer;
    return micro(rf.get ? rf.get(k) : rf[k]);
  };

  // 1. aggregate GROSS usdc per directed pair (payer -> worker), remembering the earliest blockTime so
  //    the depth-2 conferral order is deterministic (two nodes must agree when a budget runs out).
  const pair = new Map();   // "payer|worker" -> { payer, worker, gross, at }
  for (const e of edges) {
    const p = lower(e.payer), w = lower(e.worker); if (!p || !w) continue;
    const k = p + '|' + w;
    const cur = pair.get(k) || { payer: p, worker: w, gross: 0, at: Infinity };
    cur.gross += micro(e.amountMicro);
    const bt = Number(e.blockTime); if (Number.isFinite(bt) && bt < cur.at) cur.at = bt;
    pair.set(k, cur);
  }
  // net each pair by the return flow on the reverse edge (paid back, incl. plain transfers)
  const pairs = [...pair.values()].map((x) => ({ ...x, net: Math.max(0, x.gross - back(x.worker, x.payer)) }))
    .filter((x) => x.net > 0);

  // 2. DEPTH 1 — what V itself paid (netted). This is the whole direct surface.
  const direct = new Map();       // worker -> micro
  for (const x of pairs) {
    if (x.payer !== V || x.worker === V) continue;
    direct.set(x.worker, (direct.get(x.worker) || 0) + x.net);
  }
  // seed budget = α · (net V paid that seed). FINITE. Debited on conferral, NEVER replenished.
  const budget = new Map();
  for (const [seed, m] of direct) budget.set(seed, Math.floor(m * alpha));

  // 3. DEPTH 2 — credit conferred by seeds V paid, out of their finite budget. Deterministic order.
  const circle = new Map();       // worker -> micro
  const ordered = pairs.slice().sort((a, b) => (a.at - b.at) || (a.payer + '|' + a.worker).localeCompare(b.payer + '|' + b.worker));
  for (const x of ordered) {
    if (x.payer === V || x.worker === V) continue;   // depth 1 handled; never credit the viewer itself
    const b = budget.get(x.payer);
    if (!b || b <= 0) continue;                       // payer is not a seed V paid, or its budget is spent
    const grant = Math.min(x.net, b);
    if (grant <= 0) continue;
    circle.set(x.worker, (circle.get(x.worker) || 0) + grant);
    budget.set(x.payer, b - grant);                   // DEBIT — the property the farmers could not beat
  }

  const evidence = edges.slice()
    .sort((a, b) => (Number(a.blockTime) || 0) - (Number(b.blockTime) || 0) || String(a.txHash).localeCompare(String(b.txHash)))
    .map((e) => ({ jobId: e.jobId, txHash: e.txHash, payer: lower(e.payer), worker: lower(e.worker), amountMicro: String(e.amountMicro), blockTime: e.blockTime }));

  const limits = [];
  if (!rf) limits.push('return-leg netting is OFF — a payee refunding by plain transfer is invisible here');
  return { direct, circle, evidence, netted: rf ? 'with-return-flow' : 'settlements-only', limits };
}

module.exports = { creditFor };
