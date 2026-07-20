'use strict';
/**
 * LAWBOR — "does it actually reward the bot, and how is that PROVEN?"
 * ==================================================================
 * A single readable demonstration of the one claim the whole project rests on: a bot earns standing
 * IF AND ONLY IF a real, confirmed, correctly-addressed, exact-amount USDC transfer on Base exists for
 * it. Everything is derived by FOLDING the message log against injected chain facts — no trust, no
 * fetch inside the fold. Anyone folding the same log against Base reaches the same verdict and can
 * refute a lie. Run: node sim/reward-proof.js
 */
const assert = require('node:assert');
const { buildWork, foldThread, settlementsFrom, USDC_BASE } = require('../lib/work');
const { creditFor } = require('../lib/credit');

const REQ = '0x' + 'a1'.repeat(20);   // the payer / requester
const W1  = '0x' + 'b1'.repeat(20);   // the worker (the bot we want to reward)
const W2  = '0x' + 'c1'.repeat(20);   // an unrelated third party
let seq = 0;
const row = (from, to, body) => ({ id: '0x' + String(++seq).padStart(4, '0'), from, to, body, ts: 1, rxAt: seq * 1000 });
const usdc = (micro) => (Number(micro) / 1e6).toFixed(2) + ' USDC';
const TX = (n) => '0x' + String(n).padStart(64, '0');

// a real Base USDC transfer fact; override any field to forge a fake
const fact = (over) => ({ chainId: 8453, token: USDC_BASE, from: REQ, to: W1, valueMicro: '5000000', confirmations: 12, blockTime: 1700000000, ...over });
// a job awarded to W1 for 5 USDC, ready to settle
const awarded = () => [
  row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'index a Base contract' })),
  row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '5 USDC' })),
  row(REQ, W1, buildWork('award', { jobId: 'j1', worker: W1, price: '5 USDC' })),
];
const settleMsg = (amount = '5000000', tx = TX(1), by = REQ) => row(by, W1, buildWork('settle', { jobId: 'j1', txHash: tx, amountMicro: amount }));

// standing the payer REQ confers on the worker W1, given a log + chain facts
const standing = (msgs, facts) => {
  const edges = settlementsFrom(msgs, { txFacts: facts });
  const d = creditFor(REQ, edges, {}).direct.get(W1.toLowerCase()) || 0;
  return Number(d);
};

let ok = 0, bad = 0;
const check = (cond, label) => { if (cond) { ok++; console.log('  ' + label); } else { bad++; console.log('  ✗ FAILED: ' + label); } };

console.log('\nLAWBOR — proof it rewards the bot ONLY for a real payment');
console.log('=========================================================');

// ─── ACT 1 — the honest job: a real 5 USDC Base transfer to W1 ───────────────────────────────────
console.log('\nACT 1 · the honest job (a bot gets paid, and it counts)');
{
  const m = [...awarded(), settleMsg()];
  const facts = new Map([[TX(1), fact()]]);
  const j = foldThread(m, { txFacts: facts }).get('j1');
  const s = standing(m, facts);
  check(j.state === 'settled', `✅ job.state = ${j.state}  (REQ paid W1 5.00 USDC on Base, 12 confs — verified field-for-field)`);
  check(s === 5000000, `✅ the bot W1 now holds ${usdc(s)} of standing in the payer's eyes — because the transfer was REAL`);
}

// ─── ACT 2 — every forgery is refused: no real payment ⇒ no reward ───────────────────────────────
console.log('\nACT 2 · every fake is refused (no reward without a real payment)');
const forgeries = [
  ['no chain fact at all',        null],
  ['wrong amount (4.99 != 5.00)', fact({ valueMicro: '4990000' })],
  ['wrong token (not USDC)',      fact({ token: '0x' + '00'.repeat(20) })],
  ['wrong chain (Ethereum L1)',   fact({ chainId: 1 })],
  ['unconfirmed (3 < 12 confs)',  fact({ confirmations: 3 })],
  ['wrong payee (paid W2)',       fact({ to: W2 })],
];
for (const [label, f] of forgeries) {
  const m = [...awarded(), settleMsg()];
  const facts = f ? new Map([[TX(1), f]]) : new Map();
  const j = foldThread(m, { txFacts: facts }).get('j1');
  const s = standing(m, facts);
  check(j.state === 'awarded' && s === 0, `❌ ${label.padEnd(28)} → state=${j.state}, standing ${usdc(s)} (refused)`);
}
// self-wash: REQ pays REQ (requester == worker, a real from==to tx) must never flip to PAID
{
  const m = [
    row(REQ, REQ, buildWork('help_wanted', { jobId: 'j1', task: 'x' })),
    row(REQ, REQ, buildWork('award', { jobId: 'j1', worker: REQ, price: '5 USDC' })),
    row(REQ, REQ, buildWork('settle', { jobId: 'j1', txHash: TX(9), amountMicro: '5000000' })),
  ];
  const facts = new Map([[TX(9), fact({ from: REQ, to: REQ })]]);
  const j = foldThread(m, { txFacts: facts }).get('j1');
  check(j.state !== 'settled', `❌ ${'self-wash (REQ pays REQ)'.padEnd(28)} → state=${j.state} (a wash never proves a payment)`);
}
// zero-value: rejected at BUILD time — it can't even be minted as a settle
{
  let threw = false;
  try { buildWork('settle', { jobId: 'j1', txHash: TX(1), amountMicro: '0' }); } catch { threw = true; }
  check(threw, `❌ ${'zero-value transfer'.padEnd(28)} → rejected at build time (0 proves a live path, not a payment)`);
}
// replay: one txHash cannot settle two different jobs
{
  const two = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'a' })), row(REQ, W1, buildWork('award', { jobId: 'j1', worker: W1, price: '5' })),
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j2', task: 'b' })), row(REQ, W1, buildWork('award', { jobId: 'j2', worker: W1, price: '5' })),
    row(REQ, W1, buildWork('settle', { jobId: 'j1', txHash: TX(7), amountMicro: '5000000' })),
    row(REQ, W1, buildWork('settle', { jobId: 'j2', txHash: TX(7), amountMicro: '5000000' })),   // SAME tx, second job
  ];
  const facts = new Map([[TX(7), fact()]]);
  const jobs = foldThread(two, { txFacts: facts });
  const settled = [...jobs.values()].filter((j) => j.state === 'settled').length;
  check(settled === 1, `❌ ${'replayed txHash (2nd job)'.padEnd(28)} → only ${settled} job settles, not 2 (one transfer, one reward)`);
}
// third-party settler: a stranger cannot settle someone else's job
{
  const m = [...awarded(), row(W2, REQ, buildWork('settle', { jobId: 'j1', txHash: TX(1), amountMicro: '5000000' }))];
  const j = foldThread(m, { txFacts: new Map([[TX(1), fact()]]) }).get('j1');
  check(j.state === 'awarded', `❌ ${'third-party settler (W2)'.padEnd(28)} → state=${j.state} (only requester or payee may settle)`);
}

// ─── ACT 3 — the reward is CONSERVED: a collusion ring earns zero from an outsider ────────────────
console.log('\nACT 3 · the reward is conserved (a collusion ring earns zero from an outsider)');
{
  const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), V = '0x' + 'ee'.repeat(20); // V = an outsider who never paid the ring
  const ring = [];
  const rfacts = new Map();
  // A and B recycle a real 5 USDC back and forth 50 times, each a genuine Base USDC transfer + settle
  for (let i = 0; i < 50; i++) {
    const from = i % 2 ? B : A, to = i % 2 ? A : B, tx = TX(1000 + i);
    ring.push(row(from, to, buildWork('offer', { jobId: 'ring' + i, item: 'wash' + i, price: '5 USDC' })));
    ring.push(row(to, from, buildWork('settle', { jobId: 'ring' + i, txHash: tx, amountMicro: '5000000' })));
    rfacts.set(tx, { chainId: 8453, token: USDC_BASE, from: to, to: from, valueMicro: '5000000', confirmations: 12, blockTime: 1 });
  }
  const edges = settlementsFrom(ring, { txFacts: rfacts });
  const cV = creditFor(V, edges, {});
  const ringStandingToOutsider = [...cV.direct.values()].concat([...cV.circle.values()]).reduce((a, b) => a + Number(b), 0);
  check(ringStandingToOutsider === 0, `✅ 50 real USDC transfers recycled inside the ring → to an OUTSIDER V: ${usdc(ringStandingToOutsider)} standing`);
  check(edges.length === 50, `✅ every transfer was real and verified (${edges.length} edges) — yet conservation gives the outsider ZERO`);
}

console.log('\n─────────────────────────────────────────────────────────────');
console.log(`VERDICT: ${bad === 0 ? 'HOLDS' : 'BROKEN'} — a bot is rewarded IFF a real, confirmed, exact-amount USDC transfer`);
console.log('on Base exists for it, between the right two parties. Every forgery confers nothing,');
console.log('and a collusion ring earns an outsider zero. Proven by fold, not by trust.');
console.log(`\n${ok} checks passed · ${bad} failed`);
process.exit(bad ? 1 : 0);
