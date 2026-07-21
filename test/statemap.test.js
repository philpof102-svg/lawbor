'use strict';
// LAWBOR statemap — the job lifecycle as an explicit FSM, pinned to the fold so it cannot drift.
// The property tests apply the tweet's thesis: the fold must NEVER produce a state or a mode-transition
// the table does not sanction ("illegal states unrepresentable"), checked by walking the table, not by
// sampling code paths. Run: node test/statemap.test.js
const assert = require('node:assert');
const { JOB_TRANSITIONS, OFFER_TRANSITIONS, ALL_STATES, TERMINAL, nextState, isTerminal, reachableStates, isReachable } = require('../lib/statemap');
const { foldThread, buildWork } = require('../lib/work');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const A = (h) => '0x' + h.repeat(20);
const REQ = A('a1'), W = A('b1'), BUY = A('c1');
let seq = 0;
const row = (from, to, body, rxAt) => ({ id: '0x' + String(++seq).padStart(4, '0'), from, to, body, ts: 1, rxAt: rxAt !== undefined ? rxAt : seq * 1000 });
// deterministic RNG (repo convention: no Math.random — a seed makes the property reproducible)
function rng(s) { let a = s >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
// a matching chain fact so a settle can VERIFY (awarded → settled)
const USDC = require('../lib/work').USDC_BASE;
const fact = (from, to, micro, h) => [h, { chainId: 8453, token: USDC, from, to, valueMicro: String(micro), confirmations: 20, blockTime: 100 }];

console.log('LAWBOR statemap — the job lifecycle as an explicit FSM (from the FSM/graph article):');

t('the table is well-formed: every transition target is a declared state', () => {
  for (const tbl of [JOB_TRANSITIONS, OFFER_TRANSITIONS])
    for (const [s, edges] of Object.entries(tbl))
      for (const [ev, to] of Object.entries(edges))
        assert.ok(ALL_STATES.includes(to), `${s} --${ev}--> ${to} targets an undeclared state`);
});

t('terminals have no outgoing edges; initials reach every declared state (no dead states in the map)', () => {
  for (const s of TERMINAL) assert.equal(Object.keys((JOB_TRANSITIONS[s] || OFFER_TRANSITIONS[s] || {})).length, 0);
  const reach = new Set([...reachableStates(false), ...reachableStates(true)]);
  for (const s of ALL_STATES) assert.ok(reach.has(s), `state ${s} is declared but unreachable from any initial`);
});

t('nextState honours the table; an undefined event stays put; terminal states never move', () => {
  assert.equal(nextState('open', 'award'), 'awarded');
  assert.equal(nextState('open', 'settle'), 'open', 'settle does nothing from open (needs award first)');
  assert.equal(nextState('awarded', 'settle'), 'settled');
  assert.equal(nextState('offered', 'cancel', true), 'delisted');
  assert.equal(nextState('settled', 'cancel'), 'settled');
  assert.equal(nextState('delisted', 'cancel', true), 'delisted');
  assert.ok(isTerminal('settled') && isTerminal('cancelled') && isTerminal('delisted'));
  assert.ok(!isTerminal('open') && !isTerminal('offered') && !isTerminal('awarded'));
});

t('every declared state is actually PRODUCED by a real fold (the map has no phantom states)', () => {
  const produced = new Set();
  const bt = (msgs, opts) => { for (const j of foldThread(msgs, opts).values()) produced.add(j.state); };
  bt([row(REQ, W, buildWork('help_wanted', { jobId: 'o', task: 't' }))]);                                   // open
  bt([row(REQ, W, buildWork('help_wanted', { jobId: 'a', task: 't' })), row(REQ, W, buildWork('award', { jobId: 'a', worker: W, price: '5' }))]); // awarded
  bt([row(REQ, W, buildWork('help_wanted', { jobId: 'c', task: 't' })), row(REQ, W, buildWork('cancel', { jobId: 'c' }))]);                        // cancelled
  bt([row(REQ, W, buildWork('offer', { jobId: 'f', item: 'x' }))]);                                          // offered
  bt([row(REQ, W, buildWork('offer', { jobId: 'd', item: 'x' })), row(REQ, W, buildWork('cancel', { jobId: 'd' }))]);                              // delisted
  const H = '0x' + 'ab'.repeat(32);
  bt([row(REQ, W, buildWork('help_wanted', { jobId: 's', task: 't' })),
      row(REQ, W, buildWork('award', { jobId: 's', worker: W, price: '5' })),
      row(REQ, W, buildWork('settle', { jobId: 's', txHash: H, amountMicro: '5' }))],
     { txFacts: new Map([fact(REQ, W, '5', H)]) });                                                          // settled
  assert.deepEqual([...produced].sort(), ALL_STATES, 'the states the fold produces must equal the declared set');
});

t('PROPERTY: over 500 random logs the fold NEVER leaves the declared, reachable state set (drift guard)', () => {
  const r = rng(20260721);
  const observed = new Set();
  for (let n = 0; n < 500; n++) {
    const isOffer = r() < 0.5;
    const id = 'j' + n;
    const msgs = [row(REQ, W, isOffer ? buildWork('offer', { jobId: id, item: 'x', price: '5' })
                                      : buildWork('help_wanted', { jobId: id, task: 't' }))];
    const H = '0x' + String(n).padStart(64, '0');
    const evs = isOffer
      ? [buildWork('quote', { jobId: id, amountMicro: '4' }), buildWork('confirm', { jobId: id, amountMicro: '4' }), buildWork('cancel', { jobId: id })]
      : [buildWork('bid', { jobId: id, price: '5' }), buildWork('award', { jobId: id, worker: W, price: '5' }),
         buildWork('cancel', { jobId: id }), buildWork('settle', { jobId: id, txHash: H, amountMicro: '5' })];
    const k = 2 + Math.floor(r() * 4);
    for (let i = 0; i < k; i++) {
      const ev = evs[Math.floor(r() * evs.length)];
      const from = r() < 0.7 ? REQ : (isOffer ? BUY : W);   // sometimes the wrong actor (guard must reject)
      msgs.push(row(from, REQ, ev));
    }
    const opts = { txFacts: new Map([fact(REQ, W, '5', H)]) };
    for (const j of foldThread(msgs, opts).values()) {
      observed.add(j.state);
      assert.ok(ALL_STATES.includes(j.state), 'fold produced an UNDECLARED state: ' + j.state);
      assert.ok(isReachable(j.state, !!j.isOffer), 'fold reached an UNREACHABLE state: ' + j.state);
    }
  }
  for (const s of observed) assert.ok(ALL_STATES.includes(s), 'observed state outside the map: ' + s);
});

t('CONFORMANCE: a terminal job takes no further mode transition, whatever arrives next', () => {
  const H = '0x' + 'cd'.repeat(32);
  // settled job: a later award/cancel/settle must NOT move it
  const settled = [row(REQ, W, buildWork('help_wanted', { jobId: 'x', task: 't' })),
    row(REQ, W, buildWork('award', { jobId: 'x', worker: W, price: '5' })),
    row(REQ, W, buildWork('settle', { jobId: 'x', txHash: H, amountMicro: '5' })),
    row(REQ, W, buildWork('cancel', { jobId: 'x' })),
    row(REQ, W, buildWork('award', { jobId: 'x', worker: BUY, price: '9' }))];
  assert.equal(foldThread(settled, { txFacts: new Map([fact(REQ, W, '5', H)]) }).get('x').state, 'settled');
  // delisted offer: a later cancel/quote/confirm must NOT resurrect it
  const delisted = [row(REQ, W, buildWork('offer', { jobId: 'y', item: 'z' })),
    row(REQ, W, buildWork('cancel', { jobId: 'y' })),
    row(W, REQ, buildWork('quote', { jobId: 'y', amountMicro: '3' })),
    row(REQ, W, buildWork('cancel', { jobId: 'y' }))];
  assert.equal(foldThread(delisted).get('y').state, 'delisted');
  // cancelled job stays cancelled
  const cancelled = [row(REQ, W, buildWork('help_wanted', { jobId: 'q', task: 't' })),
    row(REQ, W, buildWork('cancel', { jobId: 'q' })),
    row(REQ, W, buildWork('award', { jobId: 'q', worker: W, price: '5' }))];
  assert.equal(foldThread(cancelled).get('q').state, 'cancelled');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
