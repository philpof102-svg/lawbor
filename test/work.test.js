'use strict';
// LAWBOR work verbs — pure, offline, deterministic. State is DERIVED by folding a thread, so these
// tests are just "given these messages in this order, what is the job?".
// Run: node test/work.test.js
const assert = require('node:assert');
const { buildWork, parseWork, foldThread, jobsFrom, mayApply } = require('../lib/work');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const REQ = '0x' + 'a1'.repeat(20), W1 = '0x' + 'b1'.repeat(20), W2 = '0x' + 'c1'.repeat(20);
let seq = 0;
// a store row: rxAt is OUR clock (ts is sender-chosen and deliberately not trusted for ordering)
const row = (from, to, body, rxAt) => ({ id: '0x' + String(++seq).padStart(4, '0'), from, to, body, ts: 1, rxAt: rxAt !== undefined ? rxAt : seq * 1000 });
const job = (msgs, id = 'j1') => foldThread(msgs).get(id);

console.log('LAWBOR work — help_wanted · bid · award · cancel, folded from the message log:');

t('a job opens, two workers bid, the requester awards one', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'index a contract', tags: ['base', 'index'] })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '20 USDC', eta: '2h' })),
    row(W2, REQ, buildWork('bid', { jobId: 'j1', price: '15 USDC' })),
    row(REQ, W2, buildWork('award', { jobId: 'j1', worker: W2, price: '15 USDC' })),
  ]);
  assert.equal(j.state, 'awarded');
  assert.equal(j.bids.length, 2);
  assert.equal(j.award.worker, W2.toLowerCase());
  assert.equal(j.award.corroborated, true, 'we saw the winning bid');
});

t('only the REQUESTER may award — a worker awarding themselves is ignored', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '9' })),
    row(W1, REQ, buildWork('award', { jobId: 'j1', worker: W1, price: '9' })),   // ← not the requester
  ]);
  assert.equal(j.state, 'open');
  assert.equal(j.award, null);
});

t('a requester cannot bid on their own job', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' })),
    row(REQ, W1, buildWork('bid', { jobId: 'j1', price: '1' })),
  ]);
  assert.equal(j.bids.length, 0);
  assert.equal(mayApply(j, 'bid', REQ).ok, false);
});

t('one LIVE bid per worker — a rebid replaces, it never accumulates', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '30' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '25' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '22' })),
  ]);
  assert.equal(j.bids.length, 1);
  assert.equal(j.bids[0].price, '22', 'the latest RECEIVED bid stands');
});

t('an award arriving BEFORE the bid it names still closes the job (gossip has no ordering)', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' }), 1000),
    row(REQ, W1, buildWork('award', { jobId: 'j1', worker: W1, price: '12' }), 5000),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '12' }), 9000),          // arrives late
  ]);
  assert.equal(j.state, 'awarded', 'the award is self-contained, so it does not need the bid');
  assert.equal(j.award.corroborated, false, 'but it is honestly flagged as uncorroborated');
});

t('bids after an award are ignored, and a second award cannot overwrite the first', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '10' })),
    row(REQ, W1, buildWork('award', { jobId: 'j1', worker: W1, price: '10' })),
    row(W2, REQ, buildWork('bid', { jobId: 'j1', price: '1' })),
    row(REQ, W2, buildWork('award', { jobId: 'j1', worker: W2, price: '1' })),
  ]);
  assert.equal(j.bids.length, 1);
  assert.equal(j.award.worker, W1.toLowerCase(), 'the first award stands');
});

t('cancel is the requester\'s own escape hatch, and only theirs', () => {
  const base = [row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' }))];
  assert.equal(job([...base, row(W1, REQ, buildWork('cancel', { jobId: 'j1' }))]).state, 'open');
  assert.equal(job([...base, row(REQ, W1, buildWork('cancel', { jobId: 'j1', reason: 'no longer needed' }))]).state, 'cancelled');
});

t('mayApply: the requester may RE-SEND their own help_wanted (broadcast to more workers)', () => {
  // regression (found by the interaction sim): posting the same job to a 2nd worker was refused
  // "jobId already taken", silently breaking broadcast. The requester's re-send is allowed; a
  // DIFFERENT address claiming the jobId is still a hijack.
  const j = job([row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' }))]);
  assert.equal(mayApply(j, 'help_wanted', REQ).ok, true, 'the requester broadcasts their own job to another worker');
  assert.equal(mayApply(j, 'help_wanted', W2).ok, false, 'a different address claiming the jobId is refused');
});

t('a jobId cannot be hijacked by re-announcing it under another address', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'the real job' })),
    row(W2, REQ, buildWork('help_wanted', { jobId: 'j1', task: 'MY job now' })),
  ]);
  assert.equal(j.requester, REQ.toLowerCase());
  assert.equal(j.task, 'the real job');
});

t('folding is ORDER-INDEPENDENT: two nodes seeing the same messages agree', () => {
  const msgs = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '10' })),
    row(W2, REQ, buildWork('bid', { jobId: 'j1', price: '8' })),
    row(REQ, W2, buildWork('award', { jobId: 'j1', worker: W2, price: '8' })),
  ];
  const a = JSON.stringify(job(msgs));
  const b = JSON.stringify(job([...msgs].reverse()));
  const c = JSON.stringify(job([msgs[2], msgs[0], msgs[3], msgs[1]]));
  assert.equal(a, b); assert.equal(a, c);
});

t('ordering uses rxAt (our clock), so a sender-chosen ts cannot reorder a job', () => {
  const early = row(W1, REQ, buildWork('bid', { jobId: 'j1', price: 'FIRST' }), 1000);
  const late = row(W1, REQ, buildWork('bid', { jobId: 'j1', price: 'SECOND' }), 2000);
  early.ts = 99999999;                       // the attacker back/forward-dates their envelope
  const j = job([row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 'x' }), 500), early, late]);
  assert.equal(j.bids[0].price, 'SECOND', 'the later-RECEIVED bid wins, whatever ts claims');
});

t('a bid for a job we have never seen is ignored, not invented', () => {
  assert.equal(foldThread([row(W1, REQ, buildWork('bid', { jobId: 'ghost', price: '1' }))]).size, 0);
});

t('ordinary chat is not a work message, and malformed payloads are ignored', () => {
  assert.equal(parseWork('gm bob'), null);
  assert.equal(parseWork('{"not":"ours"}'), null);
  assert.equal(parseWork('{"lawbor.work":1,"kind":"deliver","jobId":"j1"}'), null, 'kinds we deliberately did not build stay unparsed');
  assert.equal(parseWork(JSON.stringify({ 'lawbor.work': 2, kind: 'bid', jobId: 'j1' })), null, 'a future version is not guessed at');
  assert.equal(foldThread([row(REQ, W1, 'just a normal message')]).size, 0);
});

t('buildWork refuses nonsense instead of emitting a broken job', () => {
  assert.throws(() => buildWork('help_wanted', { task: 'no id' }), /jobId/);
  assert.throws(() => buildWork('help_wanted', { jobId: 'j1' }), /task/);
  assert.throws(() => buildWork('bid', { jobId: 'j1' }), /price/);
  assert.throws(() => buildWork('award', { jobId: 'j1', price: '1' }), /worker/);
  assert.throws(() => buildWork('award', { jobId: 'j1', worker: W1 }), /price/);
  assert.throws(() => buildWork('deliver', { jobId: 'j1' }), /unknown work kind/);
});

t('the award RESTATES the price — the requester signs a number, not just a pointer', () => {
  const b = JSON.parse(buildWork('award', { jobId: 'j1', worker: W1, price: '15 USDC', settlementRef: 'x402:abc' }));
  assert.equal(b.price, '15 USDC');
  assert.equal(b.worker, W1.toLowerCase());
  assert.equal(b.settlementRef, 'x402:abc', 'carried verbatim and never interpreted');
});

t('jobsFrom returns newest-first across many jobs', () => {
  const list = jobsFrom([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'old', task: 'a' }), 1000),
    row(REQ, W1, buildWork('help_wanted', { jobId: 'new', task: 'b' }), 9000),
  ]);
  assert.deepEqual(list.map((j) => j.jobId), ['new', 'old']);
});

// --- the honesty guard ------------------------------------------------------------------------
t('no settlement anywhere: work.js never touches funds, and says so', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'work.js'), 'utf8');
  assert.ok(!/require\(/.test(src.replace(/^[\s\S]*?\*\//, '')), 'pure — no imports at all');
  assert.ok(!/transfer|approve|escrow|signTransaction|sendTransaction/i.test(src.split('module.exports')[0].replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.match(src, /It is not a labour market, because no exchange occurs/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
