'use strict';
// LAWBOR verify — the OPTIONAL signature adapter that lets a node accept inbound peers.
// The property that matters is not "a valid signature is accepted" but "a valid signature by the WRONG
// key is still refused". Run: node test/verify.test.js
const assert = require('node:assert');
/* unique par CONSTRUCTION: un pid n est pas un id de run (Windows les recycle), et un nom
 * reutilise fait heriter le store du run precedent. Voir test/consent.test.js pour l enquete. */
const LAWBOR_TMP = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lawbor-t-"));
const { createVerifier, verifierStatus } = require('../lib/verify');
const { createNode } = require('../lib/node');
const { createStore } = require('../lib/store');
const { buildEnvelope } = require('../lib/envelope');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const ME = '0x' + '11'.repeat(20), PEER = '0x' + '22'.repeat(20), IMPOSTOR = '0x' + '99'.repeat(20);

/** A stand-in for viem: verifies a signature of the form "signed-by:<address>". Lets us test the
 *  ADAPTER's contract (and the relay's use of it) without shipping a crypto dependency into the suite. */
const fakeViem = {
  verifyTypedData: async ({ address, signature }) =>
    String(signature) === 'signed-by:' + String(address).toLowerCase(),
};

const mkNode = (verifySig) => {
  const db = path.join(LAWBOR_TMP, 'verify-' + Math.random().toString(16).slice(2));
  return createNode({ self: ME, human: 'me', preflight: async () => ({ decision: 'PROCEED', score: 80 }),
    send: async () => {}, peers: [PEER], store: createStore(db + '.jsonl', db + '.control'), verifySig });
};
const envelopeFrom = (from, sig) => {
  const { envelope } = buildEnvelope({ from, to: ME, body: 'hello', viaHuman: 'someone' });
  return { ...envelope, sig };
};

(async () => {
  console.log('LAWBOR verify — a node that can finally accept peers, without trusting `from`:');

  await t('with NO verifier the node is fail-closed and SAYS why', async () => {
    const n = mkNode(undefined);
    const r = await n.receive(envelopeFrom(PEER, 'signed-by:' + PEER.toLowerCase()));
    assert.equal(r.action, 'drop');
    assert.match(r.reason, /no signature verifier configured/);
    assert.equal(n.relay.authenticates, false, '/health must report this honestly');
  });

  await t('createVerifier returns NULL when viem is absent — absence is a supported state, not a crash', () => {
    assert.equal(createVerifier({ viem: null }), null);
    const s = verifierStatus();
    assert.equal(typeof s.available, 'boolean');
    if (!s.available) assert.match(s.note, /FAIL-CLOSED/, 'and it explains the consequence');
  });

  await t('a genuine signature from the sender is ADMITTED, and marked authenticated', async () => {
    const n = mkNode(createVerifier({ viem: fakeViem }));
    assert.equal(n.relay.authenticates, true);
    const r = await n.receive(envelopeFrom(PEER, 'signed-by:' + PEER.toLowerCase()));
    assert.equal(r.action, 'deliver');
    assert.equal(r.authenticated, true, 'the store must be able to distinguish proven from claimed');
  });

  await t('THE PROPERTY: a VALID signature by the WRONG key is refused — impersonation', async () => {
    // the impostor signs perfectly well; they just are not who the envelope claims to be
    const n = mkNode(createVerifier({ viem: fakeViem }));
    const r = await n.receive(envelopeFrom(PEER, 'signed-by:' + IMPOSTOR.toLowerCase()));
    assert.equal(r.action, 'drop', 'a correct signature is not enough — it must be `from`\'s signature');
  });

  await t('an envelope with NO signature is refused once a verifier exists', async () => {
    const n = mkNode(createVerifier({ viem: fakeViem }));
    const r = await n.receive(envelopeFrom(PEER, undefined));
    assert.equal(r.action, 'drop');
    assert.match(r.reason, /no signature/i);
  });

  await t('a THROWING verifier fails closed, it does not fall back to trusting `from`', async () => {
    const n = mkNode(async () => { throw new Error('rpc exploded'); });
    const r = await n.receive(envelopeFrom(PEER, 'signed-by:' + PEER.toLowerCase()));
    assert.equal(r.action, 'drop');
    assert.match(r.reason, /FAIL CLOSED/);
  });

  await t('the adapter never throws on malformed input — it returns a quiet false', async () => {
    const v = createVerifier({ viem: fakeViem });
    assert.deepEqual(await v({ payload: null, sig: null, claimed: null }), { ok: false });
    assert.deepEqual(await v({ payload: {}, sig: 'x', claimed: PEER }), { ok: false });
    const boom = createVerifier({ viem: { verifyTypedData: async () => { throw new Error('boom'); } } });
    assert.deepEqual(await boom({ payload: {}, sig: 'x', claimed: PEER }), { ok: false });
  });

  await t('WE DO NOT HAND-ROLL THE CRYPTO — no keccak/secp256k1 implementation lives in lib/', () => {
    // a subtly wrong ecrecover does not crash, it silently accepts forgeries. If someone ever adds one,
    // this test is the argument they have to answer first.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify.js'), 'utf8');
    assert.ok(!/function\s+keccak|secp256k1\s*=|function\s+ecrecover/i.test(src), 'no hand-rolled primitive');
    assert.match(src, /WE DO NOT HAND-ROLL THE CRYPTO/, 'and the reason is written down');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
