'use strict';
// LAWBOR mesh guards — the peer layer (presence, peer-exchange, liveness). One test per invariant.
// Fully OFFLINE and deterministic: clock, rng, verify (transport) and preflight (oracle) are injected;
// nothing here opens a socket, and the last test proves lib/mesh.js cannot.
// Run: node test/mesh.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createMesh, classifyUrl, isPrivateAddress } = require('../lib/mesh');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const SELF = '0x' + 'ff'.repeat(20);
const addrOf = (i) => '0x' + i.toString(16).padStart(40, '0');
const urlOf = (i) => 'https://n' + i + '.example.com/';

// ---- injected transport: a registry of discovery cards, keyed by NORMALIZED url -------------------
let verifyCalls = 0, preflightCalls = 0;
const cards = new Map();                                  // normalized url → { addr }
const register = (i) => { cards.set(urlOf(i), { addr: addrOf(i) }); return urlOf(i); };
const verify = async (u) => { verifyCalls++; if (!cards.has(u)) throw new Error('no discovery card at ' + u); return cards.get(u); };
const preflight = async () => { preflightCalls++; return { decision: 'PROCEED', score: 72 }; };
const counters = () => ({ v: verifyCalls, p: preflightCalls });

// ---- injected clock + rng ------------------------------------------------------------------------
let NOW = 1_700_000_000_000;
const clock = () => NOW;
let seed = 1;
const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const mk = (over = {}) => createMesh(Object.assign({ self: SELF, preflight, verify, clock, rng }, over));

// build a mesh pre-loaded with `n` peers of a given source (setup helper — addPeer is the only write path)
async function seedPeers(mesh, from, to, opts) {
  const out = [];
  for (let i = from; i < to; i++) { register(i); const r = await mesh.addPeer(addrOf(i), urlOf(i), opts); if (r.ok) out.push(r.addr); }
  return out;
}

(async () => {
  console.log('LAWBOR mesh — peerbook, gossip of PEERS, first-hand liveness, bounded fan-out:');

  // =============================== addPeer =========================================================

  await t('addPeer: a gossiped url whose card returns a DIFFERENT addr is refused, peerbook unchanged', async () => {
    const m = mk();
    cards.set('https://impostor.example.com/', { addr: addrOf(999) });     // card says 999…
    const r = await m.addPeer(addrOf(7), 'https://impostor.example.com/', { source: 'gossip' });  // …caller claims 7
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not match/);
    assert.equal(m.addrs().length, 0);
    assert.equal(m.urlFor(addrOf(7)), undefined);
  });

  await t('addPeer FAIL CLOSED: verify() throwing creates no binding (unreachable is never trusted)', async () => {
    const m = mk();
    const r = await m.addPeer(addrOf(8), 'https://unregistered.example.com/', {});   // no card → verify throws
    assert.equal(r.ok, false);
    assert.match(r.reason, /FAIL CLOSED/);
    assert.equal(m.addrs().length, 0);
  });

  await t('addPeer FAIL CLOSED: preflight() throwing means the peer is NOT added (mirrors relay.gate)', async () => {
    const m = mk({ preflight: async () => { throw new Error('mainstreet 503'); } });
    const r = await m.addPeer(addrOf(9), register(9), {});
    assert.equal(r.ok, false);
    assert.match(r.reason, /FAIL CLOSED/);
    assert.equal(m.addrs().length, 0);
  });

  await t("addPeer: PROCEED with score 12 under minScore 40 is refused with a score reason", async () => {
    const m = mk({ preflight: async () => ({ decision: 'PROCEED', score: 12 }) });
    const r = await m.addPeer(addrOf(10), register(10), {});
    assert.equal(r.ok, false);
    assert.match(r.reason, /score 12 < 40/);
    assert.equal(m.addrs().length, 0);
  });

  await t("addPeer FIRST-WRITE-WINS: a gossip rebind is refused and urlFor() still returns the original", async () => {
    const m = mk();
    assert.equal((await m.addPeer(addrOf(11), register(11), {})).ok, true);
    const original = m.urlFor(addrOf(11));
    cards.set('https://hijack.example.com/', { addr: addrOf(11) });        // card even MATCHES — still refused
    const r = await m.addPeer(addrOf(11), 'https://hijack.example.com/', { source: 'gossip' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /already bound/);
    assert.equal(m.urlFor(addrOf(11)), original);
  });

  await t('addPeer: an operator rebind needs confirm:true — without it it is refused exactly like gossip', async () => {
    const m = mk();
    await m.addPeer(addrOf(12), register(12), {});
    register(13); cards.set(urlOf(13), { addr: addrOf(12) });               // new url, same peer addr
    const noConfirm = await m.addPeer(addrOf(12), urlOf(13), { source: 'operator' });
    assert.equal(noConfirm.ok, false);
    assert.match(noConfirm.reason, /already bound/);
    assert.equal(m.urlFor(addrOf(12)), urlOf(12));
    const confirmed = await m.addPeer(addrOf(12), urlOf(13), { source: 'operator', confirm: true });
    assert.equal(confirmed.ok, true);
    assert.equal(m.urlFor(addrOf(12)), urlOf(13));
  });

  await t('addPeer: with maxPeers 16 the 17th distinct candidate is "peerbook full" and evicts NOBODY', async () => {
    const m = mk({ maxPeers: 16 });
    const seeded = await seedPeers(m, 100, 116, {});
    assert.equal(seeded.length, 16);
    assert.equal(m.status().full, true);
    register(116);
    const r = await m.addPeer(addrOf(116), urlOf(116), { source: 'gossip' });
    assert.deepEqual(r, { ok: false, reason: 'peerbook full' });
    assert.equal(m.addrs().length, 16);
    for (const a of seeded) assert.ok(m.has(a), 'established peer ' + a + ' still present');
  });

  await t('addPeer MEMO: 100 attempts on the same addr = 1 preflight inside the TTL, 2 after the clock passes it', async () => {
    let calls = 0;
    const m = mk({ minScore: 40, memoRefuseMs: 15000, preflight: async () => { calls++; return { decision: 'PROCEED', score: 12 }; } });
    register(200);
    for (let i = 0; i < 100; i++) {
      const r = await m.addPeer(addrOf(200), urlOf(200), { source: 'gossip' });
      assert.equal(r.ok, false);                                            // never lands, so it retries the gate
    }
    assert.equal(calls, 1, 'a retry storm must not become an oracle storm');
    NOW += 20000;                                                           // past the SHORTER refusal TTL
    await m.addPeer(addrOf(200), urlOf(200), { source: 'gossip' });
    assert.equal(calls, 2, 'a refusal must expire — a revoked identity is never pinned open');
  });

  // =============================== classifyUrl / isPrivateAddress ==================================

  await t('classifyUrl: a table of 33 hostile urls — every single one is ok:false with a reason', () => {
    const hostile = [
      'https://127.0.0.1/', 'https://localhost/', 'https://bot.localhost/', 'https://[::1]/',
      'https://169.254.169.254/', 'https://10.0.0.5/', 'https://172.16.3.4/', 'https://192.168.1.1/',
      'https://100.64.0.1/', 'https://0.0.0.0/', 'https://2130706433/', 'https://0x7f000001/',
      'https://0177.0.0.1/', 'https://[::]/', 'https://[fe80::1]/', 'https://[fc00::1]/',
      'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:169.254.169.254]/',
      'https://224.0.0.1/', 'https://255.255.255.255/', 'https://198.18.0.1/',
      'https://user:pass@example.com/', 'https://:tok@example.com/',
      'https://example.com:6379/', 'https://example.com:22/',
      'http://example.com/', 'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)',
      'https://example.com/?x=1', 'https://example.com/#f',
      'https://' + 'a'.repeat(300) + '.example.com/',
    ];
    assert.equal(hostile.length, 33);
    for (const u of hostile) {
      const c = classifyUrl(u, {});
      assert.equal(c.ok, false, 'MUST refuse: ' + u);
      assert.ok(typeof c.reason === 'string' && c.reason.length, 'needs a reason: ' + u);
      assert.equal(c.normalized, undefined);
    }
    // the exported predicate the transport's lookup hook reuses
    for (const ip of ['127.0.0.1', '2130706433', '0x7f000001', '::1', '[::1]', 'fe80::1', 'fc00::1', '169.254.169.254'])
      assert.equal(isPrivateAddress(ip), true, ip + ' must be private');
    assert.equal(isPrivateAddress('93.184.216.34'), false);
    assert.equal(isPrivateAddress('example.com'), false);
  });

  await t('classifyUrl: a valid https url round-trips as normalized origin+pathname, and THAT is what urlFor() holds', async () => {
    const c = classifyUrl('https://Bot.Example.COM/lawbor', {});
    assert.equal(c.ok, true);
    assert.equal(c.normalized, 'https://bot.example.com/lawbor');
    const m = mk();
    cards.set('https://bot.example.com/lawbor', { addr: addrOf(21) });
    const r = await m.addPeer(addrOf(21), 'https://Bot.Example.COM/lawbor', {});   // raw, mixed case
    assert.equal(r.ok, true);
    assert.equal(m.urlFor(addrOf(21)), 'https://bot.example.com/lawbor', 'stores the normalized form, never the raw string');
  });

  // =============================== offer (gossip of PEERS) =========================================

  await t('offer: a 50,000-candidate payload yields at most maxPerSource admissions AND maxPerSource preflights', async () => {
    const m = mk({ maxPeers: 64, maxPerSource: 4 });
    const anchorAddr = addrOf(300);
    await m.addPeer(anchorAddr, register(300), {});
    const payload = [];
    for (let i = 0; i < 50000; i++) { register(1000 + i); payload.push({ addr: addrOf(1000 + i), url: urlOf(1000 + i) }); }
    const before = counters();
    const res = await m.offer(anchorAddr, payload);
    const after = counters();
    assert.equal(res.admitted.length, 4);
    assert.equal(after.p - before.p, 4, 'preflight calls bounded by maxPerSource');
    assert.equal(after.v - before.v, 4, 'verify calls bounded by maxPerSource');
    assert.equal(m.addrs().length, 5);
  });

  await t('offer: a payload from an addr that is NOT a peer is refused wholesale — no verify, no preflight', async () => {
    const m = mk();
    register(400);
    const before = counters();
    const res = await m.offer(addrOf(399), [{ addr: addrOf(400), url: urlOf(400) }]);
    const after = counters();
    assert.equal(res.admitted.length, 0);
    assert.equal(res.rejected.length, 1);
    assert.match(res.rejected[0].reason, /not a peer/);
    assert.deepEqual([after.v - before.v, after.p - before.p], [0, 0]);
    assert.equal(m.addrs().length, 0);
  });

  await t("offer: a candidate rebinding a known addr is rejected 'already bound' and NEVER reaches verify", async () => {
    const m = mk();
    const from = addrOf(500);
    await m.addPeer(from, register(500), {});
    await m.addPeer(addrOf(501), register(501), {});
    const original = m.urlFor(addrOf(501));
    cards.set('https://takeover.example.com/', { addr: addrOf(501) });
    const before = counters();
    const res = await m.offer(from, [{ addr: addrOf(501), url: 'https://takeover.example.com/' }]);
    const after = counters();
    assert.equal(res.admitted.length, 0);
    assert.match(res.rejected[0].reason, /already bound/);
    assert.equal(after.v - before.v, 0, 'refused before any network I/O');
    assert.equal(m.urlFor(addrOf(501)), original);
  });

  // =============================== noteContact (first-hand liveness only) ===========================

  await t('noteContact: the record serialises to exactly {url,source,addedAt,lastSeen,fails,learnedFrom} — no status code, latency, body or error', async () => {
    const m = mk();
    await m.addPeer(addrOf(600), register(600), {});
    // an injected transport failure: the caller knows the status code / body — the mesh must not
    try { await (async () => { throw Object.assign(new Error('ECONNREFUSED redis-internal:6379'), { status: 502, body: '<html>oops</html>' }); })(); }
    catch (e) { m.noteContact(addrOf(600), false); }                       // BOOLEAN only, deliberately
    const rec = m.record(addrOf(600));
    assert.deepEqual(Object.keys(rec).sort(), ['addedAt', 'fails', 'lastSeen', 'learnedFrom', 'source', 'url']);
    assert.equal(rec.fails, 1);
    const dump = JSON.stringify(m);
    for (const leak of ['502', 'ECONNREFUSED', 'oops', 'latency', 'redis-internal', '6379'])
      assert.equal(dump.includes(leak), false, 'mesh state leaks "' + leak + '" — that is a port scanner');
    m.noteContact(addrOf(600), true);
    assert.equal(m.record(addrOf(600)).fails, 0);
    assert.equal(m.record(addrOf(600)).lastSeen, NOW);
  });

  // =============================== prune (caller-driven, anchors immune) ===========================

  await t('prune: 3 anchors + 20 gossiped peers, clock advanced past peerTtlMs → exactly the 3 anchors remain', async () => {
    const anchors = [700, 701, 702].map((i) => ({ addr: addrOf(i), url: register(i) }));
    const m = mk({ anchors, maxPeers: 64, peerTtlMs: 1800000 });
    await seedPeers(m, 710, 730, { source: 'gossip', learnedFrom: addrOf(700) });
    assert.equal(m.addrs().length, 23);
    NOW += 1800001;
    const removed = m.prune();
    assert.equal(removed.length, 20);
    assert.deepEqual(m.addrs().sort(), anchors.map((a) => a.addr.toLowerCase()).sort(), 'anchors are never pruned — that is what stops liveness-driven eclipse');
  });

  await t('prune: a gossip payload asserting peer B is dead leaves B; only maxFails FIRST-HAND failures remove it', async () => {
    const m = mk({ maxPeers: 32, maxFails: 3, peerTtlMs: 1e12 });
    const from = addrOf(800);
    await m.addPeer(from, register(800), {});
    const B = addrOf(801);
    await m.addPeer(B, register(801), { source: 'gossip', learnedFrom: from });
    // the payload TRIES to assert death — there is deliberately no such channel
    await m.offer(from, [{ addr: B, url: urlOf(801), dead: true, alive: false, fails: 99 }]);
    assert.ok(m.has(B), 'gossip cannot mark a third party dead');
    assert.equal(m.record(B).fails, 0);
    assert.deepEqual(m.prune(), []);
    m.noteContact(B, false); m.noteContact(B, false);
    assert.deepEqual(m.prune(), [], 'below maxFails, B stays');
    m.noteContact(B, false);
    assert.deepEqual(m.prune(), [B], 'three first-hand failures remove it');
  });

  // =============================== sample (bounded, non-transitive) ================================

  await t('sample: 40 peers (3 anchors, 20 gossip-learned) → ≤3 entries, no anchor, no gossip entry, no timestamps', async () => {
    const anchorIdx = [900, 901, 902];
    const anchors = anchorIdx.map((i) => ({ addr: addrOf(i), url: register(i) }));
    const m = mk({ anchors, maxPeers: 64 });
    const gossiped = await seedPeers(m, 910, 930, { source: 'gossip', learnedFrom: addrOf(900) });   // 20
    const operator = await seedPeers(m, 940, 957, { source: 'operator' });                                                // 17
    assert.equal(m.addrs().length, 40);
    const s = m.sample(3);
    assert.ok(s.length <= 3 && s.length > 0);
    for (const e of s) {
      assert.deepEqual(Object.keys(e).sort(), ['addr', 'url'], 'sample exposes addr+url only');
      assert.equal(anchorIdx.map((i) => addrOf(i).toLowerCase()).includes(e.addr), false, 'anchors are hidden');
      assert.equal(gossiped.includes(e.addr), false, 'never launder another node\'s binding onward');
      assert.ok(operator.includes(e.addr));
    }
    assert.equal(JSON.stringify(s).includes('lastSeen'), false);
  });

  await t('sample: two consecutive calls with the injected rng return different subsets', async () => {
    const m = mk({ maxPeers: 64 });
    await seedPeers(m, 1_000_000, 1_000_030, { source: 'operator' });
    let differed = false;
    for (let i = 0; i < 20 && !differed; i++) {
      const a = JSON.stringify(m.sample(3).map((e) => e.addr).sort());
      const b = JSON.stringify(m.sample(3).map((e) => e.addr).sort());
      if (a !== b) differed = true;
    }
    assert.equal(differed, true, 'sample must not be a fixed prefix of the table');
  });

  // =============================== selectTargets (bounded fan-out) =================================

  await t('selectTargets: 50 peers, destination NOT a peer → length ≤ fanout and never opts.notFrom', async () => {
    const m = mk({ maxPeers: 64, fanout: 3 });
    const peers = await seedPeers(m, 1_100_000, 1_100_050, {});
    assert.equal(peers.length, 50);
    const notFrom = peers[7];
    for (let i = 0; i < 50; i++) {
      const targets = m.selectTargets(addrOf(2_000_000), { notFrom });
      assert.ok(targets.length <= 3, 'amplification is a constant, not a function of table size');
      assert.equal(targets.includes(notFrom), false, 'never bounce an envelope back to its source');
    }
  });

  await t('selectTargets: a destination that IS a direct peer resolves to exactly [dest]', async () => {
    const m = mk({ maxPeers: 64, fanout: 3 });
    await seedPeers(m, 1_200_000, 1_200_010, {});
    const dest = addrOf(1_200_005);
    assert.deepEqual(m.selectTargets(dest), [dest.toLowerCase()]);
    assert.deepEqual(m.selectTargets(dest.toUpperCase().replace('0X', '0x')), [dest.toLowerCase()]);
  });

  // =============================== createMesh / status =============================================

  await t('createMesh: empty mesh → addrs() [] and bootstrapDependent false; a peer learned from an anchor flips it true', async () => {
    const bare = mk();
    assert.deepEqual(bare.addrs(), []);
    assert.equal(bare.status().bootstrapDependent, false);

    const anchorAddr = addrOf(1300);
    const m = mk({ anchors: [{ addr: anchorAddr, url: register(1300) }] });
    assert.equal(m.status().anchors, 1);
    assert.equal(m.status().bootstrapDependent, false, 'anchors alone are not a transitive dependence');
    register(1301);
    const res = await m.offer(anchorAddr, [{ addr: addrOf(1301), url: urlOf(1301) }]);
    assert.deepEqual(res.admitted, [addrOf(1301).toLowerCase()]);
    assert.equal(m.status().bootstrapDependent, true, 'every non-anchor peer traces back to an operator-typed seed — say so, do not hide it');

    // guards, in the createRelay/createNode idiom
    assert.throws(() => createMesh({ self: 'nope', preflight, verify }), /0x address/);
    assert.throws(() => createMesh({ self: SELF, verify }), /preflight required/);
    assert.throws(() => createMesh({ self: SELF, preflight }), /verify\(url\) required/);
  });

  // =============================== repo guard ======================================================

  await t('repo guard: lib/mesh.js has no url literal, no http/https/net/dns require, no fetch — and no imports at all', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh.js'), 'utf8');
    const banned = /https?:\/\/|require\('(http|https|net|dns)'\)|fetch\(/;
    const hit = src.match(banned);
    assert.equal(hit, null, 'banned pattern found: ' + (hit && hit[0]));
    assert.equal(/require\s*\(/.test(src), false, 'mesh.js must import NOTHING — no token module, no transport');
    for (const g of ['XMLHttpRequest', 'WebSocket', 'setInterval', 'setTimeout', 'process.env'])
      assert.equal(src.includes(g), false, 'mesh.js must not reference ' + g + ' (no timers, no ambient config)');
  });

  /* ============================================================================================
   * ADVERSARIAL REGRESSIONS — every case below was a CONFIRMED bypass, demonstrated by three
   * independent skeptics running code against the first version of this file (2026-07-18).
   * The common root of the two critical ones: the guards ran BEFORE an await, so concurrent
   * callers all saw the same pre-await state. Slots are now reserved synchronously.
   * ========================================================================================== */
  const PEER = '0x' + 'be'.repeat(20);
  const okPre = async () => ({ decision: 'PROCEED', score: 90 });
  const addrN = (i) => '0x' + String(i).padStart(2, '0').repeat(20);

  await t('TOCTOU: 20 concurrent admissions cannot overrun a maxPeers:2 book', async () => {
    const m = createMesh({ self: SELF, maxPeers: 2, preflight: okPre,
      verify: async (u) => ({ addr: '0x' + u.match(/p([0-9a-f]{40})/)[1] }) });
    await Promise.all(Array.from({ length: 20 }, (_, i) => addrN(i + 10))
      .map((a) => m.addPeer(a, 'https://h.example/p' + a.slice(2), { source: 'gossip' })));
    assert.equal(m.addrs().length, 2, 'the never-evict cap holds under concurrency');
  });

  await t('TOCTOU: a concurrent gossip rebind cannot displace an operator binding', async () => {
    const m = createMesh({ self: SELF, maxPeers: 8, preflight: okPre, verify: async () => ({ addr: PEER }) });
    await Promise.all([
      m.addPeer(PEER, 'https://honest.example/x', { source: 'operator' }),
      m.addPeer(PEER, 'https://attacker.example/x', { source: 'gossip' }),
    ]);
    assert.equal(m.urlFor(PEER), 'https://honest.example/x', 'first write wins even interleaved');
  });

  await t('a reservation is not routable until verify + preflight have both passed', async () => {
    let release; const held = new Promise((r) => { release = r; });
    const m = createMesh({ self: SELF, preflight: okPre, verify: async () => { await held; return { addr: PEER }; } });
    const inflight = m.addPeer(PEER, 'https://slow.example/x', { source: 'operator' });
    assert.deepEqual(m.addrs(), [], 'an unverified peer is never advertised');
    assert.equal(m.urlFor(PEER), undefined, 'and never resolvable by the transport');
    release(); await inflight;
    assert.deepEqual(m.addrs(), [PEER.toLowerCase()], 'and appears once verified');
  });

  await t('a failed operator rebind RESTORES the previous binding instead of destroying it', async () => {
    let calls = 0;
    const m = createMesh({ self: SELF, preflight: okPre,
      verify: async () => { calls++; if (calls > 1) throw new Error('unreachable'); return { addr: PEER }; } });
    await m.addPeer(PEER, 'https://good.example/x', { source: 'operator' });
    const r = await m.addPeer(PEER, 'https://new.example/x', { source: 'operator', confirm: true });
    assert.equal(r.ok, false);
    assert.equal(m.urlFor(PEER), 'https://good.example/x', 'a working peer survives a failed rebind');
  });

  await t('opts.source defaults to the UNPRIVILEGED value — an omitted source is gossip, not operator', async () => {
    const m = createMesh({ self: SELF, preflight: okPre, verify: async () => ({ addr: PEER }) });
    await m.addPeer(PEER, 'https://x.example/a');
    assert.deepEqual(m.sample(3), [], 'a source-less peer is not laundered onward as ours');
  });

  await t('SSRF: every form the panel got through is now refused', () => {
    const bypasses = [
      'https://localhost./x',              // trailing dot defeated the $ anchor
      'https://[::ffff:7f00:1]/x',          // IPv4-mapped, hextet form
      'https://[0:0:0:0:0:0:7f00:1]/x',     // fully expanded loopback
      'https://[::127.0.0.1]/x',            // IPv4-compatible
      'https://[64:ff9b::127.0.0.1]/x',     // NAT64
      'https://[2002:7f00:1::]/x',          // 6to4
      'https://[fec0::1]/x',                // site-local
    ];
    for (const u of bypasses) {
      const c = classifyUrl(u);
      assert.equal(c.ok, false, u + ' must be refused');
    }
  });

  await 
t('allowPrivate opens RFC1918 LAN for cross-machine testing — but NEVER cloud metadata', () => {
  const lan = { allowInsecure: true, allowPrivate: true };
  assert.equal(classifyUrl('http://192.168.1.42:4830/', lan).ok, true, 'a LAN peer is reachable in LAN-test mode');
  assert.equal(classifyUrl('http://10.0.0.5:4830/', lan).ok, true, '10/8 too');
  assert.equal(classifyUrl('http://169.254.169.254/', lan).ok, false, 'cloud metadata STAYS refused even in LAN mode');
  assert.equal(classifyUrl('http://192.168.1.42:4830/', { allowInsecure: true }).ok, false, 'without allowPrivate, LAN is refused (default SSRF protection)');
});

t('isPrivateAddress agrees with classifyUrl — the transport hook cannot fail open', () => {
    for (const ip of ['::ffff:7f00:1', '0:0:0:0:0:0:7f00:1', '::127.0.0.1', '64:ff9b::127.0.0.1', '2002:7f00:1::', 'fec0::1']) {
      assert.equal(isPrivateAddress(ip), true, ip + ' must be private to the exported predicate too');
    }
    assert.equal(isPrivateAddress('2606:4700::1111'), false, 'a real public v6 address still passes');
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
