'use strict';
/**
 * LAWBOR bounty simulation — a bot that breaks, pays to get fixed, and stops breaking.
 * =====================================================================================
 * The last loop that had never run end to end. Every other piece was proven; this one closes it:
 *
 *   a REAL repeated failure  ->  the bot posts a bug bounty  ->  a fixer bids  ->  award
 *   ->  a REAL USDC settlement (verified against a chain)  ->  a trust edge  ->  the fix lands
 *
 * The failure is genuine, not narrated: the broken node's transport really throws, tick() really
 * catches it, and the ledger really counts the repeats. Nothing here asserts that a bug was fixed —
 * LAWBOR judges no work. What it proves is that the ECONOMIC loop completes: a bot in trouble can
 * convert money into help, and the help is paid for in a way anyone can re-verify.
 *
 * Run: npm run sim:bounty
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { build } = require('../server');
const { createStore } = require('../lib/store');
const { tick, noteFailure, decideBounty } = require('../lib/autopilot');
const { createChainReader, USDC_BASE, TRANSFER_TOPIC } = require('../lib/chain');

const A = (h) => '0x' + h.repeat(20);
const BROKEN = A('b0'), FIXER = A('f1');
const NAME = { [BROKEN.toLowerCase()]: 'Broken', [FIXER.toLowerCase()]: 'Fixer' };
const preflight = async () => ({ decision: 'PROCEED', score: 80 });

let pass = 0, fail = 0;
const check = (label, cond, detail) => { if (cond) { pass++; console.log('   ✓ ' + label); } else { fail++; console.log('   ✗ ' + label + (detail ? '\n       ' + detail : '')); } };
const say = (s) => console.log('\n▸ ' + s);
const usd = (m) => (Number(m) / 1e6).toFixed(2) + ' USDC';

/** A simulated Base whose transfers really verify through the REAL lib/chain.js reader. */
function fakeBase() {
  const txs = new Map(); let n = 0, head = 1000;
  const hx = (x) => '0x' + x.toString(16);
  return {
    pay(from, to, micro) { const h = '0x' + String(++n).padStart(64, '0'); head += 20; txs.set(h, { from: from.toLowerCase(), to: to.toLowerCase(), micro: String(micro), block: head - 15 }); return h; },
    rpc: async (u, init) => {
      const { method, params } = JSON.parse(init.body);
      const R = (r) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', result: r }) });
      if (method === 'eth_chainId') return R(hx(8453));
      if (method === 'eth_blockNumber') return R(hx(head));
      if (method === 'eth_getBlockByNumber') return R({ timestamp: hx(1700000000) });
      if (method === 'eth_getTransactionReceipt') {
        const t = txs.get(params[0]); if (!t) return R(null);
        const tp = (a) => '0x' + '0'.repeat(24) + a.slice(2);
        return R({ status: '0x1', blockNumber: hx(t.block), logs: [{ address: USDC_BASE, topics: [TRANSFER_TOPIC, tp(t.from), tp(t.to)], data: hx(BigInt(t.micro)) }] });
      }
      return R(null);
    },
  };
}

async function main() {
  const base = fakeBase();
  const chain = createChainReader({ rpcUrl: 'http://sim', fetch: base.rpc });
  const nodes = {};
  for (const s of [BROKEN, FIXER]) {
    const f = path.join(os.tmpdir(), 'lawbor-bounty-' + process.pid + '-' + NAME[s.toLowerCase()]);
    for (const e of ['.jsonl', '.control', '.txfacts']) { try { fs.unlinkSync(f + e); } catch {} }
    nodes[s.toLowerCase()] = build({ self: s, human: NAME[s.toLowerCase()], preflight, chain,
      store: createStore(f + '.jsonl', f + '.control'), txFactsFile: f + '.txfacts',
      allowLoopback: true, allowInsecure: true, allowUnauthenticated: true });
  }
  const url = {};
  for (const k of Object.keys(nodes)) { await new Promise((r) => nodes[k].server.listen(0, r)); url[k] = 'http://127.0.0.1:' + nodes[k].server.address().port; }
  const post = (w, p, b) => fetch(url[w.toLowerCase()] + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const get = (w, p) => fetch(url[w.toLowerCase()] + p).then((r) => r.json());
  for (const a of [BROKEN, FIXER]) for (const b of [BROKEN, FIXER]) if (a !== b) await post(a, '/peers', { addr: b, url: url[b.toLowerCase()] });

  console.log('LAWBOR bounty — a bot that breaks, pays to get fixed, and stops breaking\n');

  // ── 1. a REAL repeated failure ───────────────────────────────────────────────────────────────
  say('ACT 1 — the Broken bot actually fails, three times, on the same thing');
  const brokenNode = nodes[BROKEN.toLowerCase()].node;
  const ledger = new Map();
  // break the transport for real: botSay will throw, tick() will catch it, the ledger will count it
  const realBotSay = brokenNode.botSay.bind(brokenNode);
  let broken = true;
  brokenNode.botSay = async (...args) => {
    if (broken) throw new Error('relay dispatch failed: socket hang up to peer ' + FIXER.slice(0, 10));
    return realBotSay(...args);
  };
  // give it something to try to do, so tick() has an intent that can fail
  await post(FIXER, '/work', { to: BROKEN, kind: 'help_wanted', jobId: 'work-1', task: 'something to bid on', as: 'human' });
  for (let i = 0; i < 3; i++) {
    await tick(brokenNode, { failureLedger: ledger, bidPrice: 10, postBounty: true, bountyAfter: 3, bountyBudget: '25 USDC' });
  }
  const entry = [...ledger.values()][0];
  console.log('   the ledger counted:', entry && entry.count, '×', JSON.stringify(entry && entry.message).slice(0, 60));
  check('the failure is REAL and repeated — not narrated', !!entry && entry.count >= 3);

  // ── 2. the bot posts a bounty for its own bug ────────────────────────────────────────────────
  say('ACT 2 — it posts a BUG BOUNTY for its own fault, and can now speak again');
  broken = false;                                     // the transport recovers; the bug is still open
  ledger.get(entry.key).posted = false;               // not yet asked
  const did = await tick(brokenNode, { failureLedger: ledger, postBounty: true, bountyAfter: 3, bountyBudget: '25 USDC', maxWantedPeers: 2 });
  const posted = did.filter((d) => d.kind === 'bounty');
  for (const p of posted) console.log('   🤖 posted', p.jobId, '· delivered:', p.delivered, '·', p.basis);
  check('a bounty was posted for the bot\'s OWN failure', posted.length >= 1 && posted[0].delivered);
  check('and it is asked ONCE — the ledger marks it, so a broken bot cannot spam', ledger.get(entry.key).posted === true);

  const bountyId = posted[0] && posted[0].jobId;
  const board = await get(FIXER, '/wanted');
  const row = board.wanted.find((w) => w.jobId === bountyId);
  console.log('   the Fixer sees it on the WANTED board:', row ? row.task.slice(0, 62) + '…' : 'NOT VISIBLE');
  check('the bounty is claimable on the open board, with its budget', !!row && row.budgetHint === '25 USDC');
  check('and it is tagged as a bug, so a fixer can find work of its kind', !!row && (row.tags || []).includes('bug'));

  // ── 3. someone takes it, and is paid for real ────────────────────────────────────────────────
  say('ACT 3 — a fixer bids, wins, and is PAID — verified against the chain');
  await post(FIXER, '/work', { to: BROKEN, kind: 'bid', jobId: bountyId, price: '25 USDC', note: 'I will fix the dispatch retry' });
  await post(BROKEN, '/work', { to: FIXER, kind: 'award', jobId: bountyId, worker: FIXER, price: '25 USDC' });
  const micro = '25000000';
  const txHash = base.pay(BROKEN, FIXER, micro);       // the human step: the operator pays
  const s = await post(BROKEN, '/work', { to: FIXER, kind: 'settle', jobId: bountyId, txHash, amountMicro: micro, deliverable: 'https://example.invalid/pr/1' });
  console.log('   settlement verified:', s.settled && s.settled.verified);
  check('the bounty settled against the chain', !!(s.settled && s.settled.verified));

  const j = (await get(BROKEN, '/jobs')).jobs.find((x) => x.jobId === bountyId);
  check('the job is settled (PAID — never "the bug is fixed"; LAWBOR judges no work)', j && j.state === 'settled');

  const credit = await get(BROKEN, '/credit');
  const edge = (credit.direct || []).find((x) => x.addr === FIXER.toLowerCase());
  console.log('   trust edge created:', edge ? usd(edge.usdcMicro) + ' → ' + FIXER.slice(0, 10) + '…' : 'NONE');
  check('paying for the fix created a REAL trust edge with the fixer', !!edge && edge.usdcMicro === micro);

  // ── 4. the loop closes ───────────────────────────────────────────────────────────────────────
  say('ACT 4 — the loop closes: the fixer is now a proven counterparty, priced accordingly');
  const cr = await get(BROKEN, '/credit');
  const creditMap = new Map((cr.direct || []).map((x) => [x.addr, Number(x.usdcMicro)]));
  const { decideAward } = require('../lib/autopilot');
  const jobs2 = require('../lib/work').jobsFrom(brokenNode.store.all());
  const nextJob = { jobId: 'next', state: 'open', requester: BROKEN.toLowerCase(), ready: true,
    bids: [{ worker: FIXER.toLowerCase(), price: '21 USDC', at: 1 }, { worker: A('99').toLowerCase(), price: '20 USDC', at: 2 }] };
  const a1 = decideAward(nextJob, BROKEN, { minBidsBeforeAward: 2, credit: creditMap, provenWorkerTolerance: 0.1 });
  console.log('   next job, fixer bids 21 vs a stranger at 20 →', a1.worker.slice(0, 10) + '…', '|', a1.basis);
  check('the paid fixer now beats a marginally cheaper stranger', a1.worker === FIXER.toLowerCase());
  check('and the reason is the settled history, not a score', /settled/.test(a1.basis || ''));

  console.log('\n   Broken paid ' + usd(micro) + ' to stop breaking, and now has a counterparty it can price.');
  console.log('   Nothing here claims the bug was fixed — only that the work was PAID for, verifiably.');

  for (const k of Object.keys(nodes)) await new Promise((r) => nodes[k].server.close(r));
  console.log('\n' + (fail ? `❌ ${pass} passed · ${fail} FAILED` : `✅ ${pass} checks passed · 0 failed`));
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('sim failed:', e); process.exit(1); });
