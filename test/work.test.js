'use strict';
// LAWBOR work verbs — pure, offline, deterministic. State is DERIVED by folding a thread, so these
// tests are just "given these messages in this order, what is the job?".
// Run: node test/work.test.js
const assert = require('node:assert');
const { buildWork, parseWork, foldThread, jobsFrom, graphOf, mayApply, unsentDepsTo } = require('../lib/work');

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

t('REGRESSION: an award sharing a millisecond with its help_wanted is not dropped', () => {
  // Found by the live multi-node rating sim, invisible to every test that sets rxAt by hand. rxAt is a
  // millisecond, so two relayed messages can share one; the id tie-break then decides the order, and a
  // single-pass fold silently discarded a mutation that landed before its job was created.
  const hw = { id: '0xffff', thread: 't', from: REQ, to: W1, ts: 1, rxAt: 5000, body: buildWork('help_wanted', { jobId: 'j1', task: 't' }) };
  const aw = { id: '0x0001', thread: 't', from: REQ, to: W1, ts: 1, rxAt: 5000, body: buildWork('award', { jobId: 'j1', worker: W1, price: '5 USDC' }) };
  const j = foldThread([hw, aw]).get('j1');   // aw sorts FIRST on the id tie-break
  assert.equal(j.state, 'awarded', 'the award must survive arriving in the same millisecond as the job');
  assert.equal(j.award.worker, W1.toLowerCase());
});

t('a mutation for a job that appears NOWHERE is still ignored — two passes invent nothing', () => {
  const orphan = { id: '0x1', thread: 't', from: REQ, to: W1, ts: 1, rxAt: 1000, body: buildWork('award', { jobId: 'ghost', worker: W1, price: '5 USDC' }) };
  assert.equal(foldThread([orphan]).size, 0);
});

// ---- settle: bind a job to a REAL, refutable Base USDC transfer (the unforgeable primitive) --------
console.log('\nLAWBOR work — settle (job ↔ verified Base USDC tx), the input to the rating:');
const { settlementsFrom, provenFrom, USDC_BASE } = require('../lib/work');
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

t('a SELF-transfer never settles a job: requester==worker + real from==to tx stays awarded (no wash → PAID)', () => {
  // A bug-bounty hunt found settle lacked the from!==to guard that validate/offer have, so a
  // requester who awarded THEMSELVES and cited a real self-transfer flipped the job to "PAID".
  const self = [
    row(REQ, REQ, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(REQ, REQ, buildWork('award', { jobId: 'j1', worker: REQ, price: '500 USDC' })),
    row(REQ, REQ, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000' })),
  ];
  const selfFact = new Map([[TX, fact({ from: REQ, to: REQ })]]);
  const j = foldThread(self, { txFacts: selfFact }).get('j1');
  assert.notEqual(j.state, 'settled', 'a self-transfer must not settle the job');
  assert.equal(settlementsFrom(self, { txFacts: selfFact }).length, 0, 'and it confers no rating edge');
});

t('GRIEF-PROOF: an unverified claim citing a real tx first does NOT block the genuine settle', () => {
  // seenTx used to be burned BEFORE verification, so an attacker front-running a real payment's
  // txHash on a job whose parties do NOT match could poison it — the genuine settle then hit
  // seenTx.has and the job never flipped. Now only a VERIFIED, first-use tx burns the hash.
  const grief = [
    // attacker's own job b: they cite the victim's real TX, but b's payee is W2 (mismatch ⇒ unverified)
    row(W2, REQ, buildWork('help_wanted', { jobId: 'b', task: 't' })),
    row(W2, REQ, buildWork('award', { jobId: 'b', worker: W2, price: '500 USDC' })),
    row(W2, REQ, buildWork('settle', { jobId: 'b', txHash: TX, amountMicro: '500000000' })),  // rxAt earlier
    // the genuine job a: REQ→W1, the TX actually matches
    ...awarded(),
    row(REQ, W1, buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '500000000' })),
  ];
  const jobs = foldThread(grief, { txFacts: new Map([[TX, fact()]]) });  // fact is REQ→W1
  assert.notEqual(jobs.get('b').state, 'settled', "attacker's mismatched job never verifies");
  assert.equal(jobs.get('j1').state, 'settled', 'the genuine settle is NOT denied by the earlier bad claim');
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

t('a CODE BOUNTY carries its two pointers: ref on the job, deliverable on the settle — both opaque', () => {
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'fix-1', task: 'fix the fold bug', ref: 'https://github.com/x/y/issues/7' })),
    row(REQ, W1, buildWork('award', { jobId: 'fix-1', worker: W1, price: '500 USDC' })),
    row(REQ, W1, buildWork('settle', { jobId: 'fix-1', txHash: TX, amountMicro: '500000000', deliverable: 'https://github.com/x/y/pull/8' })),
  ];
  const j = foldThread(m, { txFacts: new Map([[TX, fact()]]) }).get('fix-1');
  assert.equal(j.ref, 'https://github.com/x/y/issues/7', 'the job points at the code');
  assert.equal(j.settlement.deliverable, 'https://github.com/x/y/pull/8', 'the settlement points at the PR paid for');
  // and the pointer is NOT what verified it — remove the chain fact and the deliverable claim remains unverified
  const cold = foldThread(m).get('fix-1');
  assert.equal(cold.state, 'awarded', 'a deliverable link alone settles NOTHING — only the on-chain fact does');
});

// ---- validate: the on-chain penny-drop (prove the rail before the money crosses it) ---------------
console.log('\nLAWBOR work — validate (the bank micro-deposit, on-chain):');
const VTX = '0x' + 'cd'.repeat(32);
const vfact = (over) => ({ chainId: 8453, token: USDC_BASE, from: REQ, to: W1, valueMicro: '0', confirmations: 12, blockTime: 1700000000, ...over });

t('BUG FIX: a ZERO-value transfer can no longer settle a job (it would have shown PAID for nothing)', () => {
  assert.throws(() => buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '0' }), /non-zero amount/);
});

t('a zero-value transfer between the two parties validates the PATH', () => {
  const m = [...awarded(), row(REQ, W1, buildWork('validate', { jobId: 'j1', txHash: VTX }))];
  const j = foldThread(m, { txFacts: new Map([[VTX, vfact()]]) }).get('j1');
  assert.equal(j.pathValidated, true, 'a real 0 USDC transfer really crossed between them');
  assert.equal(j.validations[0].amountMicro, '0', 'zero is the normal amount here');
  assert.equal(j.state, 'awarded', 'and it is NOT a payment — the state must not move');
});

t('DIRECTION IS THE PROOF: requester→worker does NOT prove the worker holds the key', () => {
  const m = [...awarded(), row(REQ, W1, buildWork('validate', { jobId: 'j1', txHash: VTX }))];
  const j = foldThread(m, { txFacts: new Map([[VTX, vfact({ from: REQ, to: W1 })]]) }).get('j1');
  assert.equal(j.pathValidated, true);
  assert.equal(j.payeeProved, false, 'sending TO an address proves nothing about who controls it');
});

t('a tx signed BY the worker proves the payee controls that address — the payer\'s real question', () => {
  const m = [...awarded(), row(W1, REQ, buildWork('validate', { jobId: 'j1', txHash: VTX }))];
  const j = foldThread(m, { txFacts: new Map([[VTX, vfact({ from: W1, to: REQ })]]) }).get('j1');
  assert.equal(j.payeeProved, true, 'only the payee signing proves the payee holds the key');
});

t('a validation with a THIRD party, wrong chain or wrong token does not validate', () => {
  const m = [...awarded(), row(REQ, W1, buildWork('validate', { jobId: 'j1', txHash: VTX }))];
  for (const bad of [{ to: W2 }, { chainId: 1 }, { token: '0x' + '00'.repeat(20) }, { confirmations: 2 }]) {
    const j = foldThread(m, { txFacts: new Map([[VTX, vfact(bad)]]) }).get('j1');
    assert.equal(j.pathValidated, false, 'must not validate on ' + Object.keys(bad)[0]);
  }
});

t('a validation NEVER becomes standing — it costs only gas, so it must buy no reputation', () => {
  const m = [...awarded(), row(W1, REQ, buildWork('validate', { jobId: 'j1', txHash: VTX }))];
  const facts = new Map([[VTX, vfact({ from: W1, to: REQ })]]);
  assert.equal(settlementsFrom(m, { txFacts: facts }).length, 0, 'no credit edge from a handshake');
});

t('ANYONE may cite a validation — and citing it proves nothing the chain does not already say', () => {
  // Deliberately unrestricted: a validate is a pointer to public chain data, so gating who may show it
  // buys no security, and gating it broke the case that matters (a candidate proving their key BEFORE
  // the award, when they are not yet a "party"). What a stranger CANNOT do is change what it proves.
  const m = [...awarded(), row(W2, REQ, buildWork('validate', { jobId: 'j1', txHash: VTX }))];
  const cited = foldThread(m, { txFacts: new Map([[VTX, vfact({ from: REQ, to: W1 })]]) }).get('j1');
  assert.equal(cited.validations.length, 1, 'a third party may cite it');
  assert.equal(cited.pathValidated, true, 'because the chain says that transfer really happened');
  assert.equal(cited.payeeProved, false, 'but it was signed by the requester, so it proves nothing about the payee');
  // and a stranger citing a tx the chain does not back proves nothing at all
  const bogus = foldThread(m, {}).get('j1');
  assert.equal(bogus.validations[0].verified, false);
  assert.equal(bogus.pathValidated, false);
});

// ---- the key-proof guard: refuse to COMMIT to an address nobody has proven they control ----------
console.log('\nLAWBOR work — key-proof guard on AWARD (the last moment a rule can prevent the loss):');

t('REGRESSION: a validate arriving BEFORE the award still sets payeeProved (order-independent)', () => {
  // The useful case IS this order — prove the key, THEN commit. Deciding it inline during the fold made
  // it depend on arrival order, so a pre-award proof was silently lost. Now overlaid in a second pass.
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'ord', task: 't' }), 1000),
    row(W1, REQ, buildWork('validate', { jobId: 'ord', txHash: VTX }), 2000),      // proof FIRST
    row(REQ, W1, buildWork('award', { jobId: 'ord', worker: W1, price: '5 USDC' }), 3000),
  ];
  const facts = new Map([[VTX, vfact({ from: W1, to: REQ })]]);
  assert.equal(foldThread(m, { txFacts: facts }).get('ord').payeeProved, true);
  // and the same messages in any order fold to the same answer
  assert.equal(foldThread([...m].reverse(), { txFacts: facts }).get('ord').payeeProved, true);
});

t('key proof is GLOBAL: a tx unrelated to this job still proves its signer holds the key', () => {
  // proving a key must work BEFORE an award, when the job has no worker yet — so it cannot depend on
  // the tx being "between the job parties". Whoever shows you the tx, the signer really signed it.
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'g', task: 't' })),
             row(REQ, W1, buildWork('validate', { jobId: 'g', txHash: VTX }))];
  const facts = new Map([[VTX, vfact({ from: W2, to: REQ })]]);   // W2 is not a party to this job
  const j = foldThread(m, { txFacts: facts }).get('g');
  assert.equal(j.pathValidated, false, 'not this job rail');
  assert.ok(provenFrom(m, { txFacts: facts }).has(W2.toLowerCase()), 'but W2 is proven to hold its key');
});

t('provenFrom derives key control at the ADDRESS level, from the tx SIGNER only', () => {
  const m = [...awarded(), row(W1, REQ, buildWork('validate', { jobId: 'j1', txHash: VTX }))];
  const proven = provenFrom(m, { txFacts: new Map([[VTX, vfact({ from: W1, to: REQ })]]) });
  assert.ok(proven.has(W1.toLowerCase()), 'W1 signed it — W1 is proven');
  assert.ok(!proven.has(REQ.toLowerCase()), 'REQ only RECEIVED it — receiving proves nothing');
});

t('above the threshold, an unproven worker cannot be awarded — and the reason says what to ask for', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'big', task: 't' }))];
  const job = foldThread(m).get('big');
  const r = mayApply(job, 'award', REQ, { requireProofAbove: 100, proven: new Set(), worker: W1, price: '500 USDC' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /never proven they hold their key/);
  assert.match(r.reason, /validate/, 'it must tell them the way out');
});

t('BELOW the threshold it goes through — the guard is a ceiling, not a wall', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'small', task: 't' }))];
  const job = foldThread(m).get('small');
  assert.equal(mayApply(job, 'award', REQ, { requireProofAbove: 100, proven: new Set(), worker: W1, price: '5 USDC' }).ok, true);
});

t('a PROVEN worker is awarded any amount', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'big2', task: 't' }))];
  const job = foldThread(m).get('big2');
  const proven = new Set([W1.toLowerCase()]);
  assert.equal(mayApply(job, 'award', REQ, { requireProofAbove: 100, proven, worker: W1, price: '99999 USDC' }).ok, true);
});

t('an UNREADABLE price fails CLOSED — we do not wave through what we cannot measure', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'weird', task: 't' }))];
  const job = foldThread(m).get('weird');
  const r = mayApply(job, 'award', REQ, { requireProofAbove: 100, proven: new Set(), worker: W1, price: 'to be agreed' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot read the price/);
});

t('OFF by default: with no threshold set, nothing changes for anyone', () => {
  const m = [row(REQ, W1, buildWork('help_wanted', { jobId: 'plain', task: 't' }))];
  const job = foldThread(m).get('plain');
  assert.equal(mayApply(job, 'award', REQ, { worker: W1, price: '9999 USDC' }).ok, true);
  assert.equal(mayApply(job, 'award', REQ).ok, true, 'and the old 3-arg call still works');
});

t('buildWork rejects a malformed txHash and a non-integer amount', () => {
  assert.throws(() => buildWork('settle', { jobId: 'j1', txHash: '0xnope', amountMicro: '1' }), /32-byte tx hash/);
  assert.throws(() => buildWork('settle', { jobId: 'j1', txHash: TX, amountMicro: '1.5' }), /amountMicro/);
});

/* THE GRAPH GATE MUST NOT FIRE ON A NODE THAT CANNOT KNOW.
 * help_wanted is delivered point-to-point, so a downstream worker receives `verify` and never `build`.
 * Their fold therefore reports `build` as blocking — not because it IS, but because they have never
 * seen it. The gate used to refuse their bid on that basis, while the requester's node (which holds the
 * whole graph) showed the same job ready and waiting for exactly that bid. Two nodes, two frontiers,
 * and no supported route to reconcile them: found by an independent tester running the live path.
 * These three cases pin the distinction between knowledge and its absence. */
{
  const RA = '0x' + 'a1'.repeat(20), RB = '0x' + 'b2'.repeat(20), RC = '0x' + 'c3'.repeat(20);
  const hw = (id, deps) => buildWork('help_wanted', { jobId: id, task: id, ...(deps ? { dependsOn: deps } : {}) });
  const fold = (msgs, id) => foldThread(msgs).get(id);

  t('graph gate: a KNOWN unawarded upstream still refuses the bid — the gate itself is intact', () => {
    const j = fold([
      { id: '1', from: RA, to: RB, rxAt: 10, body: hw('build') },
      { id: '2', from: RA, to: RC, rxAt: 20, body: hw('verify', ['build']) },
    ], 'verify');
    assert.deepEqual(j.blockedByUnknown, [], 'this node HAS build, so nothing is unknown');
    const may = mayApply(j, 'bid', RC);
    assert.equal(may.ok, false);
    assert.match(may.reason, /blocked by unfinished dependencies: build/);
  });

  t('graph gate: an upstream this node has NEVER SEEN is not a verdict — the bid may travel', () => {
    const j = fold([{ id: '2', from: RA, to: RC, rxAt: 20, body: hw('verify', ['build']) }], 'verify');
    assert.deepEqual(j.blockedBy, ['build']);
    assert.deepEqual(j.blockedByUnknown, ['build'], 'blocked ONLY because we were never sent it');
    assert.equal(mayApply(j, 'bid', RC).ok, true,
      'the refusal that binds is the requester\'s — they own the job and hold the whole graph');
  });

  t('graph gate: AWARD stays strict even on a partial view — a bid is an offer, an award is money', () => {
    const j = fold([{ id: '2', from: RA, to: RC, rxAt: 20, body: hw('verify', ['build']) }], 'verify');
    const may = mayApply(j, 'award', RA, { worker: RC, price: '8 USDC' });
    assert.equal(may.ok, false, 'being conservative when unsure is the right asymmetry on the paying side');
    assert.match(may.reason, /dependencies are unmet/);
  });

  /* C3's emitter-side warning, SCOPED PER PEER. The question is not "do I know this upstream" but "did I
   * send it to the party I'm now telling to depend on it" — because the recipient folds blockedByUnknown
   * on what THEY received, not on what I happen to know. The degenerate topology below is the exact one
   * C3 reproduced and the one a global-fold check silently misses. */
  t('unsentDepsTo warns per-peer: sent to THIS peer → silent, not sent to them → warned', () => {
    const me = RA;
    // I sent `build` to RB and `verify` to RC (two different peers).
    const out = [
      { id: '1', from: me, to: RB, rxAt: 10, body: hw('build') },
      { id: '2', from: me, to: RC, rxAt: 20, body: hw('verify') },
    ];
    // posting deploy(dependsOn:build) TO RB → I sent build to RB → no warning
    assert.deepEqual(unsentDepsTo(out, ['build'], me, RB), [], 'upstream was sent to this very peer');
    // THE C3 CASE: posting deploy(dependsOn:verify) TO RB → I sent verify to RC, NOT RB → warn.
    // A global "do I know verify" check says no (I do know it), and would wrongly stay silent.
    assert.deepEqual(unsentDepsTo(out, ['verify'], me, RB), ['verify'], 'known globally, but never sent to THIS peer');
    assert.deepEqual(unsentDepsTo(out, ['build', 'verify'], me, RB), ['verify'], 'only the one not sent here');
    assert.deepEqual(unsentDepsTo(out, undefined, me, RB), [], 'no deps → nothing to warn');
    // a bid I received (from someone else) is not an outbound help_wanted and must not count as "sent"
    const noisy = [...out, { id: '3', from: RC, to: me, rxAt: 30, body: buildWork('bid', { jobId: 'ship', price: '1' }) }];
    assert.deepEqual(unsentDepsTo(noisy, ['ship'], me, RB), ['ship'], 'only MY outbound help_wanted to THIS peer counts');
  });
}

/* THE BAZAAR — offers (supply). An offer is a standing listing bought by PAYING; the payment is the
 * deal. It reuses the whole settlement + conservation engine, so a purchase is just an edge and a
 * self-bought listing earns an outsider exactly nothing. */
{
  const { settlementsFrom: sFrom } = require('../lib/work');
  const { creditFor } = require('../lib/credit');
  const SELL = '0x' + 'a1'.repeat(20), BUY1 = '0x' + 'b1'.repeat(20), BUY2 = '0x' + 'c1'.repeat(20);
  const TX = (n) => '0x' + String(n).padStart(64, '0');
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const fact = (from, to) => ({ chainId: 8453, token: USDC, from, to, valueMicro: '5000000', confirmations: 20, blockTime: 1 });
  const off = () => [
    row(SELL, BUY1, buildWork('offer', { jobId: 'mcp', item: 'get_intent tool', price: '5 USDC', ref: 'https://x' })),
    row(BUY1, SELL, buildWork('settle', { jobId: 'mcp', txHash: TX(1), amountMicro: '5000000' })),
    row(BUY2, SELL, buildWork('settle', { jobId: 'mcp', txHash: TX(2), amountMicro: '5000000' })),
  ];
  const facts = new Map([[TX(1), fact(BUY1, SELL)], [TX(2), fact(BUY2, SELL)]]);

  t('an offer is a listing bought MANY times; each verified purchase becomes a buyer→seller edge', () => {
    const j = foldThread(off(), { txFacts: facts }).get('mcp');
    assert.equal(j.isOffer, true);
    assert.equal(j.state, 'offered');
    assert.equal(j.purchases.filter((p) => p.verified).length, 2, 'two distinct buyers, both verified');
    const edges = sFrom(off(), { txFacts: facts });
    assert.equal(edges.length, 2);
    assert.ok(edges.every((e) => e.worker === SELL.toLowerCase()), 'seller is the payee on every edge');
  });

  t('a purchase confers the seller CONSERVED standing to the buyer, and ZERO to an outsider', () => {
    const edges = sFrom(off(), { txFacts: facts });
    assert.equal(Number(creditFor(BUY1, edges, {}).direct.get(SELL.toLowerCase())) / 1e6, 5, 'BUY1 paid the seller 5');
    assert.equal(creditFor('0x' + '99'.repeat(20), edges, {}).direct.size, 0, 'a stranger sees no invented seller standing');
  });

  t('order-independent: a purchase folded before the offer is created still counts', () => {
    const shuffled = [...off()].reverse();
    assert.equal(foldThread(shuffled, { txFacts: facts }).get('mcp').purchases.filter((p) => p.verified).length, 2);
  });

  t('a seller cannot buy their own offer, and an unverified purchase confers nothing', () => {
    assert.equal(mayApply({ isOffer: true, requester: SELL.toLowerCase() }, 'settle', SELL).ok, false, 'no self-buy');
    // no chain fact injected → the purchase stays unverified → no edge → no standing
    const noFacts = foldThread(off()).get('mcp');
    assert.equal(noFacts.purchases.filter((p) => p.verified).length, 0);
    assert.equal(sFrom(off()).length, 0, 'unverified purchases produce no rating edge');
  });

  t('buildWork refuses an offer with no item, and offer is a known kind', () => {
    assert.ok(require('../lib/work').KINDS.includes('offer'));
    assert.throws(() => buildWork('offer', { jobId: 'x' }), /item/);
  });
}

// ---- bid GC: a retained bid that can no longer change anything may be dropped -------------------
console.log('\nLAWBOR work — staleBidIds (bounded retention, never removes an actionable bid):');
const { staleBidIds } = require('../lib/work');

t('a CANCELLED job sheds every bid (nothing left to corroborate)', () => {
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '10' })),
    row(W2, REQ, buildWork('bid', { jobId: 'j1', price: '9' })),
    row(REQ, W1, buildWork('cancel', { jobId: 'j1' })),
  ];
  assert.equal(staleBidIds(m).length, 2, 'both bids on a cancelled job are collectable');
});

t('an AWARDED job sheds LOSERS but KEEPS the winner — award corroboration is fold-preserved', () => {
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '10' })),   // winner (m[1])
    row(W2, REQ, buildWork('bid', { jobId: 'j1', price: '9' })),    // loser  (m[2])
    row(REQ, W1, buildWork('award', { jobId: 'j1', worker: W1, price: '10' })),
  ];
  assert.equal(foldThread(m).get('j1').award.corroborated, true, 'baseline: award is corroborated');
  const ids = new Set(staleBidIds(m));
  assert.ok(ids.has(m[2].id) && !ids.has(m[1].id), 'loser collectable, winner kept');
  const kept = m.filter((x) => !ids.has(x.id));               // simulate the GC
  const after = foldThread(kept).get('j1');
  assert.equal(after.state, 'awarded');
  assert.equal(after.award.corroborated, true, 'corroboration survives the GC — actionable state unchanged');
});

t('a LIVE bid on a READY job is never collected, even with a tiny TTL', () => {
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(W1, REQ, buildWork('bid', { jobId: 'j1', price: '10' })),
  ];
  assert.equal(staleBidIds(m, { now: 9e12, bidTtlMs: 1 }).length, 0);
});

t('a STRANDED bid (blocked job) is collected only PAST the TTL, and only when the TTL is enabled', () => {
  const m = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j2', task: 't', dependsOn: ['j1'] }), 1000),
    row(W1, REQ, buildWork('bid', { jobId: 'j2', price: '10' }), 2000),   // bid.at = rxAt = 2000
  ];
  assert.equal(foldThread(m).get('j2').ready, false, 'j2 is blocked — its upstream j1 was never seen');
  assert.equal(staleBidIds(m, { now: 2500, bidTtlMs: 1000 }).length, 0, 'within TTL: kept (might still revive)');
  assert.equal(staleBidIds(m, { now: 5000, bidTtlMs: 1000 }).length, 1, 'past TTL: stranded bid collected');
  assert.equal(staleBidIds(m, { now: 9e12, bidTtlMs: 0 }).length, 0, 'bidTtlMs:0 disables the stranded class entirely');
});

// ---- quote: structured price negotiation, agreedPrice DERIVED (never a payment) -----------------
console.log('\nLAWBOR work — quote (structured haggle; agreedPrice derived, confers nothing):');

t('two matching live quotes (owner + counterparty) derive agreedPrice', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(REQ, W1, buildWork('quote', { jobId: 'j1', amountMicro: '5000000' })),   // the OWNER quotes
    row(W1, REQ, buildWork('quote', { jobId: 'j1', amountMicro: '5000000' })),   // counterparty matches
  ]);
  assert.ok(j.agreedPrice, 'agreedPrice set when both sides match');
  assert.equal(j.agreedPrice.amountMicro, '5000000');
  assert.equal(j.agreedPrice.with, W1.toLowerCase());
  assert.equal(j.quotes.length, 2);
});

t('haggle then converge: a re-quote REPLACES (one live quote per party) and lands the deal', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(REQ, W1, buildWork('quote', { jobId: 'j1', amountMicro: '5000000' })),
    row(W1, REQ, buildWork('quote', { jobId: 'j1', amountMicro: '4000000' })),   // counter
    row(W1, REQ, buildWork('quote', { jobId: 'j1', amountMicro: '5000000' })),   // W1 re-quotes to match
  ]);
  assert.equal(j.quotes.length, 2, 'the re-quote replaced, it did not accumulate');
  assert.ok(j.agreedPrice && j.agreedPrice.amountMicro === '5000000', 'they converged');
});

t('the OWNER must agree too — only the counterparty quoting is not a deal', () => {
  const j = job([
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(W1, REQ, buildWork('quote', { jobId: 'j1', amountMicro: '5000000' })),
  ]);
  assert.equal(j.agreedPrice, null);
});

t('a quote is NEGOTIATION only — agreement is not payment, zero settlement edges', () => {
  const m = [
    row(REQ, W1, buildWork('offer', { jobId: 'o1', item: 'x' })),
    row(W1, REQ, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),
    row(REQ, W1, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),
  ];
  assert.equal(settlementsFrom(m).length, 0, 'a struck price moves no money and confers no standing');
});

t('bazaar haggle on an OFFER converges (seller + buyer)', () => {
  const j = job([
    row(REQ, W1, buildWork('offer', { jobId: 'o1', item: 'an MCP tool', price: '5 USDC hint' })),
    row(W1, REQ, buildWork('quote', { jobId: 'o1', amountMicro: '4500000' })),   // buyer offers 4.5
    row(REQ, W1, buildWork('quote', { jobId: 'o1', amountMicro: '4500000' })),   // seller accepts 4.5
  ], 'o1');
  assert.ok(j.agreedPrice && j.agreedPrice.amountMicro === '4500000');
});

t('order-independence: agreedPrice is the same whatever the fold order', () => {
  const msgs = [
    row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })),
    row(REQ, W1, buildWork('quote', { jobId: 'j1', amountMicro: '7000000' })),
    row(W1, REQ, buildWork('quote', { jobId: 'j1', amountMicro: '7000000' })),
  ];
  const a = foldThread(msgs).get('j1').agreedPrice;
  const b = foldThread([msgs[2], msgs[0], msgs[1]]).get('j1').agreedPrice;
  assert.deepEqual(a && a.amountMicro, b && b.amountMicro);
  assert.deepEqual(a && a.with, b && b.with);
});

t('buildWork validates amountMicro; mayApply gates quote on negotiable state', () => {
  assert.throws(() => buildWork('quote', { jobId: 'j1' }), /amountMicro/);
  assert.throws(() => buildWork('quote', { jobId: 'j1', amountMicro: '0' }), /amountMicro/);
  assert.throws(() => buildWork('quote', { jobId: 'j1', amountMicro: 'abc' }), /amountMicro/);
  const open = foldThread([row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' }))]).get('j1');
  assert.equal(mayApply(open, 'quote', W1).ok, true, 'allowed while open');
  assert.equal(mayApply(open, 'quote', REQ).ok, true, 'the owner may quote too (no self-restriction)');
  const cancelled = foldThread([row(REQ, W1, buildWork('help_wanted', { jobId: 'j1', task: 't' })), row(REQ, W1, buildWork('cancel', { jobId: 'j1' }))]).get('j1');
  assert.equal(mayApply(cancelled, 'quote', W1).ok, false, 'refused once no longer negotiable');
});

// ---- confirm: the owner LOCKS the agreed price (offer-side award), still moves no money ------------
console.log('\nLAWBOR work — confirm (owner locks agreedPrice; advisory, confers nothing):');

t('the owner confirming the agreed amount sets agreedPrice.accepted; a mismatched confirm does not', () => {
  const base = [
    row(REQ, W1, buildWork('offer', { jobId: 'o1', item: 'x' })),
    row(REQ, W1, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),   // owner agrees 5
    row(W1, REQ, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),   // buyer matches 5
  ];
  let j = job([...base], 'o1');
  assert.ok(j.agreedPrice && j.agreedPrice.accepted === false, 'agreed but not yet locked');
  j = job([...base, row(REQ, W1, buildWork('confirm', { jobId: 'o1', amountMicro: '5000000' }))], 'o1');
  assert.equal(j.agreedPrice.accepted, true, 'owner confirmed the agreed number → locked');
  // a confirm for a DIFFERENT number does not lock the current deal
  j = job([...base, row(REQ, W1, buildWork('confirm', { jobId: 'o1', amountMicro: '4000000' }))], 'o1');
  assert.equal(j.agreedPrice.accepted, false, 'a confirm of a different amount does not lock the agreed price');
});

t('re-quoting to a new price UN-locks it (accepted binds to the number, order-independent)', () => {
  const j = job([
    row(REQ, W1, buildWork('offer', { jobId: 'o1', item: 'x' })),
    row(REQ, W1, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),
    row(W1, REQ, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),
    row(REQ, W1, buildWork('confirm', { jobId: 'o1', amountMicro: '5000000' })),   // locked at 5
    row(REQ, W1, buildWork('quote', { jobId: 'o1', amountMicro: '6000000' })),      // owner re-quotes 6
    row(W1, REQ, buildWork('quote', { jobId: 'o1', amountMicro: '6000000' })),      // buyer matches 6
  ], 'o1');
  assert.equal(j.agreedPrice.amountMicro, '6000000', 'the deal moved to 6');
  assert.equal(j.agreedPrice.accepted, false, 'the old confirm (5) no longer locks the new price (6)');
});

t('confirm gating: owner-only, and only when a price is actually on the table', () => {
  const agreed = foldThread([
    row(REQ, W1, buildWork('offer', { jobId: 'o1', item: 'x' })),
    row(REQ, W1, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),
    row(W1, REQ, buildWork('quote', { jobId: 'o1', amountMicro: '5000000' })),
  ]).get('o1');
  assert.equal(mayApply(agreed, 'confirm', REQ).ok, true, 'owner may lock an agreed price');
  assert.equal(mayApply(agreed, 'confirm', W1).ok, false, 'a non-owner may not lock');
  const noDeal = foldThread([row(REQ, W1, buildWork('offer', { jobId: 'o2', item: 'x' }))]).get('o2');
  assert.equal(mayApply(noDeal, 'confirm', REQ).ok, false, 'cannot lock a price nobody agreed to');
  assert.throws(() => buildWork('confirm', { jobId: 'o1', amountMicro: '0' }), /amountMicro/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
