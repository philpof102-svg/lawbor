'use strict';
/**
 * LAWBOR_SIGNER — the operator's own signing module, and the door it opens.
 * ================================================================================================
 * The relay demands a signature on every inbound envelope. `sign` was injectable only via build({sign}),
 * so anyone running the SHIPPED binary could not sign, and therefore could not join the mesh the package
 * advertises. LAWBOR_SIGNER points at a file the OPERATOR wrote — we never name, read or store a key.
 *
 * What must stay true:
 *   1. a broken/typo'd signer path FAILS AT BOOT. Silently starting unsigned while an operator believes
 *      they configured a signer is the "never downgrade silently" rule, applied at startup;
 *   2. the shipped examples/signer-viem.js actually produces a signature the relay's verifier ACCEPTS —
 *      an example that does not work is worse than no example;
 *   3. a valid signature by the WRONG key is still refused, even coming from our own example.
 * Run: node test/signer.test.js
 */
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-signer-'));
const write = (name, src) => { const p = path.join(tmp, name); fs.writeFileSync(p, src); return p; };

(async () => {
  console.log('\nLAWBOR_SIGNER — the operator signs, the node never holds a key\n');

  const { build } = require('../server');

  await t('a MISSING signer file refuses to start — never a quiet unsigned boot', () => {
    process.env.LAWBOR_SIGNER = path.join(tmp, 'does-not-exist.js');
    assert.throws(() => build({ preflight: async () => ({ decision: 'PROCEED', score: 90 }) }),
      /could not be loaded|refusing to start unsigned/);
    delete process.env.LAWBOR_SIGNER;
  });

  await t('a signer that exports the WRONG SHAPE is refused too, with the contract stated', () => {
    process.env.LAWBOR_SIGNER = write('bad.js', 'module.exports = { nope: 1 };');
    assert.throws(() => build({ preflight: async () => ({ decision: 'PROCEED', score: 90 }) }),
      /must export a function/);
    delete process.env.LAWBOR_SIGNER;
  });

  await t('a well-formed signer is picked up, and the node REPORTS that it originates signed', () => {
    process.env.LAWBOR_SIGNER = write('ok.js', "module.exports = async () => '0x' + 'ab'.repeat(65);");
    const s = build({ preflight: async () => ({ decision: 'PROCEED', score: 90 }) });
    assert.equal(s.node.originatesSigned, true, '/health must say so — an operator has to be able to check');
    delete process.env.LAWBOR_SIGNER;
  });

  await t('THE EXAMPLE WORKS: examples/signer-viem.js signs, and our own verifier accepts it', async () => {
    let accounts; try { accounts = require('viem/accounts'); } catch { console.log('      (viem absent — skipped)'); return; }
    const { createVerifier } = require('../lib/verify');
    const { buildEnvelope, signablePayload } = require('../lib/envelope');

    process.env.MY_TEST_KEY = '0x' + 'c3'.repeat(32);
    delete require.cache[require.resolve('../examples/signer-viem.js')];
    const sign = require('../examples/signer-viem.js');
    const me = accounts.privateKeyToAccount(process.env.MY_TEST_KEY);
    assert.equal(sign.address.toLowerCase(), me.address.toLowerCase(), 'the example must expose the address it speaks as');

    const { envelope } = buildEnvelope({ from: me.address, to: '0x' + 'bb'.repeat(20), body: 'hello', viaHuman: 'alice' });
    const payload = signablePayload(envelope);
    const sig = await sign({ payload, envelope });
    assert.match(sig, /^0x[0-9a-fA-F]+$/, 'a 0x signature, or lib/node.js refuses to send at all');

    const verify = createVerifier();
    assert.equal((await verify({ payload, sig, claimed: me.address })).ok, true, 'our verifier must accept our own example');
    // and the property the whole gate exists for
    assert.equal((await verify({ payload, sig, claimed: '0x' + 'dd'.repeat(20) })).ok, false,
      'a valid signature by the wrong key is still refused — impersonation');
    delete process.env.MY_TEST_KEY;
  });

  await t('the example REFUSES rather than signs what it should not — a signer is a policy point', async () => {
    try { require('viem/accounts'); } catch { console.log('      (viem absent — skipped)'); return; }
    const sign = require('../examples/signer-viem.js');
    await assert.rejects(() => sign({ payload: {}, envelope: { body: 'x'.repeat(5000) } }), /oversized/);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
