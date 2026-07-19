'use strict';
// LAWBOR work verbs — pure, offline, deterministic. State is DERIVED by folding a thread, so these
// tests are just "given these messages in this order, what is the job?".
// Run: node test/work.test.js
const assert = require('node:assert');
const { buildWork, parseWork, foldThread, jobsFrom, graphOf, mayApply } = require('../lib/work');

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
t('work.js still moves no funds and holds no key — settle only RECORDS a verifiable pointer', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'work.js'), 'utf8');
  const code = src.replace(/^[\s\S]*?\*\//, '').replace(/\/\*[\s\S]*?\*\//g, '');   // strip the header + block comments
  assert.ok(!/require\(/.test(code), 'pure — no imports at all');
  // it names USDC and verifies a tx, but never CALLS a transfer/approve/escrow/sign — it moves nothing
  assert.ok(!/\.transfer\(|\.approve\(|escrow|signTransaction|sendTransaction/i.test(code), 'no fund-moving or signing call');
  assert.match(src, /LAWBOR still\s*\n?\s*\*?\s*holds no key, moves no funds/, 'the header states the invariant');
  assert.match(src, /`settled` means paid — never delivered/, 'and states settled != delivered');
});

// ---- dependency graph: jobs that wait on jobs (the agent-org coordination layer) -----------------
console.log('\nLAWBOR work — dependency graph (help_wanted.dependsOn), readiness derived from awards:');

t('a dependent job is BLOCKED (no bids) until its upstream is awarded', () => {
  const msgs = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'build', task: 'build the artifact' })),
    row(REQ, W1, buildWork('help_wanted', { jobId: 'deploy', task: 'deploy it', dependsOn: ['build'] })),
  ];
  let jobs = foldThread(msgs);
  assert.equal(jobs.get('deploy').ready, false, 'deploy blocked while build is un-awarded');
  assert.deepEqual(jobs.get('deploy').blockedBy, ['build']);
  // a worker cannot bid on the blocked job (accept-time gate)
  assert.equal(mayApply(jobs.get('deploy'), 'bid', W2).ok, false, 'bid refused while blocked');
  assert.equal(mayApply(jobs.get('deploy'), 'award', W2).ok, false, 'award refused while blocked');
  assert.equal(jobs.get('build').ready, true, 'the upstream itself has no deps → ready');

  // award the upstream → the dependent becomes ready and now takes bids
  msgs.push(row(W1, REQ, buildWork('bid', { jobId: 'build', price: '10' })));
  msgs.push(row(REQ, W1, buildWork('award', { jobId: 'build', worker: W1, price: '10' })));
  jobs = foldThread(msgs);
  assert.equal(jobs.get('deploy').ready, true, 'deploy ready once build is awarded');
  assert.equal(mayApply(jobs.get('deploy'), 'bid', W2).ok, true, 'bid now allowed');
});

t('the graph rewrites itself: a child job appended at runtime is absorbed by the fold', () => {
  const msgs = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'root', task: 'do the thing' })),
    row(W1, REQ, buildWork('bid', { jobId: 'root', price: '5' })),
    row(REQ, W1, buildWork('award', { jobId: 'root', worker: W1, price: '5' })),
  ];
  // the awarded worker spawns a sub-task that depends on root — no schema change, just another envelope
  msgs.push(row(W1, W2, buildWork('help_wanted', { jobId: 'subtask', task: 'follow-up', dependsOn: ['root'] })));
  const g = graphOf(msgs);
  assert.ok(g.ready.includes('subtask'), 'subtask is ready (root awarded) — dynamic org grew a node');
  assert.deepEqual(g.edges, [{ from: 'subtask', dependsOn: 'root' }]);
  assert.deepEqual(g.roots, ['root'], 'root has no upstream');
});

t('a cancelled upstream leaves the dependent permanently blocked (not ready)', () => {
  const jobs = foldThread([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'a', task: 'A' })),
    row(REQ, W1, buildWork('help_wanted', { jobId: 'b', task: 'B', dependsOn: ['a'] })),
    row(REQ, W1, buildWork('cancel', { jobId: 'a', reason: 'scrapped' })),
  ]);
  assert.equal(jobs.get('a').state, 'cancelled');
  assert.equal(jobs.get('b').ready, false, 'B never becomes ready — its dep will never be awarded');
});

t('a dependency CYCLE leaves every job blocked, no crash/infinite loop', () => {
  const jobs = foldThread([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'x', task: 'X', dependsOn: ['y'] })),
    row(REQ, W1, buildWork('help_wanted', { jobId: 'y', task: 'Y', dependsOn: ['x'] })),
  ]);
  assert.equal(jobs.get('x').ready, false);
  assert.equal(jobs.get('y').ready, false, 'mutual block, terminates');
});

t('buildWork strips a self-dependency and dedupes, and an unknown dep just blocks', () => {
  const body = buildWork('help_wanted', { jobId: 'z', task: 'Z', dependsOn: ['z', 'up', 'up', 'ghost'] });
  const w = parseWork(body);
  assert.deepEqual(w.dependsOn, ['up', 'ghost'], 'self removed, dup collapsed');
  const jobs = foldThread([row(REQ, W1, body)]);
  assert.deepEqual(jobs.get('z').blockedBy, ['up', 'ghost'], 'unknown upstreams block until they exist+award');
});

// ---- settle: bind a job to a REAL, refutable Base USDC transfer (the unforgeable primitive) --------
console.log('\nLAWBOR work — settle (job ↔ verified Base USDC tx), the input to the rating:');
const { settlementsFrom, USDC_BASE } = require('../lib/work');
const TX = '0x' + 'ab'.repeat(32);
const fact = (over) => ({ chainId: 8453, token: USDC_BASE, from: REQ, to: W1, valueMicro: '500000000', confirmations: 12, blockTime: 1700000000, ...over });
// a job awarded to W1 at price, ready to be settled
const awarded = () => [
  row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
  row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '500 USDC' })),
  row(REQ, W1, buildWork('award', { jobId: 'j1', worker: W1, price: '500 USDC' })),
];

t('a settle with a MATCHING chain fact verifies → job becomes settled', () => {
  const m = [...awarded(), row(REQ, W1, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000' }))];
  const facts = new Map([[TX, fact()]]);
  const j = foldThread(m, { txFacts: facts }).get('j1');
  assert.equal(j.state, 'settled');
  assert.equal(j.settlement.from, REQ.toLowerCase());
  assert.equal(j.settlement.to, W1.toLowerCase());
  assert.equal(settlementsFrom(m, { txFacts: facts }).length, 1);
});

t('FAIL-CLOSED: no chain fact ⇒ claim recorded but unverified, state unchanged, NO credit edge', () => {
  const m = [...awarded(), row(REQ, W1, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000' }))];
  const j = foldThread(m).get('j1');            // no txFacts injected
  assert.equal(j.state, 'awarded', 'no fact ⇒ not promoted');
  assert.equal(j.settleClaims[0].verified, false);
  assert.equal(settlementsFrom(m).length, 0, 'an unverified settlement is not a rating edge');
});

t('a fact with the WRONG amount / token / payee does not verify (every field is checked)', () => {
  const m = [...awarded(), row(REQ, W1, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000' }))];
  for (const bad of [{ valueMicro: '499999999' }, { token: '0x' + '00'.repeat(20) }, { to: W2 }, { chainId: 1 }, { confirmations: 3 }]) {
    const j = foldThread(m, { txFacts: new Map([[TX, fact(bad)]]) }).get('j1');
    assert.equal(j.state, 'awarded', 'mismatch on ' + Object.keys(bad)[0] + ' must not verify');
  }
});

t('only the requester or the awarded worker may settle — a third party cannot', () => {
  const facts = new Map([[TX, fact()]]);
  const stranger = [...awarded(), row(W2, REQ, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000' }))];
  assert.equal(foldThread(stranger, { txFacts: facts }).get('j1').state, 'awarded', 'stranger settle ignored');
  const byWorker = [...awarded(), row(W1, REQ, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000' }))];
  assert.equal(foldThread(byWorker, { txFacts: facts }).get('j1').state, 'settled', 'the worker may settle');
});

t('first-write-wins on a txHash: one transfer settles at most one job', () => {
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'a', task: 't' })), row(REQ, W1, buildWork('award', { jobId: 'a', worker: W1, price: '500 USDC' })),
    row(REQ, W1, buildWork('help_wanted', { jobId: 'b', task: 't' })), row(REQ, W1, buildWork('award', { jobId: 'b', worker: W1, price: '500 USDC' })),
    row(REQ, W1, buildWork('settle', { jobId: 'a', txHash: TX, amountMicro: '500000000' })),
    row(REQ, W1, buildWork('settle', { jobId: 'b', txHash: TX, amountMicro: '500000000' })),   // reuse the SAME tx
  ];
  const jobs = foldThread(m, { txFacts: new Map([[TX, fact()]]) });
  const settled = [...jobs.values()].filter((j) => j.state === 'settled');
  assert.equal(settled.length, 1, 'the reused txHash settles exactly one job, not two');
});

t('a SETTLED upstream still satisfies a dependent job (settled ⊇ awarded)', () => {
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'build', task: 'b' })), row(REQ, W1, buildWork('award', { jobId: 'build', worker: W1, price: '500 USDC' })),
    row(REQ, W1, buildWork('settle', { jobId: 'build', txHash: TX, amountMicro: '500000000' })),
    row(REQ, W1, buildWork('help_wanted', { jobId: 'deploy', task: 'd', dependsOn: ['build'] })),
  ];
  const facts = new Map([[TX, fact()]]);
  const dep = foldThread(m, { txFacts: facts }).get('deploy');
  assert.equal(dep.ready, true, 'build is settled, so deploy is ready');
});

t('buildWork rejects a malformed txHash and a non-integer amount', () => {
  assert.throws(() => buildWork('settle', { jobId: 'j1', txHash: '0xnope', amountMicro: '1' }), /32-byte tx hash/);
  assert.throws(() => buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '1.5' }), /amountMicro/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
