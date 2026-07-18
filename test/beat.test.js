'use strict';
// LAWBOR heartbeat decisions — pure, offline, deterministic (injected clock + rng, no timers here).
// The sockets and the setTimeout live in server.js; every DECISION lives in lib/beat.js and is pinned here.
// Run: node test/beat.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { dueFor, nextDelay, offerTarget } = require('../lib/beat');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const NOW = 1_784_000_000_000;
const p = (addr, ageMs) => ({ addr, lastSeen: NOW - ageMs });

console.log('LAWBOR heartbeat — who to contact, when to wake, when to gossip:');

t('only peers older than the interval are due — a peer seen a second ago is left alone', () => {
  const due = dueFor([p('a', 1000), p('b', 90_000), p('c', 300_000)], NOW, { intervalMs: 60_000 });
  assert.deepEqual(due, ['c', 'b'], 'oldest contact first');
});

t('a peer with no lastSeen at all is maximally overdue, never skipped', () => {
  const due = dueFor([{ addr: 'fresh', lastSeen: NOW }, { addr: 'never' }], NOW, { intervalMs: 60_000 });
  assert.deepEqual(due, ['never']);
});

t('AMPLIFICATION: a tick contacts at most `batch` peers, however large the table', () => {
  const many = Array.from({ length: 500 }, (_, i) => p('peer' + i, 120_000 + i));
  assert.equal(dueFor(many, NOW, { intervalMs: 60_000, batch: 4 }).length, 4);
  assert.equal(dueFor(many, NOW, { intervalMs: 60_000 }).length, 4, 'and the default is bounded too');
});

t('no peer starves: oldest-first means a skipped peer rises to the front next tick', () => {
  const many = Array.from({ length: 10 }, (_, i) => p('peer' + i, 60_000 + i * 1000));
  const first = dueFor(many, NOW, { intervalMs: 60_000, batch: 3 });
  assert.deepEqual(first, ['peer9', 'peer8', 'peer7'], 'the longest-unseen go first');
  const after = many.map((x) => (first.includes(x.addr) ? { addr: x.addr, lastSeen: NOW } : x));
  assert.deepEqual(dueFor(after, NOW, { intervalMs: 60_000, batch: 3 }), ['peer6', 'peer5', 'peer4']);
});

t('garbage in the peer list is ignored rather than crashing the loop', () => {
  assert.deepEqual(dueFor([null, undefined, {}, 42, p('ok', 999_999)], NOW, { intervalMs: 1000 }), ['ok']);
  assert.deepEqual(dueFor(undefined, NOW, {}), []);
});

t('THUNDERING HERD: delays are spread across the jitter band, never identical', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const ds = Array.from({ length: 50 }, () => nextDelay({ intervalMs: 60_000, jitterFrac: 0.3, rng }));
  const uniq = new Set(ds);
  assert.ok(uniq.size > 40, 'wake-ups must not align — got ' + uniq.size + ' distinct delays');
  for (const d of ds) assert.ok(d >= 42_000 && d <= 78_000, 'delay ' + d + ' inside the ±30% band');
});

t('nextDelay never returns 0 or negative — a zero delay is a busy loop', () => {
  assert.ok(nextDelay({ intervalMs: 1, jitterFrac: 0.9, rng: () => 0 }) >= 1);
  assert.ok(nextDelay({ intervalMs: 0 }) >= 1, 'a nonsense interval falls back to the default');
  assert.ok(nextDelay({ intervalMs: 60_000, jitterFrac: 99, rng: () => 0 }) >= 1, 'jitter is clamped');
});

t('peer exchange is STINGY: at most one target, and only every N ticks', () => {
  const peers = ['a', 'b', 'c'];
  const rng = () => 0.5;
  const hits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => offerTarget(peers, n, { everyNTicks: 5, rng }));
  assert.equal(hits.filter(Boolean).length, 2, 'only ticks 5 and 10 gossip');
  assert.equal(typeof hits[4], 'string');
  assert.equal(offerTarget([], 5, { everyNTicks: 5, rng }), null, 'no peers → no gossip');
});

t('offerTarget always returns a real peer, never an out-of-range index', () => {
  assert.equal(offerTarget(['only'], 5, { everyNTicks: 5, rng: () => 0.999999 }), 'only');
});

// --- the property the whole file exists for --------------------------------------------------
t('beat.js is pure: no timers, no sockets, no requires', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'beat.js'), 'utf8');
  assert.ok(!/setTimeout|setInterval|require\(/.test(src.replace(/^[\s\S]*?\*\//, '')),
    'scheduling and I/O belong to the caller, so these decisions stay testable offline');
  assert.ok(!/Date\.now\(\)/.test(src.split('module.exports')[0].replace(/\/\*[\s\S]*?\*\//g, '')),
    'time is passed in, never read — otherwise these tests could not be deterministic');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
