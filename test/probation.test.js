'use strict';
// LAWBOR probation — the opt-in onboarding policy. Measured cause: MainStreet only scores addresses it
// has already INDEXED (unknown => score null, not 0), so with PROCEED as a hard rule the mesh is closed
// to every newcomer — four real wallets, one with 2241 txs, were all refused. These tests pin the two
// halves that make relaxing it safe: it is OFF unless asked, and it buys a stranger NOTHING but a voice.
// Run: node test/probation.test.js
const assert = require('node:assert');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const { createNode } = require('../lib/node');
const { createStore } = require('../lib/store');
const { creditFor } = require('../lib/credit');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const ME = '0x' + '11'.repeat(20), STRANGER = '0x' + '99'.repeat(20), GOOD = '0x' + '22'.repeat(20);
// the real oracle's shape for an address it has never indexed: CAUTION, score NULL (not 0)
const preflight = async (a) => String(a).toLowerCase() === GOOD.toLowerCase()
  ? { decision: 'PROCEED', score: 58 }
  : { decision: 'CAUTION', score: null };

const mkNode = (tag, admitProbation) => {
  const db = path.join(os.tmpdir(), 'lawbor-prob-' + process.pid + '-' + tag);
  for (const e of ['.jsonl', '.control']) { try { fs.unlinkSync(db + e); } catch {} }
  return createNode({ self: ME, human: 'me', preflight, send: async () => {}, peers: [GOOD, STRANGER],
    store: createStore(db + '.jsonl', db + '.control'), allowUnauthenticated: true, admitProbation });
};
// REAL envelopes: the id is derived from the contents, so a hand-rolled one is refused as tampered —
// which is the relay being right, and worth keeping the test honest about.
const { buildEnvelope } = require('../lib/envelope');
const envelope = (from, body) => buildEnvelope({ from, to: ME, body, viaHuman: 'someone' }).envelope;

(async () => {
  console.log('LAWBOR probation — a newcomer may SPEAK, and earns nothing by it:');

  await t('DEFAULT: an address MainStreet never indexed is refused (strict behaviour unchanged)', async () => {
    const n = mkNode('off', false);
    const r = await n.receive(envelope(STRANGER, 'hello, let me in'));
    assert.equal(r.action, 'drop');
    assert.match(r.reason, /not PROCEED/);
  });

  await t('a PROCEED sender is admitted either way, and is NOT flagged probation', async () => {
    for (const admit of [false, true]) {
      const n = mkNode('good' + admit, admit);
      const r = await n.receive(envelope(GOOD, 'gm'));
      assert.equal(r.action, 'deliver');
      assert.equal(r.probation, false, 'a vouched-for peer must never be tagged probation');
      assert.equal(r.senderScore, 58);
    }
  });

  await t('OPT-IN: with probation on, the stranger is admitted — flagged, and scored 0 not null', async () => {
    const n = mkNode('on', true);
    const r = await n.receive(envelope(STRANGER, 'I would like to work'));
    assert.equal(r.action, 'deliver');
    assert.equal(r.probation, true, 'the flag must travel with the delivery');
    assert.equal(r.senderScore, 0, 'never the oracle\'s null — a probationer is scored zero, explicitly');
  });

  await t('THE POINT: being admitted is NOT being trusted — a probationer holds zero standing', async () => {
    // Conservation does the protecting now: standing is bounded by what the VIEWER itself paid, so a
    // stranger who talks all day is still worth exactly 0. This is why letting them speak is safe.
    const c = creditFor(ME, [
      { payer: STRANGER, worker: GOOD, amountMicro: '999000000', blockTime: 1, txHash: '0x' + '1'.repeat(64), jobId: 'a' },
      { payer: GOOD, worker: STRANGER, amountMicro: '999000000', blockTime: 2, txHash: '0x' + '2'.repeat(64), jobId: 'b' },
    ]);
    assert.equal(c.direct.get(STRANGER.toLowerCase()) || 0, 0);
    assert.equal(c.circle.get(STRANGER.toLowerCase()) || 0, 0);
    assert.equal(c.inbound.get(STRANGER.toLowerCase()) || 0, 0, 'talking, and washing on-chain, earns nothing');
  });

  await t('a blocked probationer is still blocked — consent outranks admission', async () => {
    const n = mkNode('blocked', true);
    n.block(STRANGER);
    const r = await n.receive(envelope(STRANGER, 'let me back in'));
    assert.equal(r.action, 'drop');
    assert.equal(r.reason, 'blocked');
  });

  await t('the probation flag is PERSISTED, so no read view can present them as vouched for', async () => {
    const n = mkNode('store', true);
    await n.receive(envelope(STRANGER, 'stored with a flag'));
    const row = n.store.all().find((m) => String(m.from).toLowerCase() === STRANGER.toLowerCase());
    assert.ok(row, 'the message was stored');
    assert.equal(row.probation, true);
  });

  /* THE ORACLE IS NOT ALLOWED TO BE A SINGLE POINT OF FAILURE.
   * Every inbound envelope on every node used to require a successful HTTP call to one service we
   * operate — so that service going down stopped the whole mesh, everywhere, for everyone. For a
   * project whose claim is that no authority decides who exists, that was the authority.
   * The rule now: an outage is mapped onto the decision the OPERATOR already made, never onto a new one. */
  const { createRelay } = require('../lib/relay');
  const { buildEnvelope } = require('../lib/envelope');
  const env = () => buildEnvelope({ from: STRANGER, to: ME, body: 'hello', viaHuman: null }).envelope;
  const relay = (cfg) => createRelay({ self: ME, allowUnauthenticated: true, ...cfg });
  const down = async () => { throw new Error('ECONNREFUSED'); };

  await t('proceed-only + oracle DOWN still fails closed — no score means no decision', async () => {
    const r = await relay({ preflight: down }).accept(env());
    assert.equal(r.action, 'drop');
    assert.match(r.reason, /FAIL CLOSED/);
  });

  await t('probation + oracle DOWN admits, because this operator already admits unknown senders', async () => {
    const r = await relay({ preflight: down, admitProbation: true }).accept(env());
    assert.equal(r.action, 'deliver');
    assert.equal(r.probation, true);
    assert.equal(r.senderScore, 0, 'never the oracle\'s null, and never a borrowed score');
  });

  await t('THE SOUNDNESS ARGUMENT: an outage produces the SAME state as a CAUTION answer, not a new one', async () => {
    const outage = await relay({ preflight: down, admitProbation: true }).accept(env());
    const caution = await relay({ preflight: async () => ({ decision: 'CAUTION', score: null }), admitProbation: true }).accept(env());
    assert.deepEqual(
      { a: outage.action, p: outage.probation, s: outage.senderScore },
      { a: caution.action, p: caution.probation, s: caution.senderScore },
      'if these ever diverge, the outage path has invented a state the operator never chose — which is exactly what "fail open" would be');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
