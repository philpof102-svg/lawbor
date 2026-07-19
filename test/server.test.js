'use strict';
// LAWBOR HTTP surface — TWO bots on 127.0.0.1 actually talking to each other over the real transport.
// Proves the whole agent↔agent↔human loop: A's human says something → A relays over HTTP → B's relay
// reputation-gates it → it lands in B's human inbox; B's bot answers autonomously → shows in A's watch feed.
// Run: node test/server.test.js
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
/* unique par CONSTRUCTION: un pid n est pas un id de run (Windows les recycle), et un nom
 * reutilise fait heriter le store du run precedent. Voir test/consent.test.js pour l enquete. */
const LAWBOR_TMP = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lawbor-t-"));
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
const dbA = path.join(LAWBOR_TMP, 'srvA.jsonl');
const dbB = path.join(LAWBOR_TMP, 'srvB.jsonl');
/* START FROM EMPTY, and clean the CONTROL log too.
 * A pid is not a unique run id — Windows recycles them — and the teardown at the bottom of this file
 * only unlinks the .jsonl, never the sibling .control that holds CONSENT. So an accepted-sender row
 * could outlive its run and be inherited by a later one that drew the same pid, at which point "first
 * contact lands in REQUESTS" is testing a contact that is no longer first. Measured: 318 stale
 * lawbor-srv*.control files had accumulated in the temp dir on this machine.
 * Honest limit: seeding that exact file for the exact pid did NOT reproduce the intermittent failure
 * this file showed once, so this is a real defect but NOT a proven diagnosis of that one. Fixed because
 * it is wrong on its own terms, not because it closes the case. */
for (const f of [dbA, dbB, dbA + '.control', dbB + '.control', dbA + '.subs', dbB + '.subs']) {
  try { fs.unlinkSync(f); } catch { /* absent is the normal case */ }
}
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

  /* POLL, don't sleep. These waits were `setTimeout(120)` — a wall-clock race that an external tester
   * fingered as the likeliest cause of the intermittent red on their machine: 120ms of loopback + fetch
   * is comfortable here and can be exceeded there under AV/GC/EDR. Polling until the condition holds (or
   * a generous budget expires) is deterministic AND faster in the common case — it returns the instant
   * the transport lands instead of always paying the fixed delay. */
  const until = async (fn, budgetMs = 3000, stepMs = 15) => {
    const deadline = Date.now() + budgetMs;
    for (;;) { if (await fn()) return true; if (Date.now() > deadline) return false; await new Promise((s) => setTimeout(s, stepMs)); }
  };

  await t('HUMAN→AGENT→AGENT→HUMAN first contact lands in bob\'s REQUESTS (consent), then accept → inbox', async () => {
    const r = await post(urlA, '/say', { to: B, body: 'gm bob — phil here' });
    assert.equal(r.status, 200); assert.equal(r.body.delivered, true);
    assert.equal(r.body.sign.signed, false, 'still descriptor-only: the operator signs');
    // phil is a stranger to bob → quarantined in Requests, NOT the inbox (the consent gate)
    const landed = await until(async () => (await get(urlB, '/requests')).body.threads.some((th) => th.last.includes('phil here')));
    assert.ok(landed, "bob's REQUESTS has it");
    assert.ok(!(await get(urlB, '/inbox')).body.threads.some((th) => th.last.includes('phil here')), 'NOT yet in the inbox');
    assert.ok(!(await get(urlB, '/bot-activity')).body.threads.some((th) => th.last.includes('phil here')), 'not the bot feed — a human wrote it');
    // bob accepts phil → promoted to the inbox
    assert.equal((await post(urlB, '/accept', { addr: A })).status, 200);
    assert.ok((await get(urlB, '/inbox')).body.threads.some((th) => th.last.includes('phil here')), "now in bob's INBOX");
  });

  await t("AGENT→AGENT autonomous: bob's bot answers; it shows in phil's WATCH feed, not his inbox", async () => {
    const r = await post(urlB, '/bot/say', { to: A, body: 'bot: availability synced, 2 slots open' });
    assert.equal(r.status, 200); assert.equal(r.body.delivered, true);
    const seen = await until(async () => (await get(urlA, '/bot-activity')).body.threads.some((th) => th.last.includes('availability synced')));
    assert.ok(seen, "phil WATCHES his bot's peer chat");
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
    const botC = build({ self: A, preflight: avoid, store: createStore(path.join(LAWBOR_TMP, 'srvC.jsonl')) });
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

  await t('a DELIBERATE refusal is a 400, not a 500 — a body too long is the client\'s fault, not a crash', async () => {
    // buildEnvelope throws "body exceeds 8192 chars"; that used to surface as HTTP 500, telling the
    // caller the SERVER broke — which makes an autopilot retry a request that can never succeed.
    const r = await post(urlA, '/say', { to: B, body: 'x'.repeat(9000) });
    assert.equal(r.status, 400, 'over-long body is a 400');
    assert.match(r.body.error, /exceeds/);
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

  await t('blocking gives a block a NETWORK effect: a blocked peer is not gossiped, but its relay is untouched', async () => {
    const { buildEnvelope } = require('../lib/envelope');
    // B is A's peer here. A vouches for B in peer-exchange...
    assert.ok((await get(urlA, '/lawbor/peers')).body.peers.some((p) => p.addr.toLowerCase() === B.toLowerCase()), 'B is gossiped before the block');
    assert.equal((await post(urlA, '/block', { addr: B })).status, 200);
    // ...after blocking B, A stops recommending B to others (a widely-blocked addr falls out of discovery)
    assert.ok(!(await get(urlA, '/lawbor/peers')).body.peers.some((p) => p.addr.toLowerCase() === B.toLowerCase()), 'B is NOT gossiped after the block');
    // ...but A still RELAYS B's traffic to third parties — a block is CONTACT, not network censorship
    const fwd = await botA.node.relay.accept(buildEnvelope({ from: B, to: '0x' + 'cc'.repeat(20), body: 'route me' }).envelope);
    assert.equal(fwd.action, 'forward', 'relay of a blocked sender is deliberately unaffected — else a personal block censors the mesh');
    await post(urlA, '/unblock', { addr: B });   // restore state for any later assertions
  });

  await t('the relay no longer keeps its own peerbook — addPeer is refused when delegated', () => {
    assert.equal(botA.node.relay.addPeer('0x' + 'ee'.repeat(20)), false,
      'an ungated side-door into the peer set must not exist');
    assert.deepEqual(botA.node.peers(), botA.mesh.addrs(), 'relay and transport read ONE book');
  });

  await t('blocking hides a sender\'s ALREADY-STORED job from /jobs (not just future ones)', async () => {
    const { buildWork } = require('../lib/work');
    const { buildEnvelope } = require('../lib/envelope');
    const P = '0x' + 'da'.repeat(20);                              // a peer whose job is already stored
    botA.node.store.record(buildEnvelope({ from: P, to: A, body: buildWork('help_wanted', { jobId: 'stored-job', task: 'x' }), viaHuman: null }).envelope, { origin: 'bot', dir: 'in' });
    assert.ok((await get(urlA, '/jobs')).body.jobs.some((j) => j.jobId === 'stored-job'), 'visible before the block');
    assert.equal((await post(urlA, '/block', { addr: P })).status, 200);
    assert.ok(!(await get(urlA, '/jobs')).body.jobs.some((j) => j.jobId === 'stored-job'), 'gone after the block — a blocked address is invisible in /jobs too');
  });

  /* ---- the MCP surface must be reachable OVER HTTP -------------------------------------------
   * Both routes returned 500 "mcpDispatch is not defined" for weeks: server.js never required
   * ./mcp. The suite missed it because test/mcp.test.js imports ../mcp directly and never went
   * through the server. A discovery card advertising tools that 500 is a false capability claim
   * aimed at AGENTS, which makes it worse than a broken page. These go through fetch on purpose. */
  await t('POST /mcp answers tools/list over HTTP (not just via a direct import)', async () => {
    const r = await post(urlA, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.result.tools) && r.body.result.tools.length >= 6);
    assert.ok(r.body.result.tools.some((x) => x.name === 'lawbor_whoami'));
  });

  await t('POST /mcp initialize + a real tool call both work over HTTP', async () => {
    const init = await post(urlA, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init.body.result.protocolVersion, '2024-11-05');
    const call = await post(urlA, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lawbor_whoami', arguments: {} } });
    assert.equal(call.status, 200);
    assert.ok(!call.body.error, 'whoami must not error: ' + JSON.stringify(call.body.error));
  });

  await t('GET /.well-known/mcp.json serves a real card, and every tool it lists exists', async () => {
    const r = await get(urlA, '/.well-known/mcp.json');
    assert.equal(r.status, 200);
    assert.equal(r.body.mcp.transport, 'streamable-http');
    const listed = r.body.tools.map((x) => x.name);
    const live = (await post(urlA, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((x) => x.name);
    assert.deepEqual(listed.sort(), live.sort(), 'the card must not advertise tools the server does not have');
  });

  await t('premium: signed caller auth gates access over HTTP; a forged signature is refused', async () => {
    const { apps } = require('../apps/example');
    const WALLET = '0x' + '99'.repeat(20), PAYER = '0x' + 'b1'.repeat(20);
    const botP = build({ self: A, preflight: proceed, store: createStore(path.join(LAWBOR_TMP, 'prem.jsonl')),
      apps, payTo: WALLET, x402verify: async (p) => ({ ok: true, payer: p.payer, amountUsdc: 5 }),
      verifyAuth: async ({ sig }) => ({ ok: /^0x[0-9a-f]{40}$/i.test(sig), signer: sig }) });   // stub: sig IS the signer
    await new Promise((r) => botP.server.listen(0, r));
    const purl = 'http://127.0.0.1:' + botP.server.address().port;
    assert.equal((await get(purl, '/apps')).body.premium.authenticatesCaller, true, 'the node advertises it authenticates callers');
    assert.equal((await get(purl, '/app/vault/latest')).status, 402, 'no subscription → 402');
    await post(purl, '/x402/settle', { payment: { payer: PAYER } });
    const good = await fetch(purl + '/app/vault/latest', { headers: { 'x-lawbor-auth': PAYER + ':' + PAYER } });
    assert.equal(good.status, 200, 'a subscribed payer who PROVES their address (valid sig) is served');
    const forged = await fetch(purl + '/app/vault/latest', { headers: { 'x-lawbor-auth': PAYER + ':0x' + 'ee'.repeat(20) } });
    assert.equal(forged.status, 402, 'claiming the payer address but signing with another key is refused');
    botP.server.close();
  });

  // Operator-only local controls: a REMOTE caller (non-loopback, unsigned) must NOT be able to wipe or
  // mutate the operator's node. /delete is irreversible, so this closes a remote store-wipe. Loopback
  // (the desktop pod, and every existing test above over 127.0.0.1) stays allowed — proven by those
  // tests returning 200. Here we drive the real request handler with a spoofed remote socket.
  await t('operator controls refuse a REMOTE unsigned caller (401), loopback still allowed', async () => {
    const handler = botA.server.listeners('request')[0];
    const call = (remoteAddress, url, payload) => new Promise((resolve) => {
      const req = { method: 'POST', url, headers: { 'content-type': 'application/json' }, socket: { remoteAddress },
        on(ev, cb) { if (ev === 'data') cb(JSON.stringify(payload)); if (ev === 'end') cb(); }, destroy() {} };
      const res = { statusCode: 0, writeHead(c) { this.statusCode = c; }, end() { resolve(this.statusCode); } };
      handler(req, res);
    });
    assert.equal(await call('203.0.113.7', '/delete', { id: 'x' }), 401, 'remote /delete is refused (no store-wipe)');
    assert.equal(await call('203.0.113.7', '/block', { addr: B }), 401, 'remote /block is refused');
    assert.equal(await call('127.0.0.1', '/delete', { id: 'nope' }), 200, 'loopback /delete is allowed (id just not found)');
  });

  /* THE DEPENDENCY MUST STAY VISIBLE. Admission calls one HTTP oracle for every inbound envelope, and
   * the shipped default is a service WE run — so a node that does not disclose it is asking its operator
   * to trust a third party they were never told about. /health carried no mention of the oracle at all
   * until this was added; the discovery card gave the bare name "MainStreet" with no URL and no owner.
   * This test exists so the field cannot quietly disappear again. */
  await t('/health DISCLOSES the admission oracle — the one external dependency that can stop this node', async () => {
    const h = (await get(urlA, '/health')).body;
    assert.ok(h.admissionOracle, 'the oracle must appear in the node\'s own status');
    assert.equal(typeof h.admissionOracle.operatedByUs, 'boolean', 'and say plainly whose it is');
    assert.ok(String(h.admissionOracle.note || '').length > 20, 'with the consequence spelled out, not just a flag');
  });

  await t('GET /skill.md serves the installable agent-org skill (markdown)', async () => {
    const r = await fetch(urlA + '/skill.md');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /markdown/);
    const md = await r.text();
    assert.ok(md.includes('run-a-lawbor-org') && md.includes('lawbor_graph'), 'the skill names itself + the graph tool');
  });

  botA.server.close(); botB.server.close();
  // symmetric with the setup: the control and subs siblings are cleaned too. Teardown alone was never
  // enough anyway — a run that crashes or is killed never reaches this line, which is exactly how the
  // stale files accumulated. Starting from empty is what actually guarantees it; this just tidies.
  for (const f of [dbA, dbB, dbA + '.control', dbB + '.control', dbA + '.subs', dbB + '.subs']) {
    try { fs.unlinkSync(f); } catch {}
  }

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

