'use strict';
// LAWBOR origination — the half of the pair that was never built.
// The relay has verified `from` for weeks, but nothing SIGNED an outbound envelope, so two honest nodes
// could never talk: A sends unsigned, B fail-closes. The whole mesh only worked with allowUnauthenticated
// — a spoofable `from`. These tests pin the seam that closes it, and the refusal that keeps it honest.
// Run: node test/originate.test.js
const assert = require('node:assert');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const { createNode } = require('../lib/node');
const { createStore } = require('../lib/store');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const preflight = async () => ({ decision: 'PROCEED', score: 80 });
// a stand-in operator signer + the matching verifier. Deliberately NOT real crypto: what is under test is
// the SEAM (does an envelope leave signed, and is a failure refused), not secp256k1 — which lib/verify.js
// exists to delegate to viem precisely so nobody hand-rolls it here.
// The stub must be HEX-SHAPED: attachSignature requires /^0x[0-9a-fA-F]+$/, which is the shape of a real
// EIP-712 signature. A first draft returned "signed-by:0xaa…" and was correctly refused — the guard
// caught a malformed signature exactly as intended, so the test was wrong and the code was right.
const signerFor = (addr) => async () => '0x' + addr.slice(2).toLowerCase() + 'f'.repeat(90);
const verifier = async ({ sig, claimed }) => (String(sig) === '0x' + String(claimed).slice(2).toLowerCase() + 'f'.repeat(90)
  ? { ok: true, signer: String(claimed).toLowerCase() } : { ok: false });

let seq = 0;
const mk = (self, extra = {}) => {
  const db = path.join(os.tmpdir(), 'lawbor-orig-' + process.pid + '-' + (++seq));
  for (const e of ['.jsonl', '.control']) { try { fs.unlinkSync(db + e); } catch {} }
  return createNode({ self, human: 'op', preflight, send: async () => {}, peers: [A, B].filter((x) => x !== self),
    store: createStore(db + '.jsonl', db + '.control'), ...extra });
};

(async () => {
  console.log('LAWBOR origination — a node can finally SIGN what it sends:');

  await t('with NO signer an envelope leaves unsigned — honest, and unchanged from before', async () => {
    const n = mk(A);
    assert.equal(n.originatesSigned, false, 'reported, not hidden');
    const r = await n.say(B, 'gm');
    assert.equal(r.envelope.sig, undefined);
    assert.equal(r.delivered, true, 'the old behaviour is untouched for anyone not wiring a signer');
  });

  await t('with a signer the envelope carries a signature BEFORE it is dispatched', async () => {
    const n = mk(A, { sign: signerFor(A) });
    assert.equal(n.originatesSigned, true);
    const r = await n.say(B, 'gm');
    assert.equal(r.envelope.sig, '0x' + A.slice(2).toLowerCase() + 'f'.repeat(90));
    assert.equal(r.delivered, true);
  });

  await t('botSay signs too — an autonomous message is not a second-class citizen', async () => {
    const r = await mk(A, { sign: signerFor(A) }).botSay(B, 'bot here');
    assert.equal(r.envelope.sig, '0x' + A.slice(2).toLowerCase() + 'f'.repeat(90));
  });

  await t('THE PROPERTY: two honest nodes can now talk WITHOUT allowUnauthenticated', async () => {
    // this is the case that was impossible: both sides fail-closed, and the message still arrives.
    const sender = mk(A, { sign: signerFor(A) });
    const receiver = mk(B, { verifySig: verifier });          // no allowUnauthenticated anywhere
    assert.equal(receiver.relay.authenticates, true);
    const { envelope } = await sender.say(B, 'hello from a signed node');
    const got = await receiver.receive(envelope);
    assert.equal(got.action, 'deliver', 'refused: ' + got.reason);
    assert.equal(got.authenticated, true, 'and it is marked PROVEN, not merely claimed');
  });

  await t('an unsigned node is still refused by a fail-closed peer — the gate did not soften', async () => {
    const { envelope } = await mk(A).say(B, 'unsigned');
    const got = await mk(B, { verifySig: verifier }).receive(envelope);
    assert.equal(got.action, 'drop');
  });

  await t('NEVER DOWNGRADE: a throwing signer REFUSES the send, it does not fall back to unsigned', async () => {
    const n = mk(A, { sign: async () => { throw new Error('hardware wallet unplugged'); } });
    const r = await n.say(B, 'important');
    assert.equal(r.delivered, false);
    assert.equal(r.envelope.sig, undefined);
    assert.match(r.reason, /REFUSED rather than sent unsigned/);
    assert.equal(n.store.all().length, 0, 'and nothing was recorded as if it had gone out');
  });

  await t('a signer returning junk is refused just as hard as one that throws', async () => {
    for (const bad of [null, '', 'not-hex', 42, {}]) {
      const r = await mk(A, { sign: async () => bad }).say(B, 'x');
      assert.equal(r.delivered, false, 'accepted junk: ' + JSON.stringify(bad));
      assert.match(r.reason, /no usable signature/);
    }
  });

  await t('THE NODE STILL HOLDS NO KEY — no private-key adapter ships in lib/', () => {
    // sign() is the operator's function. Shipping a "put your key in an env var" helper would hand the
    // key to the node and break the promise printed on every surface this project has.
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'lib'))) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
      assert.ok(!/PRIVATE_KEY|privateKeyToAccount|process\.env\.[A-Z_]*KEY/.test(src), f + ' reads a private key');
    }
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
