'use strict';
/**
 * LAWBOR reference signer ENDPOINT — the server half that holds the key so the node never does.
 * ================================================================================================
 * examples/signer-endpoint.js is the reference LAWBOR_SIGNER_URL target: the node POSTs {payload,
 * envelope}, this holds the key and returns {signature}. It is the piece that lets a public node
 * originate (posture A) with a THROWAWAY identity while the node process itself holds nothing.
 *
 * The properties under test are the ones that make it safe to run key-in-process:
 *   1. it signs a valid LAWBOR message and our own verifier accepts it;
 *   2. it is a POLICY POINT — a non-LAWBOR payload is REFUSED (422), never signed;
 *   3. a bearer token, when set, actually gates access;
 *   4. it refuses to START with a key that does not match LAWBOR_SIGNER_ADDR — the guard against being
 *      pointed at the wrong key.
 * Run: node test/signer-endpoint.test.js
 */
const assert = require('node:assert');
const http = require('node:http');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

// POST helper (no dependency on our own body reader)
const post = (port, body, headers = {}) => new Promise((resolve) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: '/sign', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j; try { j = JSON.parse(b); } catch { j = null; } resolve({ status: res.statusCode, body: j }); });
  });
  req.end(data);
});

(async () => {
  console.log('\nLAWBOR reference signer endpoint — hold the key here, never in the node\n');

  let accounts; try { accounts = require('viem/accounts'); } catch { console.log('  (viem absent — skipped)\n'); return; }
  const { buildEnvelope, signablePayload } = require('../lib/envelope');
  const { createVerifier } = require('../lib/verify');

  const KEY = '0x' + 'ab'.repeat(32);                          // a THROWAWAY test key, never a real one
  const acct = accounts.privateKeyToAccount(KEY);
  const load = (env) => { for (const k of Object.keys(env)) process.env[k] = env[k]; delete require.cache[require.resolve('../examples/signer-endpoint.js')]; return require('../examples/signer-endpoint.js'); };
  const clearEnv = () => { for (const k of ['LAWBOR_SIGNER_KEY', 'LAWBOR_SIGNER_PORT', 'LAWBOR_SIGNER_TOKEN', 'LAWBOR_SIGNER_ADDR']) delete process.env[k]; };

  await t('signs a valid LAWBOR message; our own verifier accepts it', async () => {
    clearEnv();
    const { server, address } = load({ LAWBOR_SIGNER_KEY: KEY, LAWBOR_SIGNER_PORT: '0' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    assert.equal(address.toLowerCase(), acct.address.toLowerCase());

    const { envelope } = buildEnvelope({ from: acct.address, to: '0x' + 'bb'.repeat(20), body: 'hi', viaHuman: 'op' });
    const payload = signablePayload(envelope);
    const r = await post(port, { payload, envelope });
    assert.equal(r.status, 200);
    assert.equal((await createVerifier()({ payload, sig: r.body.signature, claimed: acct.address })).ok, true, 'a real signature the mesh will accept');
    server.close();
  });

  await t('POLICY POINT: a non-LAWBOR payload is REFUSED (422), never signed', async () => {
    clearEnv();
    const { server } = load({ LAWBOR_SIGNER_KEY: KEY, LAWBOR_SIGNER_PORT: '0' });
    await new Promise((r) => server.listen(0, r));
    const r = await post(server.address().port, { payload: { domain: { name: 'SOMETHING-ELSE' }, types: {}, primaryType: 'X', message: {} } });
    assert.equal(r.status, 422, 'signing is the last gate — an unrecognised message is refused before the key is touched');
    server.close();
  });

  await t('a bearer token, when set, gates access', async () => {
    clearEnv();
    const { server } = load({ LAWBOR_SIGNER_KEY: KEY, LAWBOR_SIGNER_PORT: '0', LAWBOR_SIGNER_TOKEN: 's3cret' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    assert.equal((await post(port, { payload: {} })).status, 401, 'no token → refused');
    assert.equal((await post(port, { payload: {} }, { authorization: 'Bearer s3cret' })).status, 422, 'right token → reaches the policy gate (and is refused there for the empty payload)');
    server.close();
  });

  await t('refuses to START with a key that does not match LAWBOR_SIGNER_ADDR', () => {
    clearEnv();
    assert.throws(() => load({ LAWBOR_SIGNER_KEY: KEY, LAWBOR_SIGNER_ADDR: '0x' + 'cc'.repeat(20) }),
      /refusing to start with the wrong key/);
  });

  await t('refuses to START without a key — never a silent unsigned endpoint', () => {
    clearEnv();
    assert.throws(() => load({ LAWBOR_SIGNER_PORT: '0' }), /LAWBOR_SIGNER_KEY/);
  });

  clearEnv();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exitCode = fail ? 1 : 0;
})();
