'use strict';
// LAWBOR credit — the anti-farming core. These are the tests that MATTER: a dedicated adversary farmed
// five rating designs (RATING-DESIGN.md); the property that survived is that standing is a conserved,
// debited quantity bounded by the VIEWER's own spend. If these pass, a collusion ring earns nothing.
// Run: node test/credit.test.js
const assert = require('node:assert');
const { creditFor } = require('../lib/credit');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const A = (h) => '0x' + h.repeat(20);
const V = A('01'), W = A('02'), X = A('03'), Y = A('04');
const sum = (m) => [...m.values()].reduce((s, x) => s + x, 0);
const edge = (payer, worker, amountMicro, blockTime, i) => ({ payer, worker, amountMicro: String(amountMicro), blockTime: blockTime || 1000, txHash: '0x' + String(i || Math.floor(amountMicro)).padStart(64, '0'), jobId: 'j' + (i || amountMicro) });
// deterministic RNG so the fuzz bound reproduces
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

console.log('LAWBOR credit — conservation-bounded rating (the farming survivor):');

t('direct = what the VIEWER itself paid; a stranger V never paid scores 0', () => {
  const c = creditFor(V, [edge(V, W, 500e6, 1000, 1)]);
  assert.equal(c.direct.get(W), 500e6);
  assert.equal(c.direct.get(X), undefined, 'V never paid X → nothing');
  assert.equal(sum(c.circle), 0);
});

t('KILL: a 2-party ring recycling a float 200× earns EXACTLY ZERO to an outside viewer', () => {
  // A and B wash 1000 USDC back and forth 200 times. V is not in the ring.
  const A_ = A('aa'), B_ = A('bb'), edges = [];
  for (let i = 0; i < 200; i++) { edges.push(edge(A_, B_, 1000e6, 1000 + i, 2 * i)); edges.push(edge(B_, A_, 1000e6, 1000 + i, 2 * i + 1)); }
  const c = creditFor(V, edges);
  assert.equal(sum(c.direct), 0, 'ring internal wash contributes nothing to V');
  assert.equal(sum(c.circle), 0, 'and confers nothing, because V seeded no budget');
});

t('KILL: 10,000 sybils behind ONE paid seed sum to ≤ α × that seed\'s payment', () => {
  // V paid the seed S 100 USDC. S then "pays" 10,000 sybils 1000 USDC each (a wash it fully controls).
  const S = A('55'), edges = [edge(V, S, 100e6, 1000, 0)];
  for (let i = 0; i < 10000; i++) edges.push(edge(S, A(String(i % 90 + 10).padStart(2, '0').slice(0, 2)), 1000e6, 2000 + i, i + 1));
  const c = creditFor(V, edges, { alpha: 0.5 });
  assert.equal(c.direct.get(S), 100e6);
  assert.ok(sum(c.circle) <= 0.5 * 100e6, `circle ${sum(c.circle)} must be ≤ α·100 USDC = ${0.5 * 100e6}`);
});

t('THEOREM: over 200 random graphs, Σdirect + Σcircle ≤ (1+α)·spend(V) — always', () => {
  const r = rng(42), alpha = 0.5;
  for (let g = 0; g < 200; g++) {
    const addrs = Array.from({ length: 6 }, (_, i) => A(String(10 + i).padStart(2, '0').slice(0, 2)));
    const edges = []; let spendV = 0;
    const n = 3 + Math.floor(r() * 20);
    for (let i = 0; i < n; i++) {
      const p = addrs[Math.floor(r() * addrs.length)], w = addrs[Math.floor(r() * addrs.length)];
      if (p === w) continue;
      const amt = Math.floor(r() * 1e9);
      edges.push(edge(p, w, amt, 1000 + i, i));
      if (p === V && w !== V) spendV += amt;   // V's outgoing, un-netted upper bound
    }
    const c = creditFor(V, edges, { alpha });
    const total = sum(c.direct) + sum(c.circle);
    assert.ok(total <= (1 + alpha) * spendV + 1, `graph ${g}: total ${total} > (1+α)·spend ${(1 + alpha) * spendV}`);
  }
});

t('circle: V→S (paid), S→W (paid) confers attenuated credit to W, capped by S\'s budget', () => {
  const S = A('55');
  const c = creditFor(V, [edge(V, S, 100e6, 1000, 1), edge(S, W, 80e6, 2000, 2)], { alpha: 0.5 });
  assert.equal(c.direct.get(S), 100e6);
  assert.equal(c.circle.get(W), 50e6, 'grant = min(80 paid, budget = α·100 = 50) = 50');
});

t('a seed\'s budget is DEBITED across recipients and cannot be over-spent', () => {
  const S = A('55');
  // V paid S 100 → budget = 50. S pays W 40 and X 40. Total conferrable is 50, not 80.
  const c = creditFor(V, [edge(V, S, 100e6, 1000, 1), edge(S, W, 40e6, 2000, 2), edge(S, X, 40e6, 3000, 3)], { alpha: 0.5 });
  assert.equal(sum(c.circle), 50e6, 'budget 50 is split, never exceeded');
  assert.equal(c.circle.get(W), 40e6, 'earliest (W) gets its full 40 first');
  assert.equal(c.circle.get(X), 10e6, 'X gets the remaining 10');
});

t('NETTING: a refund by plain transfer zeroes the edge when returnFlow is wired', () => {
  const rf = new Map(); rf.set(W + '|' + V, 500e6);   // W sent 500 back to V (a plain transfer, uncited)
  const c = creditFor(V, [edge(V, W, 500e6, 1000, 1)], { returnFlow: rf });
  assert.equal(c.direct.get(W) || 0, 0, 'paid 500, refunded 500 → net 0');
  assert.equal(c.netted, 'with-return-flow');
});

t('without a returnFlow reader it nets settlements-only and SAYS SO (fail-honest, not silent)', () => {
  const c = creditFor(V, [edge(V, W, 500e6, 1000, 1)]);
  assert.equal(c.netted, 'settlements-only');
  assert.match(c.limits[0], /return-leg netting is OFF/);
});

t('inbound is the OPPOSITE direction of direct — what an address paid US, not what we paid them', () => {
  // V paid W 500 (direct); X paid V 300 (inbound). The two must never be confused — a live two-node
  // run quoted a stranger-premium to a client who had just paid, because it read `direct` for a
  // question that was about `inbound`.
  const c = creditFor(V, [edge(V, W, 500e6, 1000, 1), edge(X, V, 300e6, 2000, 2)]);
  assert.equal(c.direct.get(W), 500e6, 'direct = what V paid');
  assert.equal(c.direct.get(X), undefined, 'X is not in direct — V never paid X');
  assert.equal(c.inbound.get(X), 300e6, 'inbound = what X paid V');
  assert.equal(c.inbound.get(W), undefined, 'W is not in inbound — W never paid V');
});

t('inbound nets the return leg too, so a refunded client shows no inbound standing', () => {
  const rf = new Map(); rf.set(V + '|' + X, 300e6);   // V sent 300 back to X
  const c = creditFor(V, [edge(X, V, 300e6, 1000, 1)], { returnFlow: rf });
  assert.equal(c.inbound.get(X) || 0, 0, 'X paid 300, V refunded 300 → net inbound 0');
});

t('deterministic: shuffling the edge order yields the same credit', () => {
  const S = A('55');
  const es = [edge(V, S, 100e6, 1000, 1), edge(S, W, 40e6, 2000, 2), edge(S, X, 40e6, 3000, 3), edge(V, W, 20e6, 1500, 4)];
  const a = creditFor(V, es, { alpha: 0.5 });
  const b = creditFor(V, es.slice().reverse(), { alpha: 0.5 });
  assert.deepEqual([...a.direct.entries()].sort(), [...b.direct.entries()].sort());
  assert.deepEqual([...a.circle.entries()].sort(), [...b.circle.entries()].sort());
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
