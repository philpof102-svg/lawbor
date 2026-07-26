#!/usr/bin/env node
'use strict';
/**
 * The delivery verdict, exercised through the REAL fold — not just the field builder.
 *
 * The first delivery test only checked that `buildWork` accepts and validates the two new fields. The thirty
 * lines that actually decide served / substituted / unverifiable had never run once, and they were already
 * deployed. A validated input travelling to a code path nobody executed is the same shape as every other false
 * all-clear in this project: something green that proves nothing about the part that matters.
 *
 * So these rows drive a whole engagement — help_wanted, bid, award with a commitment, then a settle with a real
 * chain fact injected — and assert on the folded job.
 *
 * The two invariants under test are the ones a dispute depends on:
 *   1. DELIVERY NEVER TOUCHES `verified`. The payment fact is the chain's; a buyer's unhappiness cannot undo
 *      it. A verified payment beside a substituted delivery must be representable, because that IS the dispute.
 *   2. `unverifiable` FOR EVERY AWARD THAT COMMITTED TO NOTHING — which is every award written before today.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const { buildWork, foldThread, settlementsFrom, USDC_BASE } = require('../lib/work.js');

const sha = (s) => '0x' + crypto.createHash('sha256').update(s).digest('hex');
const REQ = '0x' + '1'.repeat(40);
const W1 = '0x' + '2'.repeat(40);
const TX = '0x' + 'ab'.repeat(32);
const WORK = 'the report the buyer paid for, byte for byte';
const OTHER = 'a cheaper thing sent once the funds cleared';

let seq = 0;
const row = (from, to, body) => ({ id: '0x' + String(++seq).padStart(4, '0'), from, to, body, ts: 1, rxAt: seq * 1000 });
const fact = () => ({ chainId: 8453, token: USDC_BASE, from: REQ, to: W1, valueMicro: '500000000', confirmations: 12, blockTime: 1700000000 });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

/** A full engagement: posted, bid, awarded (optionally with a commitment), settled (optionally with a hash). */
function engagement({ commitTo, receivedIs }) {
  seq = 0;
  const award = { jobId: 'j1', worker: W1, price: '500 USDC' };
  if (commitTo !== undefined) award.deliverableHash = sha(commitTo);
  const settle = { jobId: 'j1', txHash: TX, amountMicro: '500000000' };
  if (receivedIs !== undefined) settle.receivedHash = sha(receivedIs);
  const msgs = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'write the report' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '500 USDC' })),
    row(REQ, W1, buildWork('award', award)),
    row(REQ, W1, buildWork('settle', settle)),
  ];
  return { msgs, job: foldThread(msgs, { txFacts: new Map([[TX, fact()]]) }).get('j1') };
}

console.log('the delivery verdict, through the real fold:');

t('SERVED: committed at award, the same bytes arrive', () => {
  const { job } = engagement({ commitTo: WORK, receivedIs: WORK });
  assert.equal(job.state, 'settled');
  assert.equal(job.settlement.delivery, 'served');
  assert.match(job.settlement.deliveryReason, /existed first and was not substituted/i);
});

t('SUBSTITUTED: committed at award, different bytes arrive', () => {
  const { job } = engagement({ commitTo: WORK, receivedIs: OTHER });
  assert.equal(job.settlement.delivery, 'substituted');
  assert.match(job.settlement.deliveryReason, /does NOT hash to the commitment/i);
});

t('UNVERIFIABLE: the award committed to nothing — every award written before today', () => {
  const { job } = engagement({ receivedIs: WORK });
  assert.equal(job.settlement.delivery, 'unverifiable');
  assert.match(job.settlement.deliveryReason, /committed to no deliverable hash/i);
});

t('UNVERIFIABLE: committed, but the settle supplied no receivedHash', () => {
  const { job } = engagement({ commitTo: WORK });
  assert.equal(job.settlement.delivery, 'unverifiable');
  assert.match(job.settlement.deliveryReason, /supplied no receivedHash/i);
});

console.log('\nthe invariant a dispute rests on — delivery never touches the payment fact:');

t('a SUBSTITUTED delivery leaves the payment verified and the job settled', () => {
  const { msgs, job } = engagement({ commitTo: WORK, receivedIs: OTHER });
  assert.equal(job.state, 'settled', 'the money moved; a buyer being unhappy cannot un-move it');
  assert.equal(job.settleClaims[0].verified, true, 'the chain fact still verifies');
  assert.equal(job.settlement.delivery, 'substituted');
  assert.equal(settlementsFrom(msgs, { txFacts: new Map([[TX, fact()]]) }).length, 1,
    'the rating edge still exists — it is built on the payment, not on satisfaction');
});

t('a SERVED delivery does not manufacture a payment that never verified', () => {
  seq = 0;
  const msgs = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '500 USDC' })),
    row(REQ, W1, buildWork('award', { jobId: 'j1', worker: W1, price: '500 USDC', deliverableHash: sha(WORK) })),
    row(REQ, W1, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000', receivedHash: sha(WORK) })),
  ];
  const job = foldThread(msgs).get('j1');           // NO chain fact injected
  assert.equal(job.state, 'awarded', 'no fact ⇒ never promoted, whatever the delivery says');
  assert.equal(job.settleClaims[0].verified, false);
  assert.equal(job.settleClaims[0].delivery, 'served', 'delivery is judged on its own axis, and says so');
});

console.log('\nbackward compatibility, through the fold:');

t('an engagement with neither field folds exactly as before, plus an honest unverifiable', () => {
  const { job } = engagement({});
  assert.equal(job.state, 'settled');
  assert.equal(job.settlement.delivery, 'unverifiable');
  assert.equal(job.award.deliverableHash, null, 'awards without a commitment carry null, not undefined');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
