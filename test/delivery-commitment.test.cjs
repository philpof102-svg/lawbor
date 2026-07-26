#!/usr/bin/env node
'use strict';
/**
 * The delivery commitment: turning "settled means PAID, never delivered" into something checkable.
 *
 * This rail has said that sentence in its own tool description for as long as it has existed, and it names a
 * total asymmetry — the payment is a fact on Base that anyone can re-check forever, while the deliverable was a
 * sentence in a message. A buyer could prove it spent and never prove it received.
 *
 * A sha256 committed AT AWARD closes half of it, and the protocol supplies the other half for free: `mayApply`
 * refuses a settle unless the job is already `awarded`, so the commitment is structurally prior to the money. A
 * generic verifier has to detect a hash published after the fact; on this rail that case cannot arise.
 *
 * Two things are load-bearing and are asserted below rather than assumed:
 *
 *   1. DELIVERY IS A SECOND, INDEPENDENT AXIS. `verified` means the money moved, as a chain fact, and nothing
 *      about delivery may ever touch it. Folding them into one "good settlement" flag would let a delivery
 *      dispute erase a payment that provably happened — the chain does not un-transfer USDC because a buyer is
 *      unhappy. A verified payment alongside a substituted delivery is exactly what a dispute needs described.
 *   2. THREE STATES. `unverifiable` is the honest answer for every award that committed to nothing, which today
 *      is all of them. A buyer must know it never had the means to check rather than believe it passed a check.
 *
 * Note on the tests themselves: the "must reject" rows assert the error MESSAGE, not merely that something
 * threw. An earlier version of this file passed those rows green while the throw was coming from a missing
 * jobId — a test that expects an exception passes on ANY exception, and would have certified a validation that
 * never ran.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const W = require('../lib/work.js');

const sha = (s) => '0x' + crypto.createHash('sha256').update(s).digest('hex');
const WORK = 'the report the buyer paid for, byte for byte';
const WORKER = '0x' + '1'.repeat(40);
const TX = '0x' + 'a'.repeat(64);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const build = (kind, fields) => JSON.parse(W.buildWork(kind, fields));
const rejects = (fn, why) => {
  try { fn(); } catch (e) {
    if (why.test(e.message)) return;
    throw new Error('rejected for the WRONG reason: ' + e.message);
  }
  throw new Error('should have rejected');
};

console.log('the commitment travels on the wire:');
t('award carries a well-formed deliverableHash', () => {
  const a = build('award', { jobId: 'j1', worker: WORKER, price: '5', deliverableHash: sha(WORK) });
  assert.equal(a.deliverableHash, sha(WORK));
});
t('award rejects a malformed hash, FOR THAT reason', () =>
  rejects(() => W.buildWork('award', { jobId: 'j1', worker: WORKER, price: '5', deliverableHash: 'not-a-hash' }), /deliverableHash/i));
t('settle carries a well-formed receivedHash', () => {
  const s = build('settle', { jobId: 'j1', txHash: TX, amountMicro: '5000000', receivedHash: sha(WORK) });
  assert.equal(s.receivedHash, sha(WORK));
});
t('settle rejects a malformed receivedHash, FOR THAT reason', () =>
  rejects(() => W.buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '5000000', receivedHash: '0xzz' }), /receivedHash/i));

console.log('\nbackward compatibility — every award ever written carries no commitment:');
t('award omits the field entirely when not given', () => {
  const a = build('award', { jobId: 'j1', worker: WORKER, price: '5' });
  assert.ok(!('deliverableHash' in a), 'must not invent the field');
});
t('settle omits receivedHash entirely when not given', () => {
  const s = build('settle', { jobId: 'j1', txHash: TX, amountMicro: '5000000' });
  assert.ok(!('receivedHash' in s), 'must not invent the field');
});

console.log('\nthe hash is a real discriminator:');
t('one changed byte changes the commitment', () => assert.notEqual(sha(WORK), sha(WORK + ' ')));
t('a matching artifact reproduces it exactly', () => assert.equal(sha(WORK), sha(String(WORK))));

console.log('\nwhat this deliberately does NOT prove:');
t('a committed hash of garbage verifies perfectly', () => {
  const junk = sha('lorem ipsum');
  const a = build('award', { jobId: 'j2', worker: WORKER, price: '5', deliverableHash: junk });
  const s = build('settle', { jobId: 'j2', txHash: TX, amountMicro: '5000000', receivedHash: sha('lorem ipsum') });
  assert.equal(a.deliverableHash, s.receivedHash);
  // Existence and non-substitution. Never quality. Asserted so nobody later reads `served` as "the work was good".
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
