'use strict';
// LAWBOR store — the fold memo that turns O(N)-per-read into O(1)-amortized.
// Run: node test/store.test.js
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
const assert = require('node:assert');
const { createStore } = require('../lib/store');
const { foldThread, buildWork } = require('../lib/work');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b1'.repeat(20);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-store-'));
const store = createStore(path.join(dir, 's.jsonl'));
let seq = 0;
const env = (from, to, body) => ({ id: '0x' + (++seq).toString(16).padStart(6, '0'), thread: 't', from, to, body, ts: 1 });

console.log('LAWBOR store — fold memo (scaling: read O(1) amortized, not O(N) per call):');

store.record(env(A, B, buildWork('help_wanted', { jobId: 'j1', task: 'x' })), { origin: 'bot', dir: 'out' });
store.record(env(B, A, buildWork('bid', { jobId: 'j1', price: '5' })), { origin: 'bot', dir: 'in' });

t('mutations() is monotonic and bumps on every write (message, delete, control)', () => {
  const m0 = store.mutations();
  store.record(env(B, A, buildWork('bid', { jobId: 'j1', price: '4' })), { origin: 'bot', dir: 'in' });
  const m1 = store.mutations();
  store.appendControl('block', A);
  const m2 = store.mutations();
  assert.ok(m1 > m0 && m2 > m1, 'each write advanced the counter');
  store.appendControl('unblock', A);   // restore for later tests
});

t('foldMemo computes ONCE across identical reads, and the result is correct', () => {
  let computes = 0;
  const key = () => 'wf:' + store.mutations();
  const fold = () => store.foldMemo(key(), () => { computes++; return foldThread(store.all(), {}); });
  const r1 = fold(), r2 = fold(), r3 = fold();
  assert.equal(computes, 1, 'three reads at the same mutation count folded once');
  assert.ok(r1 === r2 && r2 === r3, 'identical cached object returned');
  // and it equals a fresh, un-memoized fold — the cache never lies
  const fresh = foldThread(store.all(), {});
  assert.deepEqual([...r1.keys()].sort(), [...fresh.keys()].sort());
  assert.equal(r1.get('j1').bids.length, fresh.get('j1').bids.length);
});

t('a new message INVALIDATES the memo — the next read recomputes', () => {
  let computes = 0;
  const key = () => 'wf:' + store.mutations();
  const fold = () => store.foldMemo(key(), () => { computes++; return foldThread(store.all(), {}); });
  // Start with a write so this test's first key is FRESH (the memo is shared across tests — a warm from
  // an earlier test would otherwise make the first read a hit and confuse the count).
  store.record(env(A, B, buildWork('help_wanted', { jobId: 'j2', task: 'y' })), { origin: 'bot', dir: 'out' });
  fold();                    // fresh key → compute 1
  fold();                    // same key → hit
  assert.equal(computes, 1, 'warm then re-read folded once');
  store.record(env(A, B, buildWork('help_wanted', { jobId: 'j3', task: 'z' })), { origin: 'bot', dir: 'out' });
  const after = fold();      // key changed → recompute (compute 2)
  assert.equal(computes, 2, 'the write forced exactly one recompute');
  assert.ok(after.has('j3'), 'the fresh fold includes the new job');
});

t('a control write (block) INVALIDATES the memo too — the blocked filter can change', () => {
  const key = () => 'wf:' + store.mutations();
  const before = store.mutations();
  store.foldMemo(key(), () => foldThread(store.all(), {}));
  store.appendControl('block', B);
  assert.notEqual(store.mutations(), before, 'the control write advanced the counter, so the next keyed read misses');
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
