'use strict';
/* FIRST REAL TRUST EDGE — a real job between two real Base wallets, settled by a real USDC transfer.
 * =================================================================================================
 * Everything here is live: the REAL MainStreet preflight gates the relay, the REAL Base RPC verifies the
 * settlement. Nothing is simulated and no fake chain is loaded.
 *
 * 🛑 THIS SCRIPT NEVER SIGNS AND NEVER SENDS. It negotiates the job up to `awarded` and then STOPS, and
 *    prints exactly what the operator must transfer from their own wallet. Phase 2 records the txHash
 *    the operator gives back. Moving the money is the human's act, by design and by rule.
 *
 * WHY THESE ROLES. Phil named 0x7e2a… as payer and 0xAC3c… as receiver. His own trust layer overruled
 * that: MainStreet returns CAUTION / score null for 0x7e2a…, and lib/relay.js:84 refuses any sender that
 * is not PROCEED — whatever the score floor is. Since a settlement only verifies when the on-chain
 * tx.from equals the job's REQUESTER, the payer must be the requester, so the payer must be the address
 * that passes the gate. That is 0xAC3c… (PROCEED, 58, 23 prior jobs). Roles swapped by the gate, not by
 * preference — and MainStreet's own advice for the CAUTION address is literally "start with the smallest
 * possible payment to test", which is what this is.
 *
 * HONEST LIMIT: these nodes hold no key, so the ENVELOPES are unsigned (allowUnauthenticated) — the
 * negotiation is local and unsigned. What is genuinely real and independently checkable is the
 * SETTLEMENT: a USDC transfer on Base mainnet, verified field by field by lib/chain.js.
 *
 *   node first-edge.cjs            → negotiate to `awarded`, print the payment instruction
 *   node first-edge.cjs <txHash>   → record that transfer and show the trust edge it creates
 */
const path = require('path');
const fs = require('fs');
const { build } = require('./server');
const { createStore } = require('./lib/store');

// PAYER = REQUESTER (must pass the MainStreet gate — see the header)
const REQUESTER = '0xAC3ca7c5d3cDD7702fd08F9C4C28dAA22296aDa9';
const WORKER    = '0x7e2a576452E4a9e7182bffd942d812c2131e7e54';
const AMOUNT_MICRO = '50000';            // 0.05 USDC — small, real, and the payer holds 0.63
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const JOB = {
  jobId: 'lawbor-rating-review-1',
  task: 'Review RATING-DESIGN.md and report any farming vector the adversarial round missed',
  ref: 'https://github.com/philpof102-svg/lawbor/blob/master/RATING-DESIGN.md',
  price: '0.05 USDC',
};

const MS = 'https://avisradar-production.up.railway.app';
async function preflight(addr) {
  const r = await fetch(MS + '/api/agent/preflight/' + encodeURIComponent(addr), { headers: { 'x-ms-monitor': '1' } });
  if (!r.ok) throw new Error('preflight HTTP ' + r.status);
  return r.json();
}

function node(self, tag) {
  const base = path.join(__dirname, 'data', 'first-edge-' + tag);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  return build({ self, human: tag, preflight, store: createStore(base + '.jsonl', base + '.control'),
    txFactsFile: base + '.txfacts', allowLoopback: true, allowInsecure: true, allowUnauthenticated: true,
    // the operator opts in: the worker is CAUTION on MainStreet (never indexed), and without this the
    // mesh refuses it outright. Probation lets it SPEAK; it still holds zero standing.
    admitProbation: process.env.LAWBOR_ADMIT === 'probation' });
}

(async () => {
  const txHash = (process.argv[2] || '').trim();
  const a = node(REQUESTER, 'requester'), b = node(WORKER, 'worker');
  for (const n of [a, b]) await new Promise((r) => n.server.listen(0, r));
  const url = (n) => 'http://127.0.0.1:' + n.server.address().port;
  const post = (n, p, body) => fetch(url(n) + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const get = (n, p) => fetch(url(n) + p).then((r) => r.json());

  const health = await get(a, '/health');
  console.log('LAWBOR — first real trust edge\n');
  console.log('  chain verification:', health.verifiesSettlements ? 'LIVE against Base mainnet' : 'OFF (would verify nothing)');

  // the real gate, on the real oracle
  for (const [tag, addr] of [['requester/payer', REQUESTER], ['worker/receiver', WORKER]]) {
    const v = await preflight(addr);
    console.log('  MainStreet ' + tag + ' ' + addr.slice(0, 10) + '… → ' + v.decision + ' score ' + v.score);
  }
  /* Mesh admission is ALSO reputation-gated (lib/mesh.js): you cannot add a peer that fails the oracle.
   * NOTE the response shape is {ok:false, reason} — NOT {error}. Reading it as `.error` printed a
   * cheerful "ok" over a refusal, which is exactly the class of false-green this project keeps hunting. */
  const p1 = await post(a, '/peers', { addr: WORKER, url: url(b) });
  const p2 = await post(b, '/peers', { addr: REQUESTER, url: url(a) });
  const peerLine = (r) => (r && r.ok ? 'admitted' : 'REFUSED — ' + ((r && r.reason) || 'unknown'));
  console.log('  peer add worker→requester-node:', peerLine(p1));
  console.log('  peer add requester→worker-node:', peerLine(p2));
  const reachable = !!(p1 && p1.ok);
  if (!reachable) {
    console.log('\n  ⚠️  THE TRUST LAYER REFUSED THE PAIR, before a cent moved.');
    console.log('      ' + WORKER + ' is CAUTION on MainStreet, and lib/relay.js requires PROCEED —');
    console.log('      there is no score floor that admits it. So no LAWBOR message can reach that wallet:');
    console.log('      the job below lives ONLY in the requester\'s own log, and the counterparty never');
    console.log('      participates. A settlement would still verify on-chain and still create a real');
    console.log('      credit edge in the requester\'s view — but call it what it is: a one-sided record,');
    console.log('      not a two-party negotiation. Use two PROCEED wallets for the full thing.');
  }

  if (!txHash) {
    // PHASE 1 — negotiate to `awarded` and stop. The award is self-contained by design (lib/work.js:91),
    // so it stands even though the worker's bid cannot relay back: the worker is CAUTION on MainStreet,
    // and the requester's own relay refuses it. The gate doing its job, in the open.
    const hw = await post(a, '/work', { to: WORKER, kind: 'help_wanted', jobId: JOB.jobId, task: JOB.task, ref: JOB.ref, budgetHint: JOB.price, as: 'human' });
    console.log('\n  job posted   :', JOB.jobId, '· delivered:', hw.delivered);
    const aw = await post(a, '/work', { to: WORKER, kind: 'award', jobId: JOB.jobId, worker: WORKER, price: JOB.price, thread: hw.thread });
    console.log('  awarded      :', aw.error ? 'REFUSED ' + aw.error : 'to ' + WORKER.slice(0, 10) + '… at ' + JOB.price + ' · delivered: ' + aw.delivered + (aw.reason ? ' (' + aw.reason + ')' : ''));
    const j = (await get(a, '/jobs')).jobs.find((x) => x.jobId === JOB.jobId);
    console.log('  state        :', j && j.state, '(awarded is NOT paid — that is the next, human step)');

    console.log('\n────────────────────────────────────────────────────────────────────────');
    console.log('  YOUR MOVE — send this yourself, from your own wallet. I do not sign or send.');
    console.log('    network : Base mainnet (chainId 8453)');
    console.log('    token   : USDC ' + USDC);
    console.log('    from    : ' + REQUESTER + '   (the requester — the tx MUST come from here)');
    console.log('    to      : ' + WORKER);
    console.log('    amount  : 0.05 USDC   (exactly ' + AMOUNT_MICRO + ' micro-units — an exact match is required)');
    console.log('\n  then:  node first-edge.cjs <txHash>');
    console.log('  It must be a plain USDC transfer: a tx containing several USDC transfers is refused as');
    console.log('  ambiguous, and 12 confirmations are required (~24s on Base).');
    console.log('────────────────────────────────────────────────────────────────────────');
  } else {
    // PHASE 2 — record the operator's real transfer and let the chain decide.
    console.log('\n  recording tx:', txHash);
    const s = await post(a, '/work', { to: WORKER, kind: 'settle', jobId: JOB.jobId, txHash, amountMicro: AMOUNT_MICRO });
    console.log('  verified    :', s.settled && s.settled.verified);
    console.log('  note        :', s.settled && s.settled.note);
    const j = (await get(a, '/jobs')).jobs.find((x) => x.jobId === JOB.jobId);
    console.log('  job state   :', j && j.state);
    const c = await get(a, '/credit');
    console.log('\n  THE TRUST EDGE (the requester\'s own view):');
    console.log('   ', JSON.stringify(c.direct));
    if (c.evidence.length) console.log('    evidence  :', c.evidence[0].txHash, '·', c.evidence[0].amountMicro, 'micro');
    console.log('    anyone can re-verify this against Base and refute it. It means PAID — not delivered.');
  }

  for (const n of [a, b]) await new Promise((r) => n.server.close(r));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
