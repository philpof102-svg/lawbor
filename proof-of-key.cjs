'use strict';
/* PROOF OF KEY — the full arc, on real Base data, with real money nowhere near it.
 * =================================================================================================
 * Phil sent a genuine ZERO-value USDC transfer on Base:
 *   0x47712673… -> 0xAC3ca7c5…   0.000000 USDC   tx 0xc5c15545…   (gas only)
 * That is the bank micro-deposit, on-chain: it cost nothing but gas, and because 0x4771 SIGNED it, it
 * proves 0x4771 holds that key. This script plays the whole guard flow against it:
 *
 *   1. a job is posted to 0x4771 — an address MainStreet has NEVER indexed (CAUTION, score null),
 *      admitted only because the operator opted into probation;
 *   2. awarding it a LARGE amount is REFUSED — nobody has proven that address is controlled;
 *   3. the zero-value transfer is recorded as a `validate` — the payee's key is now proven;
 *   4. the same award now goes through.
 *
 * The point: a stranger with no reputation and no money moved can still make themselves safe to pay,
 * for the price of gas. That is the onboarding path the PROCEED-only mesh never had.
 *
 * 🛑 Nothing here signs or sends. It reads Base and folds messages. Run: node proof-of-key.cjs
 */
const path = require('path'), fs = require('fs');
const { build } = require('./server');
const { createStore } = require('./lib/store');

const REQUESTER = '0xAC3ca7c5d3cDD7702fd08F9C4C28dAA22296aDa9';   // PROCEED 58 on MainStreet
const WORKER    = '0x47712673daBA17cc2ddEAA285A8aCBA33012e643';   // CAUTION, score null — a stranger
const PROOF_TX  = '0xc5c1554562bcdc45541781028d15e1e298a90678554f241c36de399b3e998414';
const THRESHOLD = 1;    // refuse to commit more than 1 USDC to an address nobody has proven

const MS = 'https://avisradar-production.up.railway.app';
const preflight = async (a) => {
  const r = await fetch(MS + '/api/agent/preflight/' + encodeURIComponent(a), { headers: { 'x-ms-monitor': '1' } });
  if (!r.ok) throw new Error('preflight HTTP ' + r.status);
  return r.json();
};

const mk = (self, tag) => {
  const b = path.join(__dirname, 'data', 'proofkey-' + tag);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  for (const e of ['.jsonl', '.control', '.txfacts']) { try { fs.unlinkSync(b + e); } catch {} }
  return build({ self, human: tag, preflight, store: createStore(b + '.jsonl', b + '.control'),
    txFactsFile: b + '.txfacts', requireProofAbove: THRESHOLD, admitProbation: true,
    allowLoopback: true, allowInsecure: true, allowUnauthenticated: true });
};

(async () => {
  const a = mk(REQUESTER, 'req'), b = mk(WORKER, 'wk');
  for (const n of [a, b]) await new Promise((r) => n.server.listen(0, r));
  const u = (n) => 'http://127.0.0.1:' + n.server.address().port;
  const post = (n, p, x) => fetch(u(n) + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(x) }).then((r) => r.json());
  const get = (n, p) => fetch(u(n) + p).then((r) => r.json());

  console.log('LAWBOR — proof of key: a stranger makes themselves safe to pay, for the price of gas\n');
  for (const [tag, addr] of [['requester', REQUESTER], ['worker   ', WORKER]]) {
    const v = await preflight(addr);
    console.log('  MainStreet ' + tag + ' ' + addr.slice(0, 10) + '… → ' + v.decision + ' score ' + v.score);
  }
  const p1 = await post(a, '/peers', { addr: WORKER, url: u(b) });
  const p2 = await post(b, '/peers', { addr: REQUESTER, url: u(a) });
  console.log('  peering (probation on):', (p1.ok ? 'ok' : 'REFUSED ' + p1.reason), '/', (p2.ok ? 'ok' : 'REFUSED ' + p2.reason));
  console.log('  guard: refuse to award more than ' + THRESHOLD + ' USDC to an unproven address\n');

  const hw = await post(a, '/work', { to: WORKER, kind: 'help_wanted', jobId: 'pk-1',
    task: 'Audit the probation admission path', ref: 'https://github.com/philpof102-svg/lawbor', budgetHint: '5 USDC', as: 'human' });
  console.log('  1. job posted to a stranger      · delivered:', hw.delivered);

  const bad = await post(a, '/work', { to: WORKER, kind: 'award', jobId: 'pk-1', worker: WORKER, price: '5 USDC', thread: hw.thread });
  console.log('  2. award 5 USDC                  ·', bad.error ? 'REFUSED ✋' : 'accepted (guard did nothing!)');
  if (bad.error) console.log('       reason:', bad.error);

  const v = await post(a, '/work', { to: WORKER, kind: 'validate', jobId: 'pk-1', txHash: PROOF_TX, thread: hw.thread });
  console.log('  3. the 0 USDC penny-drop         ·', v.validated
    ? (v.validated.signerProvenKey ? 'KEY PROVEN for ' + String(v.validated.signer).slice(0, 12) + '…' : 'not verified')
    : (v.error || '?'));
  if (v.validated) console.log('       ', v.validated.note);

  const ok = await post(a, '/work', { to: WORKER, kind: 'award', jobId: 'pk-1', worker: WORKER, price: '5 USDC', thread: hw.thread });
  console.log('  4. award 5 USDC again            ·', ok.error ? 'still REFUSED: ' + ok.error : 'ACCEPTED ✓ — the key is proven');

  const j = (await get(a, '/jobs')).jobs.find((x) => x.jobId === 'pk-1');
  console.log('\n  job state    :', j && j.state);
  console.log('  payeeProved  :', j && j.payeeProved, ' (a tx SIGNED BY the worker — the only proof that counts)');
  const c = await get(a, '/credit');
  console.log('  standing     :', JSON.stringify(c.direct), ' ← a 0-value proof buys NO reputation, by design');

  for (const n of [a, b]) await new Promise((r) => n.server.close(r));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
