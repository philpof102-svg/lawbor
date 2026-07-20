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

t('compaction is THREAD-ATOMIC — it never orphans a reply from its opening message', () => {
  // A public trial hub is bounded by maxMessages. The danger: slice(newest N) can cut a still-live
  // thread in half, and the fold then silently drops the whole negotiation (a bid whose help_wanted
  // was compacted away is ignored). Here we overflow a small cap with many threads and assert that
  // every thread the store kept is kept WHOLE — its seed (earliest message) is always present.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-compact-'));
  const s2 = createStore(path.join(d2, 's.jsonl'), undefined, { maxMessages: 6, compactEvery: 0 });
  let n = 0;
  const put = (thread, from, to, work) =>
    s2.record({ id: '0x' + (++n).toString(16).padStart(6, '0'), thread, from, to, body: work, ts: n },
              { origin: 'bot', dir: from === A ? 'out' : 'in' });
  // 4 negotiations of 3 messages each = 12 live messages, cap is 6 → compaction must drop whole threads.
  for (let j = 1; j <= 4; j++) {
    const jid = 'j' + j, th = 't' + j;
    put(th, A, B, buildWork('help_wanted', { jobId: jid, task: 'x' }));   // the SEED
    put(th, B, A, buildWork('bid', { jobId: jid, price: '5' }));
    put(th, A, B, buildWork('award', { jobId: jid, worker: B, price: '5' }));
  }
  s2.compact();
  const kept = s2.all();
  assert.ok(kept.length <= 6 + 3, 'cap respected within one whole-thread of slack');
  // group what survived by thread; every surviving thread must still carry its help_wanted seed
  const byThread = new Map();
  for (const m of kept) { const k = m.thread; (byThread.get(k) || byThread.set(k, []).get(k)).push(m); }
  for (const [th, msgs] of byThread) {
    const folded = foldThread(msgs, {});
    assert.ok(folded.size >= 1, `thread ${th} survived WHOLE — its seed folded a job, not orphans`);
  }
  // and the fold over the whole store has zero orphaned negotiations (every kept work msg maps to a job)
  const all = foldThread(kept, {});
  assert.ok(all.size >= 1 && all.size <= 4, 'kept a whole number of intact jobs');
  try { fs.rmSync(d2, { recursive: true, force: true }); } catch {}
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
