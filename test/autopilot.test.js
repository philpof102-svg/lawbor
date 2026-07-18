'use strict';
// LAWBOR autopilot — the bot that works the job graph on its own. The DECISIONS are pure, so they are
// tested here with no node, no socket and no clock: an unattended agent whose policy you cannot test
// offline is an agent you cannot trust to run unattended.
// Run: node test/autopilot.test.js
const assert = require('node:assert');
const { buildWork, jobsFrom } = require('../lib/work');
const { decideBid, decideAward, plan } = require('../lib/autopilot');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const REQ = '0x' + 'a1'.repeat(20), W1 = '0x' + 'b1'.repeat(20), W2 = '0x' + 'c1'.repeat(20);
let seq = 0;
const row = (from, to, body, rxAt) => ({ id: '0x' + String(++seq).padStart(4, '0'), thread: 't-main', from, to, body, ts: 1, rxAt: rxAt !== undefined ? rxAt : seq * 1000 });
const jobs = (msgs) => jobsFrom(msgs);
const one = (msgs, id = 'j1') => jobs(msgs).find((j) => j.jobId === id);

console.log('LAWBOR autopilot — pure decisions over the folded job graph:');

t('bids on an open job it did not post', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'index a contract' }))];
  const d = decideBid(one(m), W1, jobs(m), { bidPrice: 12 });
  assert.equal(d.bid, true); assert.equal(d.price, '12 USDC');
});

t('never bids on its OWN job (the actor rules, not the policy, refuse it)', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' }))];
  const d = decideBid(one(m), REQ, jobs(m));
  assert.equal(d.bid, false); assert.match(d.reason, /own job/);
});

t('never bids twice on the same job', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
             row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '9 USDC' }))];
  assert.equal(decideBid(one(m), W1, jobs(m)).bid, false);
});

t('never bids on a job BLOCKED by an unmet dependency (the graph gate holds for bots too)', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'build', task: 'b' })),
             row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'deploy', dependsOn: ['build'] }))];
  const d = decideBid(one(m), W1, jobs(m));
  assert.equal(d.bid, false); assert.match(d.reason, /blocked by/);
});

t('respects maxOpenBids — an unattended bot cannot fan out', () => {
  const m = [];
  for (const id of ['j1', 'j2', 'j3', 'j4']) m.push(row(REQ, W1, buildWork('help_wanted', { jobId: id, task: 't' })));
  for (const id of ['j2', 'j3', 'j4']) m.push(row(W1, REQ, buildWork('bid', { jobId: id, price: '5 USDC' })));
  const d = decideBid(one(m), W1, jobs(m), { maxOpenBids: 3 });
  assert.equal(d.bid, false); assert.match(d.reason, /maxOpenBids/);
});

t('skill tags gate what it will touch', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't', tags: ['solidity'] }))];
  assert.equal(decideBid(one(m), W1, jobs(m), { skills: ['indexing'] }).bid, false);
  assert.equal(decideBid(one(m), W1, jobs(m), { skills: ['solidity'] }).bid, true);
});

t('awards the CHEAPEST live bid, and only the requester may', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
             row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '20 USDC' })),
             row(W2, REQ, buildWork('bid', { jobId: 'j1', price: '15 USDC' }))];
  const a = decideAward(one(m), REQ, { minBidsBeforeAward: 2 });
  assert.equal(a.award, true); assert.equal(a.worker, W2.toLowerCase()); assert.equal(a.price, '15 USDC');
  assert.equal(decideAward(one(m), W1, {}).award, false, 'a worker cannot award someone else\'s job');
});

t('waits for minBidsBeforeAward, and refuses a bid above maxPrice', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
             row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '500 USDC' }))];
  assert.match(decideAward(one(m), REQ, { minBidsBeforeAward: 2 }).reason, /waiting for bids/);
  const a = decideAward(one(m), REQ, { minBidsBeforeAward: 1, maxPrice: 100 });
  assert.equal(a.award, false); assert.match(a.reason, /maxPrice/);
});

t('a tie on price breaks on the EARLIEST bid — two nodes folding the same log must agree', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' }), 1000),
             row(W2, REQ, buildWork('bid', { jobId: 'j1', price: '10 USDC' }), 3000),
             row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '10 USDC' }), 2000)];
  const a = decideAward(one(m), REQ, { minBidsBeforeAward: 2 });
  assert.equal(a.worker, W1.toLowerCase(), 'earliest bid wins the tie');
});

t('plan() carries the job THREAD so an autonomous reply continues the fil', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' }))];
  const p = plan(m, W1, { bidPrice: 7 });
  assert.equal(p.length, 1); assert.equal(p[0].kind, 'bid'); assert.equal(p[0].to, REQ.toLowerCase());
  assert.equal(p[0].thread, 't-main', 'without this a bot reply would root a NEW thread');
});

t('plan() is deterministic: the same log yields the same intents', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
             row(REQ, W1, buildWork('help_wanted', { jobId: 'j2', task: 't2' }))];
  assert.equal(JSON.stringify(plan(m, W1)), JSON.stringify(plan(m.slice().reverse(), W1)));
});

t('a cancelled or awarded job draws no further action', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
             row(REQ, W1, buildWork('cancel', { jobId: 'j1', reason: 'scrapped' }))];
  assert.equal(plan(m, W1).length, 0);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
