'use strict';
/**
 * LAWBOR signed-node launcher — the one invariant that must never regress.
 * ================================================================================================
 * bin/lawbor-signed-node.js runs an originating node and a key-holding signer endpoint as TWO
 * processes on one host, so the NODE process never holds the key. The whole security value collapses if
 * the key ever leaks into the node's environment, and that leak would be silent — the node would still
 * work, it would just also be holding what the design promises it never holds.
 * So this pins exactly that, on the pure env-derivation function, with no processes spawned.
 * Run: node test/signed-node.test.js
 */
const assert = require('node:assert');
const { nodeEnvFrom } = require('../bin/lawbor-signed-node.js');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('\nLAWBOR signed-node — the node process must never see the key\n');

const parent = { LAWBOR_SIGNER_KEY: '0x' + 'ab'.repeat(32), LAWBOR_ADDR: '0xabc', PORT: '4830', SOME_OTHER: 'keep' };
const e = nodeEnvFrom(parent, 'per-boot-secret', 8787);

t('THE INVARIANT: LAWBOR_SIGNER_KEY is stripped from the node environment', () => {
  assert.ok(!('LAWBOR_SIGNER_KEY' in e), 'the key must not reach the node process at all');
});
t('the node is pointed at the loopback signer, with the per-boot token', () => {
  assert.equal(e.LAWBOR_SIGNER, './examples/signer-remote.js');
  assert.equal(e.LAWBOR_SIGNER_URL, 'http://127.0.0.1:8787/sign');
  assert.equal(e.LAWBOR_SIGNER_TOKEN, 'per-boot-secret');
});
t('every other env var is preserved (PORT, oracle, admit policy, …)', () => {
  assert.equal(e.PORT, '4830');
  assert.equal(e.SOME_OTHER, 'keep');
});
t('the parent env is not mutated — deriving a child env must not disarm the parent', () => {
  assert.equal(parent.LAWBOR_SIGNER_KEY, '0x' + 'ab'.repeat(32), 'the launcher still needs the key to give to the ENDPOINT child');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exitCode = fail ? 1 : 0;
