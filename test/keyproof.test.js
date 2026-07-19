'use strict';
/**
 * LAWBOR key-proof — proving you hold an address WITHOUT holding USDC.
 * =====================================================================
 * The penny-drop (a dust USDC transfer) proves key control, but it charges the prover gas AND requires
 * them to already hold USDC — which a freshly-created agent wallet does not. That is friction aimed at
 * exactly the party most worth checking: the stranger about to be paid. So `validate` also accepts an
 * off-chain signature over `LAWBOR-KEY:<addr>`.
 *
 * The properties under test are NOT "a signature works". They are the three ways this could quietly
 * become a lie:
 *   1. an UNVERIFIED proof must confer nothing (fail-closed, like every other evidence path here);
 *   2. it must prove the KEY and not the RAIL — payeeProved true, pathValidated FALSE;
 *   3. it must NEVER reach lib/credit.js. A proof costs nothing, so if it could move standing it would
 *      be farmable in bulk, and that is precisely how five earlier rating designs died.
 * Run: node test/keyproof.test.js
 */
const assert = require('node:assert');
const work = require('../lib/work');
const { creditFor } = require('../lib/credit');
const { createAuthVerifier, keyProofMessage } = require('../lib/verify');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'aa'.repeat(20);         // requester
const B = '0x' + 'bb'.repeat(20);         // worker, the one who must prove their key
const SIG = '0xfeedface';

/** A job where B has cited a signature proof. Chain facts are irrelevant here by construction. */
const msgs = (extra = []) => [
  { id: '1', from: A, to: B, rxAt: 1, body: work.buildWork('help_wanted', { jobId: 'j1', task: 'fix the indexer' }) },
  { id: '2', from: B, to: A, rxAt: 2, body: work.buildWork('bid', { jobId: 'j1', price: '50 USDC' }) },
  { id: '3', from: A, to: B, rxAt: 3, body: work.buildWork('award', { jobId: 'j1', worker: B, price: '50 USDC' }) },
  { id: '4', from: B, to: A, rxAt: 4, body: work.buildWork('validate', { jobId: 'j1', keyAddr: B, keySig: SIG }) },
  ...extra,
];
const good = () => ({ sigFacts: new Map([[SIG, { signer: B }]]) });

(async () => {
  console.log('\nLAWBOR key-proof (prove your key with no USDC and no gas)\n');

  await t('a proof with NO injected verdict confers nothing — fail-closed, like every other evidence path', () => {
    const j = work.foldThread(msgs()).get('j1');
    assert.equal(j.payeeProved, false, 'an unresolved signature must never read as proven');
    assert.equal(work.provenFrom(msgs()).size, 0);
  });

  await t('a proof signed by the WRONG key is refused — the whole point of the mechanism', () => {
    const j = work.foldThread(msgs(), { sigFacts: new Map([[SIG, { signer: A }]]) }).get('j1');
    assert.equal(j.payeeProved, false, 'A cannot prove B holds B');
  });

  await t('THE PROPERTY: a verified proof proves the KEY, and pointedly not the RAIL', () => {
    const j = work.foldThread(msgs(), good()).get('j1');
    assert.equal(j.payeeProved, true, 'B proved they hold B');
    assert.equal(j.pathValidated, false,
      'a signature says NOTHING about whether a transfer between these two would land — conflating the two is what the separate verbs exist to prevent');
  });

  await t('a verified proof NEVER becomes standing — it is free, so it would be farmable in bulk', () => {
    const m = msgs();
    assert.deepEqual(work.settlementsFrom(m, good()), [], 'no edge may be born from a signature');
    // and the end-to-end number a payer actually reads must be untouched
    const c = creditFor(A, work.settlementsFrom(m, good()), {});
    assert.equal(c.direct.size, 0, 'no direct standing may exist');
    assert.equal(c.circle.size, 0, 'and none may leak in through the circle');
    assert.equal(c.evidence.length, 0, 'nor may a signature appear as evidence of payment');
  });

  await t('a thousand free proofs still buy exactly zero — the farm, priced', () => {
    const many = [];
    const facts = new Map();
    for (let i = 0; i < 1000; i++) {
      const sybil = '0x' + String(i).padStart(40, '0');
      const sig = '0x' + (0xf0000 + i).toString(16).padStart(8, '0');
      many.push(
        { id: 'h' + i, from: A, to: sybil, rxAt: 100 + i, body: work.buildWork('help_wanted', { jobId: 'f' + i, task: 'x' }) },
        { id: 'v' + i, from: sybil, to: A, rxAt: 200 + i, body: work.buildWork('validate', { jobId: 'f' + i, keyAddr: sybil, keySig: sig }) },
      );
      facts.set(sig, { signer: sybil });   // every single one genuinely verifies
    }
    const c = creditFor(A, work.settlementsFrom(many, { sigFacts: facts }), {});
    assert.equal(c.direct.size, 0, '1000 valid proofs, zero standing');
    assert.equal(c.circle.size, 0);
    assert.equal(work.provenFrom(many, { sigFacts: facts }).size, 1000, 'they are all genuinely proven keys — which is worth nothing');
  });

  await t('the fold is order-independent: the proof may arrive BEFORE the award', () => {
    const early = [...msgs()].map((m) => (m.id === '4' ? { ...m, rxAt: 0 } : m));
    assert.equal(work.foldThread(early, good()).get('j1').payeeProved, true,
      'proving your key before being awarded is the useful case, not an edge case');
  });

  await t('buildWork refuses a validate that proves nothing at all', () => {
    assert.throws(() => work.buildWork('validate', { jobId: 'j1' }), /tx hash|keyAddr/);
    assert.throws(() => work.buildWork('validate', { jobId: 'j1', keySig: SIG }), /keyAddr/);
  });

  await t('a REAL signature verifies, an impostor does not, and a foreign one cannot be replayed', async () => {
    let accounts; try { accounts = require('viem/accounts'); } catch { console.log('      (viem absent — skipped)'); return; }
    const me = accounts.privateKeyToAccount('0x' + '11'.repeat(32));
    const other = accounts.privateKeyToAccount('0x' + '22'.repeat(32));
    const va = createAuthVerifier();
    assert.ok(va, 'viem is installed, so a verifier must be built');
    const message = keyProofMessage(me.address);
    const sig = await me.signMessage({ message });

    assert.equal((await va({ message, sig, claimed: me.address })).ok, true);
    assert.equal((await va({ message, sig, claimed: other.address })).ok, false, 'impersonation refused');
    // THE DOMAIN SEPARATION: a signature this key made for ANOTHER protocol's login must not pass as ours.
    const foreign = await me.signMessage({ message: 'Sign in to Example: 12345' });
    assert.equal((await va({ message, sig: foreign, claimed: me.address })).ok, false,
      'a harvested login signature must not be replayable as a LAWBOR key proof');
  });

  await t('absence of viem stays a supported state, testable regardless of what is installed', () => {
    assert.equal(createAuthVerifier({ viem: null }), null);
  });

  /* THE GAP THAT LET THE REAL BUG SHIP. Every test above injects sigFacts by hand, so none of them ever
   * executes server.js::resolveFacts — the code that actually turns a signature into a fact. In
   * production that function began with `if (!chain) return`, so on a node with LAWBOR_RPC_URL=off a key
   * proof could NEVER verify: the one feature that needs no chain was sitting behind the chain gate.
   * A live two-node run caught it; the whole unit suite could not. So this test goes through the real
   * server with NO chain reader at all. */
  await t('END TO END WITH NO CHAIN: a key proof verifies on a node that has no RPC', async () => {
    let accounts; try { accounts = require('viem/accounts'); } catch { console.log('      (viem absent — skipped)'); return; }
    const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
    const { build } = require('../server');
    const { createStore } = require('../lib/store');
    const { keyProofMessage } = require('../lib/verify');

    const worker = accounts.privateKeyToAccount('0x' + 'd4'.repeat(32));
    const me = '0x' + 'ee'.repeat(20);
    const base = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-kp-')), 'store');
    const store = createStore(base + '.jsonl', base + '.control');

    const s = build({
      self: me, store, chain: null,                     // <- NO CHAIN. This is the whole point.
      preflight: async () => ({ decision: 'PROCEED', score: 90 }),
      allowUnauthenticated: true, allowLoopback: true, allowInsecure: true,
    });

    const sig = await worker.signMessage({ message: keyProofMessage(worker.address) });
    // record the two envelopes directly — we are testing RESOLUTION, not transport
    for (const [from, to, body] of [
      [me, worker.address, work.buildWork('help_wanted', { jobId: 'j', task: 'work' })],
      [worker.address, me, work.buildWork('validate', { jobId: 'j', keyAddr: worker.address, keySig: sig })],
      [me, worker.address, work.buildWork('award', { jobId: 'j', worker: worker.address, price: '10 USDC' })],
    ]) store.record({ id: '0x' + Math.random().toString(16).slice(2), thread: 't', from, to, body, ts: 1 }, { origin: 'bot', dir: 'out' });

    await s.resolveFacts(store.all());
    const job = work.foldThread(store.all(), s.foldOpts).get('j');
    assert.equal(job.validations[0].verified, true, 'resolveFacts must verify a signature WITHOUT a chain reader');
    assert.equal(job.payeeProved, true);
    assert.equal(job.pathValidated, false, 'and still only the key, never the rail');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
