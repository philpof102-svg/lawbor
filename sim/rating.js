'use strict';
/**
 * LAWBOR rating simulation — a REAL collusion ring, moving REAL money, earning nothing.
 * =====================================================================================
 * The unit tests prove the conservation math in isolation. This proves it in the running system: four
 * real nodes on loopback, real relay + consent + work fold, real settle verbs verified through the real
 * chain reader — against a simulated Base ledger that actually executes the transfers.
 *
 * THE THREAT MODEL, STATED HONESTLY. The ring's transfers are NOT fake. Wash trading on Base is real,
 * cheap (~$0.01 of gas) and fully verifiable on-chain: two addresses really can send each other USDC a
 * thousand times and every single transfer will pass any chain check you write. Five rating designs died
 * on exactly this (RATING-DESIGN.md). So this simulation makes the ring's money REAL — the fake ledger
 * executes and confirms every one of their transfers — and the claim under test is not "we detect fake
 * payments". It is:
 *
 *     a ring's internal volume, however large and however genuine, is worth ZERO to a viewer
 *     outside it, because standing is bounded by the VIEWER's own irrecoverable spend.
 *
 * ACT 1  the ring washes a float 60 times (120 verified settlements) — and scores 0 with the viewer.
 * ACT 2  the honest worker does ONE job, gets paid once, and outranks the entire ring.
 * ACT 3  seed capture: the viewer pays a ring member once. The ring's gain is CAPPED at α × that one
 *        payment no matter how much it then washes — the attack is priced, not free.
 *
 * Run: npm run sim:rating
 */
const path = require('path');
const os = require('os');
const { build } = require('../server');
const { createStore } = require('../lib/store');
const { createChainReader, USDC_BASE, TRANSFER_TOPIC } = require('../lib/chain');

const A = (h) => '0x' + h.repeat(20);
const lower = (a) => String(a).toLowerCase();
const VIEW = A('01'), HON = A('02'), RING_A = A('0a'), RING_B = A('0b');
const NAME = { [lower(VIEW)]: 'Viewer', [lower(HON)]: 'Honest', [lower(RING_A)]: 'RingA', [lower(RING_B)]: 'RingB' };
const preflight = async (a) => ({ decision: 'PROCEED', score: 90 });   // reputation is NOT the defence here

let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { pass++; console.log('   ✓ ' + label); } else { fail++; console.log('   ✗ ' + label + (detail ? '\n       ' + detail : '')); } };
const say = (s) => console.log('\n▸ ' + s);
const usd = (micro) => (Number(micro) / 1e6).toLocaleString('en-US') + ' USDC';

/* A simulated Base. Every transfer here REALLY happens as far as any verifier can tell: it gets a tx
 * hash, a receipt, a Transfer log and confirmations. This is what makes the simulation honest — the
 * ring is not cheating the chain, it is using it exactly as intended. */
function fakeBase() {
  const txs = new Map();
  let n = 0, head = 1000;
  return {
    /** Execute a transfer and return its (real, verifiable) hash. */
    pay(from, to, micro) {
      const txHash = '0x' + String(++n).padStart(64, '0');
      head += 20;
      txs.set(txHash, { from: lower(from), to: lower(to), micro: String(micro), block: head - 15 });
      return txHash;
    },
    volume() { return [...txs.values()].reduce((s, t) => s + Number(t.micro), 0); },
    /** The JSON-RPC face, so the REAL lib/chain.js reader is what verifies all of this. */
    rpc: async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      const result = (r) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', result: r }) });
      const hx = (x) => '0x' + x.toString(16);
      if (method === 'eth_chainId') return result(hx(8453));
      if (method === 'eth_blockNumber') return result(hx(head));
      if (method === 'eth_getBlockByNumber') return result({ timestamp: hx(1700000000) });
      if (method === 'eth_getTransactionReceipt') {
        const t = txs.get(params[0]);
        if (!t) return result(null);
        const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
        return result({ status: '0x1', blockNumber: hx(t.block),
          logs: [{ address: USDC_BASE, topics: [TRANSFER_TOPIC, topic(t.from), topic(t.to)], data: hx(BigInt(t.micro)) }] });
      }
      return result(null);
    },
  };
}

async function main() {
  const base = fakeBase();
  const chain = createChainReader({ rpcUrl: 'http://sim-base', fetch: base.rpc });

  const nodes = {};
  for (const s of [VIEW, HON, RING_A, RING_B]) {
    const f = path.join(os.tmpdir(), 'lawbor-rating-' + process.pid + '-' + NAME[lower(s)]);
    for (const ext of ['.jsonl', '.control', '.subs', '.txfacts']) { try { require('fs').unlinkSync(f + ext); } catch {} }
    nodes[lower(s)] = build({ self: s, human: NAME[lower(s)], preflight, chain,
      store: createStore(f + '.jsonl', f + '.control'), txFactsFile: f + '.txfacts',
      allowLoopback: true, allowInsecure: true, allowUnauthenticated: true });
  }
  const url = {};
  for (const s of Object.keys(nodes)) { await new Promise((r) => nodes[s].server.listen(0, r)); url[s] = 'http://127.0.0.1:' + nodes[s].server.address().port; }
  const post = (who, p, b) => fetch(url[lower(who)] + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const get = (who, p) => fetch(url[lower(who)] + p).then((r) => r.json());
  for (const a of [VIEW, HON, RING_A, RING_B]) for (const b of [VIEW, HON, RING_A, RING_B]) if (a !== b) await post(a, '/peers', { addr: b, url: url[lower(b)] });

  /* THE VIEWER IS DELIBERATELY CREDULOUS. LAWBOR has a SECOND, independent defence here: the consent
   * gate quarantines first contact, so a stranger cannot flood you with a fabricated history at all
   * (verified while writing this sim — the ring's broadcast died at message 2 until the viewer accepted
   * them). That defence would MASK the one under test. So we hand the ring the strongest possible
   * position: the viewer accepts them outright, sees every message, and verifies every payment.
   * Conservation then has to hold on its own merits, which is the only interesting question. */
  for (const r of [RING_A, RING_B, HON]) await post(VIEW, '/accept', { addr: r });

  /** One complete job lifecycle, ending in a REAL settled transfer. Returns the tx hash.
   *  `alsoTell` broadcasts every verb to a third party as well — which is precisely what a ring DOES:
   *  it shows the address it wants to impress a real, chain-verified work history. Without this the
   *  simulation would be measuring "the viewer never received their messages", not "the cap holds",
   *  and the depth-2 assertions would pass vacuously at zero. */
  async function jobAndPay(requester, worker, jobId, task, priceUsdc, alsoTell = []) {
    const micro = String(BigInt(priceUsdc) * 1000000n);
    /* The mark is told FIRST, the accomplice second. This is not a trick to make the sim work: an
     * `award` is a state transition, so once the job closes, a second copy is refused by mayApply —
     * which means a ring relaying to its accomplice first could not then show anyone else. A real
     * attacker simply reverses the order (they choose who they relay to, and in what order), so the
     * simulation must too, or it would be measuring our convenience instead of their capability. */
    const both = async (from, verb) => {
      for (const t of alsoTell) if (lower(t) !== lower(verb.to) && lower(t) !== lower(from)) await post(from, '/work', { ...verb, to: t });
      return post(from, '/work', verb);
    };
    await both(requester, { to: worker, kind: 'help_wanted', jobId, task, as: 'human' });
    await both(worker, { to: requester, kind: 'bid', jobId, price: priceUsdc + ' USDC' });
    await both(requester, { to: worker, kind: 'award', jobId, worker, price: priceUsdc + ' USDC' });
    const txHash = base.pay(requester, worker, micro);          // the money REALLY moves
    const r = await both(requester, { to: worker, kind: 'settle', jobId, txHash, amountMicro: micro });
    return { txHash, verified: r.settled && r.settled.verified };
  }

  console.log('LAWBOR rating — a real collusion ring, moving real money, earning nothing\n');
  console.log('cast: Viewer · Honest · RingA + RingB (colluding).  Every address scores 90 at the reputation');
  console.log('gate — reputation is deliberately NOT the defence being tested here.\n');

  // ── ACT 1 ────────────────────────────────────────────────────────────────────────────────────
  say('ACT 1 — the ring washes a float between itself, 60 round trips, all settled on-chain,\n  and BROADCASTS the whole chain-verified history to the Viewer (the real attack: impress the mark)');
  let ringVerified = 0;
  for (let i = 0; i < 60; i++) {
    const a = await jobAndPay(RING_A, RING_B, 'wash-a' + i, 'ring work', 1000, [VIEW]);
    const b = await jobAndPay(RING_B, RING_A, 'wash-b' + i, 'ring work', 1000, [VIEW]);
    if (a.verified) ringVerified++; if (b.verified) ringVerified++;
  }
  console.log(`   the ring produced ${ringVerified} chain-VERIFIED settlements, ${usd(120 * 1000e6)} of genuine on-chain volume`);
  check('every one of the ring\'s settlements really verified against the chain', ringVerified === 120,
    'got ' + ringVerified + '/120 — the sim must not be "winning" by rejecting their txs');

  // ── ACT 2 ────────────────────────────────────────────────────────────────────────────────────
  say('ACT 2 — the honest worker does ONE job for the viewer, and is paid once');
  const hon = await jobAndPay(VIEW, HON, 'real-1', 'index a contract', 500);
  check('the honest job settled', hon.verified === true);

  /* Read the rating through the REAL route, so the sim exercises the shipped surface and not a shortcut.
   * Chain lookups are bounded to 20 per request on purpose (one HTTP call must never become hundreds of
   * RPC calls), so a viewer facing a 120-settlement backlog resolves it over several reads. We drain it
   * here deliberately — the ring must be given EVERY chance to be seen, or the kill proves nothing. */
  const view = async () => { let c; for (let i = 0; i < 10; i++) c = await get(VIEW, '/credit'); return c; };
  const v1 = await view();
  const standing = (c, addr) => {
    const d = (c.direct.find((x) => x.addr === lower(addr)) || {}).usdcMicro || '0';
    const k = (c.circle.find((x) => x.addr === lower(addr)) || {}).usdcMicro || '0';
    return Number(d) + Number(k);
  };
  console.log(`   in the Viewer's eyes:  Honest = ${usd(standing(v1, HON))}   RingA = ${usd(standing(v1, RING_A))}   RingB = ${usd(standing(v1, RING_B))}`);

  // NON-VACUOUS: the viewer must actually HAVE the ring's settlements in its own fold, otherwise this
  // whole act would only be proving "their messages never arrived" — a much weaker and different claim.
  const ringEvidence = v1.evidence.filter((e) => [lower(RING_A), lower(RING_B)].includes(e.payer)).length;
  console.log(`   the Viewer's own fold holds ${ringEvidence} chain-verified ring settlements — it SEES the history`);
  // The bar is "enough that a zero cannot be explained away by the viewer not having looked". The count
  // is what the viewer has verified SO FAR — chain lookups are bounded per read, so a large backlog
  // resolves over several. We do not claim all 120 were verified; we claim these ones were, and are worth 0.
  check('the viewer really received and verified a LARGE part of the ring\'s history (else the kill is vacuous)',
    ringEvidence >= 50, 'only ' + ringEvidence + ' ring settlements verified in the viewer\'s own fold');

  check('THE KILL — the ring has ZERO standing despite ' + ringEvidence + ' verified settlements the viewer CAN SEE',
    standing(v1, RING_A) === 0 && standing(v1, RING_B) === 0,
    'RingA=' + standing(v1, RING_A) + ' RingB=' + standing(v1, RING_B));
  check('one honestly-paid job outranks the entire ring', standing(v1, HON) === 500e6);
  check('the viewer\'s total standing is bounded by what the viewer itself spent (500 USDC)',
    standing(v1, HON) + standing(v1, RING_A) + standing(v1, RING_B) <= 1.5 * 500e6);
  check('the limits ship with the numbers (no bare score anywhere)',
    Array.isArray(v1.limits) && v1.limits.some((l) => /no global score/.test(l)));

  // ── ACT 3 ────────────────────────────────────────────────────────────────────────────────────
  say('ACT 3 — SEED CAPTURE: the viewer pays a ring member once. How much can the ring convert that into?');
  const seeded = await jobAndPay(VIEW, RING_A, 'seed-1', 'a small job', 100);
  check('the seed payment settled', seeded.verified === true);
  // the ring now washes hard, trying to turn one $100 foothold into unbounded standing for RingB
  for (let i = 0; i < 40; i++) await jobAndPay(RING_A, RING_B, 'pump' + i, 'pump', 5000, [VIEW]);
  const v2 = await view();
  const bStanding = standing(v2, RING_B);
  console.log(`   after ${usd(200000e6)} more of ring volume, RingB's standing = ${usd(bStanding)}`);
  check('RingA gets exactly what the viewer paid it, no more', standing(v2, RING_A) === 100e6);
  // The cap must BIND, not be satisfied by an absent edge. RingA really paid RingB 200,000 USDC in the
  // viewer's own fold, so an uncapped design would show RingB a fortune here. Asserting only "<= 50"
  // would pass at 0 and prove nothing — so we require the budget to be genuinely exhausted AT the cap.
  check('the cap actually BINDS: RingB is at exactly α × the seed (50 USDC), not accidentally 0',
    bStanding === 50e6, 'got ' + usd(bStanding) + ' — expected the budget spent to exactly its 50 USDC limit');
  check('so 100 USDC of foothold bought at most 50 USDC of vouching — forever, across all recipients',
    bStanding <= 0.5 * 100e6);
  check('and 200,000 USDC of subsequent washing bought ZERO extra', bStanding === 50e6);

  const total = v2.direct.reduce((s, x) => s + Number(x.usdcMicro), 0) + v2.circle.reduce((s, x) => s + Number(x.usdcMicro), 0);
  const spent = 500e6 + 100e6;
  console.log(`\n   viewer spent ${usd(spent)} · total standing it can see: ${usd(total)} · bound (1+α)·spend = ${usd(1.5 * spent)}`);
  check('CONSERVATION holds in the live system, not just in the unit test', total <= 1.5 * spent);
  console.log(`   the ring moved ${usd(base.volume() - spent)} of its own money and bought ${usd(bStanding)} of standing.`);

  for (const s of Object.keys(nodes)) await new Promise((r) => nodes[s].server.close(r));
  console.log('\n' + (fail ? `❌ ${pass} passed · ${fail} FAILED` : `✅ ${pass} checks passed · 0 failed`));
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('sim failed:', e); process.exit(1); });
