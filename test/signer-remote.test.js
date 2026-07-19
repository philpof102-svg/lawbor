'use strict';
/**
 * LAWBOR remote signer — the node originates signed envelopes WITHOUT ever holding the key.
 * ================================================================================================
 * This is what lets the public node become `originatesSigned:true` while keeping the one promise the
 * project makes everywhere: the node holds no key. The key lives behind an HTTP endpoint (a KMS, a
 * hardware wallet, a human-approval queue) that the operator controls; the node sends the EIP-712
 * payload and gets back a signature.
 *
 * The properties under test are the ones that make it safe to trust:
 *   1. a signature obtained over HTTP verifies with OUR OWN verifier, and a wrong-key claim is refused;
 *   2. an unreachable endpoint REFUSES rather than sends unsigned (fail-closed across the boundary);
 *   3. a non-2xx is the endpoint's way to refuse a specific envelope, and it is honoured;
 *   4. a garbage / non-hex response never becomes a signature.
 * Run: node test/signer-remote.test.js
 */
const assert = require('node:assert');
const http = require('node:http');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const load = () => { delete require.cache[require.resolve('../examples/signer-remote.js')]; return require('../examples/signer-remote.js'); };
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, () => r({ s, url: 'http://127.0.0.1:' + s.address().port + '/sign' })); });

(async () => {
  console.log('\nLAWBOR remote signer — sign across a boundary, hold no key\n');

  let accounts; try { accounts = require('viem/accounts'); } catch { console.log('  (viem absent — skipped)\n'); return; }
  const { buildEnvelope, signablePayload } = require('../lib/envelope');
  const { createVerifier } = require('../lib/verify');
  const acct = accounts.privateKeyToAccount('0x' + 'c1'.repeat(32));   // stands in for the key inside a KMS

  await t('a signature fetched over HTTP verifies with our own verifier; a wrong-key claim is refused', async () => {
    const { s, url } = await listen((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
        const { payload } = JSON.parse(b);
        const signature = await acct.signTypedData({ domain: payload.domain, types: payload.types, primaryType: payload.primaryType, message: payload.message });
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ signature }));
      });
    });
    process.env.LAWBOR_SIGNER_URL = url;
    const sign = load();
    const { envelope } = buildEnvelope({ from: acct.address, to: '0x' + 'bb'.repeat(20), body: 'remote', viaHuman: 'op' });
    const payload = signablePayload(envelope);
    const sig = await sign({ payload, envelope });
    const verify = createVerifier();
    assert.equal((await verify({ payload, sig, claimed: acct.address })).ok, true, 'our verifier accepts a remotely-produced signature');
    assert.equal((await verify({ payload, sig, claimed: '0x' + 'dd'.repeat(20) })).ok, false, 'impersonation still refused');
    s.close();
  });

  await t('an UNREACHABLE endpoint refuses — never an unsigned send (fail-closed across the boundary)', async () => {
    process.env.LAWBOR_SIGNER_URL = 'http://127.0.0.1:1/dead';
    const sign = load();
    await assert.rejects(() => sign({ payload: {}, envelope: {} }), /unreachable|refused/);
  });

  await t('a non-2xx is the endpoint refusing THIS envelope, and it is honoured', async () => {
    const { s, url } = await listen((req, res) => { res.writeHead(403); res.end('policy: no'); });
    process.env.LAWBOR_SIGNER_URL = url;
    const sign = load();
    await assert.rejects(() => sign({ payload: {}, envelope: {} }), /refused this envelope/);
    s.close();
  });

  await t('a non-hex / missing signature never becomes a signature', async () => {
    const { s, url } = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ signature: 'not-a-sig' })); });
    process.env.LAWBOR_SIGNER_URL = url;
    const sign = load();
    await assert.rejects(() => sign({ payload: {}, envelope: {} }), /no usable 0x signature/);
    s.close();
  });

  await t('missing LAWBOR_SIGNER_URL fails LOUD at load — never a quiet unsigned boot', () => {
    const saved = process.env.LAWBOR_SIGNER_URL;
    delete process.env.LAWBOR_SIGNER_URL;
    assert.throws(() => load(), /LAWBOR_SIGNER_URL/);
    process.env.LAWBOR_SIGNER_URL = saved;
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  // let any in-flight server close cleanly before exit — process.exit while a socket is mid-close trips
  // a libuv assertion on Windows. Set the code and let the loop drain.
  process.exitCode = fail ? 1 : 0;
})();
