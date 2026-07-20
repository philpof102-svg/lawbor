'use strict';
// The admission preflight is consulted on EVERY inbound envelope, so under a burst of newcomers it is
// the scaling bottleneck. A short-TTL cache reuses a slow-changing verdict; this pins its behaviour.
// Run: node test/preflight-cache.test.js
process.env.LAWBOR_PREFLIGHT_TTL_MS = '120';        // small TTL so the expiry case is fast + deterministic
const assert = require('node:assert');
const { mainstreetPreflight, _resetPreflightCache } = require('../server.js');

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const realFetch = global.fetch;
let calls = 0;
const okFetch = () => { calls++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ decision: 'admit', score: 50 }) }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

(async () => {
  console.log('LAWBOR preflight cache — cut N oracle round-trips under a newcomer burst:');

  await t('a repeat read of the same address is served from cache — one oracle call, not two', async () => {
    _resetPreflightCache(); calls = 0; global.fetch = okFetch;
    const r1 = await mainstreetPreflight(A);
    const r2 = await mainstreetPreflight(A);
    assert.equal(calls, 1, 'the second read hit the cache');
    assert.deepEqual(r1, r2, 'and returned the identical verdict');
  });

  await t('a never-seen address MISSES the cache and reaches the oracle', async () => {
    await mainstreetPreflight(B);
    assert.equal(calls, 2, 'a new address is not masked by another address’s verdict');
  });

  await t('the cache key is case-insensitive — 0xAAA… hits the entry stored for 0xaaa…', async () => {
    await mainstreetPreflight(A.toUpperCase());
    assert.equal(calls, 2, 'no extra oracle call for a differently-cased same address');
  });

  await t('a FAILED preflight is never cached — the relay’s outage handling must still see it', async () => {
    _resetPreflightCache(); calls = 0;
    global.fetch = () => { calls++; return Promise.resolve({ ok: false, status: 503 }); };
    await mainstreetPreflight(A).catch(() => {});
    await mainstreetPreflight(A).catch(() => {});
    assert.equal(calls, 2, 'both calls hit the oracle — a failure is not pinned as a verdict');
  });

  await t('the entry EXPIRES after the TTL — a stale verdict is not served forever', async () => {
    _resetPreflightCache(); calls = 0; global.fetch = okFetch;
    await mainstreetPreflight(A);          // call 1, cached
    await mainstreetPreflight(A);          // cached hit
    assert.equal(calls, 1, 'within TTL: one call');
    await wait(160);                       // > 120ms TTL
    await mainstreetPreflight(A);          // re-fetch
    assert.equal(calls, 2, 'past TTL: the oracle is consulted again');
  });

  global.fetch = realFetch;
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
