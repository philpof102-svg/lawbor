'use strict';
// LAWBOR HTTP surface — TWO bots on 127.0.0.1 actually talking to each other over the real transport.
// Proves the whole agent↔agent↔human loop: A's human says something → A relays over HTTP → B's relay
// reputation-gates it → it lands in B's human inbox; B's bot answers autonomously → shows in A's watch feed.
// Run: node test/server.test.js
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
const assert = require('node:assert');
const { build: makeBuild } = require('../server');
// Same as node.test.js: these predate signature verification and opt into the unauthenticated path.
// Two real HTTP servers on 127.0.0.1 with random ports: the mesh's url policy correctly refuses
// loopback and non-80/443 ports in production, so a local end-to-end test must opt into the
// loopback escape explicitly. It stays a REAL test: the discovery card is genuinely fetched over
// HTTP and mesh admission runs for real — only the address range is exempted.
const build = (deps) => makeBuild({ allowUnauthenticated: true, allowLoopback: true, allowInsecure: true, ...deps });
const { createStore } = require('../lib/store');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const dbA = path.join(os.tmpdir(), 'lawbor-srvA-' + process.pid + '.jsonl');
const dbB = path.join(os.tmpdir(), 'lawbor-srvB-' + process.pid + '.jsonl');
const proceed = async () => ({ decision: 'PROCEED', score: 75 });
const avoid = async () => ({ decision: 'AVOID', score: 2 });

const post = async (base, p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

(async () => {
  console.log('LAWBOR HTTP — two bots, real transport, human↔agent↔agent↔human:');

  const botA = build({ self: A, human: 'phil', preflight: proceed, store: createStore(dbA) });
  const botB = build({ self: B, human: 'bob', preflight: proceed, store: createStore(dbB) });
  await new Promise((r) => botA.server.listen(0, r));
  await new Promise((r) => botB.server.listen(0, r));
  const urlA = 'http://127.0.0.1:' + botA.server.address().port;
  const urlB = 'http://127.0.0.1:' + botB.server.address().port;

  await t('discovery: /.well-known/lawbor.json advertises addr + accept + minScore', async () => {
    const r = await get(urlA, '/.well-known/lawbor.json');
    assert.equal(r.status, 200); assert.equal(r.body.addr.toLowerCase(), A.toLowerCase());
    assert.equal(r.body.accept, '/lawbor/accept'); assert.ok(r.body.minScore >= 0);
  });
  await t('peering: each bot registers the other (addr → url routing)', async () => {
    assert.equal((await post(urlA, '/peers', { addr: B, url: urlB })).status, 200);
    assert.equal((await post(urlB, '/peers', { addr: A, url: urlA })).status, 200);
    assert.equal((await get(urlA, '/health')).body.peers, 1);
  });

  await t('HUMAN→AGENT→AGENT→HUMAN: phil says it, it lands in bob\'s inbox over real HTTP', async () => {
    const r = await post(urlA, '/say', { to: B, body: 'gm bob — phil here' });
    assert.equal(r.status, 200); assert.equal(r.body.delivered, true);
    assert.equal(r.body.sign.signed, false, 'still descriptor-only: the operator signs');
    await new Promise((s) => setTimeout(s, 120));                 // let the transport land
    const inbox = await get(urlB, '/inbox');
    assert.ok(inbox.body.threads.some((th) => th.last.includes('phil here')), "bob's INBOX has it");
    const watch = await get(urlB, '/bot-activity');
    assert.ok(!watch.body.threads.some((th) => th.last.includes('phil here')), 'not in the bot feed — a human wrote it');
  });

  await t("AGENT→AGENT autonomous: bob's bot answers; it shows in phil's WATCH feed, not his inbox", async () => {
    const r = await post(urlB, '/bot/say', { to: A, body: 'bot: availability synced, 2 slots open' });
    assert.equal(r.status, 200); assert.equal(r.body.delivered, true);
    await new Promise((s) => setTimeout(s, 120));
    const watch = await get(urlA, '/bot-activity');
    assert.ok(watch.body.threads.some((th) => th.last.includes('availability synced')), "phil WATCHES his bot's peer chat");
    const inbox = await get(urlA, '/inbox');
    assert.ok(!inbox.body.threads.some((th) => th.last.includes('availability synced')), 'bot chatter stays out of the human inbox');
  });

  await t('thread view: the full conversation is readable by id', async () => {
    const inbox = await get(urlB, '/inbox');
    const id = inbox.body.threads[0].thread;
    const th = await get(urlB, '/thread?id=' + encodeURIComponent(id));
    assert.equal(th.status, 200); assert.ok(th.body.messages.length >= 1);
  });

  await t('REPUTATION GATE over HTTP: a bot that MainStreet rejects gets 202-dropped, nothing stored', async () => {
    const botC = build({ self: A, preflight: avoid, store: createStore(path.join(os.tmpdir(), 'lawbor-srvC-' + process.pid + '.jsonl')) });
    await new Promise((r) => botC.server.listen(0, r));
    const urlC = 'http://127.0.0.1:' + botC.server.address().port;
    const { buildEnvelope } = require('../lib/envelope');
    const env = buildEnvelope({ from: B, to: A, body: 'spam', viaHuman: 'x' }).envelope;
    const r = await post(urlC, '/lawbor/accept', { envelope: env });
    assert.equal(r.status, 202); assert.equal(r.body.action, 'drop');
    assert.equal((await get(urlC, '/inbox')).body.threads.length, 0, 'nothing stored');
    botC.server.close();
  });

  await t('input guards: /say without to+body → 400; unknown route → 404', async () => {
    assert.equal((await post(urlA, '/say', { body: 'x' })).status, 400);
    assert.equal((await get(urlA, '/nope')).status, 404);
  });

  /* ---- the peer layer is WIRED, and must stay wired ------------------------------------------
   * POST /peers used to write straight into a bare Map with no checks, which made every defence in
   * mesh.js decorative. These pin the gated path so a later refactor cannot quietly reopen it. */
  await t('POST /peers refuses a url whose discovery card names a DIFFERENT addr', async () => {
    const C = '0x' + 'cc'.repeat(20);
    const r = await post(urlA, '/peers', { addr: C, url: urlB });      // B's card says B, not C
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /does not match/);
    assert.ok(!r.body.peers.includes(C.toLowerCase()), 'and nothing was admitted');
  });

  await t('POST /peers refuses a private / metadata url even with the loopback escape on', async () => {
    const r = await post(urlA, '/peers', { addr: '0x' + 'dd'.repeat(20), url: 'http://169.254.169.254' });
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /private|refused/);
  });

  await t('POST /peers is FIRST-WRITE-WINS over HTTP — an established peer cannot be rebound', async () => {
    const r = await post(urlA, '/peers', { addr: B, url: 'http://127.0.0.1:1' });
    assert.equal(r.body.ok, false);
    assert.match(r.body.reason, /already bound/);
  });

  await t('GET /lawbor/peers discloses a BOUNDED sample, never the whole table', async () => {
    const r = await get(urlA, '/lawbor/peers');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.peers) && r.body.peers.length <= 3);
    for (const p of r.body.peers) {
      assert.deepEqual(Object.keys(p).sort(), ['addr', 'url'], 'no lastSeen/fails/timestamps leak');
    }
  });

  await t('the relay no longer keeps its own peerbook — addPeer is refused when delegated', () => {
    assert.equal(botA.node.relay.addPeer('0x' + 'ee'.repeat(20)), false,
      'an ungated side-door into the peer set must not exist');
    assert.deepEqual(botA.node.peers(), botA.mesh.addrs(), 'relay and transport read ONE book');
  });

  botA.server.close(); botB.server.close();
  for (const f of [dbA, dbB]) { try { fs.unlinkSync(f); } catch {} }

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

