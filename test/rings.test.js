'use strict';
// LAWBOR rings — the STRUCTURAL anti-farming lens (settlement cycles = money that came back).
// Advisory + read-only; it never enters the rating. These tests pin: correct cycle detection, the
// bottleneck ("recycled") amount, dedup/canonicalization, determinism, and the bounds that keep it total.
// Run: node test/rings.test.js
const assert = require('node:assert');
const { detectRings } = require('../lib/rings');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const A = (h) => '0x' + h.repeat(20);
const a = A('a1'), b = A('b1'), c = A('c1'), d = A('d1'), e = A('e1');
const edge = (payer, worker, amountMicro) => ({ payer, worker, amountMicro: String(amountMicro), txHash: '0x' + String(amountMicro).padStart(64, '0') });

console.log('LAWBOR rings — settlement-cycle detection (structural, advisory):');

t('a plain chain A→B→C has NO cycle', () => {
  const r = detectRings([edge(a, b, 100), edge(b, c, 100)]);
  assert.equal(r.cycles.length, 0);
  assert.equal(r.totalRecycledMicro, '0');
  assert.deepEqual(r.addressesInRings, []);
});

t('a 2-cycle A→B→A is detected; recycled = the bottleneck (min leg)', () => {
  const r = detectRings([edge(a, b, 100), edge(b, a, 60)]);
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].hops, 2);
  assert.deepEqual(r.cycles[0].members, [a, b]);   // canonical: starts at the min address
  assert.equal(r.cycles[0].recycledMicro, '60');   // min(100, 60)
  assert.deepEqual(r.addressesInRings, [a, b].sort());
});

t('a 3-cycle A→B→C→A is detected once, canonicalized to start at the min address', () => {
  const r = detectRings([edge(b, c, 30), edge(c, a, 40), edge(a, b, 50)]);
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].hops, 3);
  assert.deepEqual(r.cycles[0].members, [a, b, c]);      // one representative, min-first, direction kept
  assert.equal(r.cycles[0].recycledMicro, '30');         // min(50,30,40)
});

t('direction matters: A→B and B→A both exist → the 2-cycle; but A→B→C with C→A missing → none', () => {
  assert.equal(detectRings([edge(a, b, 10), edge(b, a, 10)]).cycles.length, 1);
  assert.equal(detectRings([edge(a, b, 10), edge(b, c, 10)]).cycles.length, 0);
});

t('parallel/repeated edges on a pair SUM before the bottleneck is taken', () => {
  // A→B twice (40+40=80), B→A once (70) → bottleneck min(80,70)=70
  const r = detectRings([edge(a, b, 40), edge(a, b, 40), edge(b, a, 70)]);
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].recycledMicro, '70');
});

t('a hub with NO return path flags nothing (star, not a ring)', () => {
  const r = detectRings([edge(a, b, 100), edge(a, c, 100), edge(a, d, 100)]);
  assert.equal(r.cycles.length, 0);
});

t('two independent rings are both found and ordered by recycled desc', () => {
  const r = detectRings([edge(a, b, 20), edge(b, a, 20), edge(c, d, 90), edge(d, c, 90)]);
  assert.equal(r.cycles.length, 2);
  assert.equal(r.cycles[0].recycledMicro, '90');   // bigger first
  assert.equal(r.cycles[1].recycledMicro, '20');
  assert.equal(r.totalRecycledMicro, '110');
});

t('self-loops and zero/negative amounts are ignored (no phantom ring)', () => {
  const r = detectRings([edge(a, a, 100), edge(a, b, 0), edge(b, a, -5)]);
  assert.equal(r.cycles.length, 0);
});

t('a longer cycle beyond maxLen is NOT reported (bounded), and the limit says so', () => {
  const ring5 = [edge(a, b, 10), edge(b, c, 10), edge(c, d, 10), edge(d, e, 10), edge(e, a, 10)];
  assert.equal(detectRings(ring5, { maxLen: 4 }).cycles.length, 0);
  assert.equal(detectRings(ring5, { maxLen: 5 }).cycles.length, 1);   // raise the bound → found
  assert.ok(detectRings(ring5, { maxLen: 4 }).limits.some((l) => /short cycles only/.test(l)));
});

t('DETERMINISM: shuffling the edge order yields identical cycles + order', () => {
  const es = [edge(a, b, 50), edge(b, c, 30), edge(c, a, 40), edge(c, d, 90), edge(d, c, 90)];
  const r1 = detectRings(es);
  const r2 = detectRings(es.slice().reverse());
  assert.deepEqual(r1.cycles, r2.cycles);
  assert.deepEqual(r1.addressesInRings, r2.addressesInRings);
});

t('BOUNDED: a graph past maxNodes skips enumeration and says so (total, never hangs)', () => {
  const big = [];
  for (let i = 0; i < 60; i++) big.push(edge(A(('' + (i % 100)).padStart(2, '0')), A(('' + ((i + 1) % 100)).padStart(2, '0')), 10));
  const r = detectRings(big, { maxNodes: 5 });
  assert.equal(r.cycles.length, 0);
  assert.ok(r.limits.some((l) => /enumeration skipped/.test(l)));
});

t('the advisory disclaimer is always present (a legit mutual-trade loop can also cycle)', () => {
  const r = detectRings([edge(a, b, 10), edge(b, a, 10)]);
  assert.ok(r.limits.some((l) => /ADVISORY only/.test(l) && /never enters the rating/.test(l)));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
