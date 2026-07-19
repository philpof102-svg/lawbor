'use strict';
// LAWBOR chain reader + the settle→credit path, driven END TO END over real HTTP against a fake Base RPC.
// A string-pinned check would pass while the wiring was broken, so this drives the actual routes: post a
// job, award it, settle it with a tx the fake chain really serves, and read /credit.
// Run: node test/chain.test.js
const assert = require('node:assert');
/* unique par CONSTRUCTION: un pid n est pas un id de run (Windows les recycle), et un nom
 * reutilise fait heriter le store du run precedent. Voir test/consent.test.js pour l enquete. */
const LAWBOR_TMP = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lawbor-t-"));
const { createChainReader, TRANSFER_TOPIC, USDC_BASE } = require('../lib/chain');
const { build } = require('../server');
const { createStore } = require('../lib/store');
const path = require('node:path'), fs = require('node:fs');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const REQ = '0x' + '11'.repeat(20), WORKER = '0x' + '22'.repeat(20);
const TX = '0x' + 'ab'.repeat(32);
const topicOf = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const hx = (n) => '0x' + n.toString(16);

/** A fake Base RPC. `over` lets each test bend one fact and watch the reader refuse. */
function fakeRpc(over = {}) {
  const o = { chainId: 8453, status: 1, blockNumber: 100, head: 120, valueMicro: 500000000n,
    token: USDC_BASE, from: REQ, to: WORKER, extraTransfer: false, ...over };
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const result = (r) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', result: r }) });
    if (method === 'eth_chainId') return result(hx(o.chainId));
    if (method === 'eth_blockNumber') return result(hx(o.head));
    if (method === 'eth_getBlockByNumber') return result({ timestamp: hx(1700000000) });
    if (method === 'eth_getTransactionReceipt') {
      if (params[0] !== TX) return result(null);
      const log = { address: o.token, topics: [TRANSFER_TOPIC, topicOf(o.from), topicOf(o.to)], data: '0x' + o.valueMicro.toString(16) };
      const logs = [log];
      if (o.extraTransfer) logs.push({ ...log, data: '0x' + (1n).toString(16) });   // a 2nd USDC transfer
      return result({ status: hx(o.status), blockNumber: hx(o.blockNumber), logs });
    }
    return result(null);
  };
}

(async () => {
  console.log('LAWBOR chain reader — it refuses rather than guesses:');

  await t('reads a real USDC transfer into an immutable fact', async () => {
    const f = await createChainReader({ rpcUrl: 'http://rpc', fetch: fakeRpc() }).checkTx(TX);
    assert.equal(f.from, REQ.toLowerCase()); assert.equal(f.to, WORKER.toLowerCase());
    assert.equal(f.valueMicro, '500000000'); assert.equal(f.chainId, 8453);
    assert.equal(f.confirmations, 21, 'head 120 - block 100 + 1');
  });

  await t('WRONG CHAIN: an RPC that is not Base verifies NOTHING (the mis-pointed-url kill)', async () => {
    // pointing at Ethereum would otherwise "verify" a different token on a different chain
    assert.equal(await createChainReader({ rpcUrl: 'http://rpc', fetch: fakeRpc({ chainId: 1 }) }).checkTx(TX), null);
  });

  await t('a REVERTED tx settles nothing', async () => {
    assert.equal(await createChainReader({ rpcUrl: 'http://rpc', fetch: fakeRpc({ status: 0 }) }).checkTx(TX), null);
  });

  await t('AMBIGUOUS: two USDC transfers in one tx → refuse, never pick one', async () => {
    assert.equal(await createChainReader({ rpcUrl: 'http://rpc', fetch: fakeRpc({ extraTransfer: true }) }).checkTx(TX), null);
  });

  await t('a non-USDC token transfer is not a settlement', async () => {
    assert.equal(await createChainReader({ rpcUrl: 'http://rpc', fetch: fakeRpc({ token: '0x' + '99'.repeat(20) }) }).checkTx(TX), null);
  });

  await t('unknown tx / malformed hash / no reader at all → null (fail closed)', async () => {
    const r = createChainReader({ rpcUrl: 'http://rpc', fetch: fakeRpc() });
    assert.equal(await r.checkTx('0x' + 'cd'.repeat(32)), null);
    assert.equal(await r.checkTx('0xnope'), null);
    assert.equal(createChainReader({}), null, 'unconfigured reader is null, not a permissive stub');
  });

  // ---------------------------------------------------------------------------------------------
  console.log('\nLAWBOR settle → credit, driven over real HTTP:');

  const base = path.join(LAWBOR_TMP, 'chain');
  const facts = base + '.txfacts';
  for (const f of [base + '.jsonl', base + '.control', base + '.subs', facts]) { try { fs.unlinkSync(f); } catch {} }
  const store = createStore(base + '.jsonl', base + '.control');
  const built = build({
    self: REQ, store, txFactsFile: facts,
    preflight: async () => ({ decision: 'PROCEED', score: 90 }),
    chain: createChainReader({ rpcUrl: 'http://rpc', fetch: fakeRpc() }),
    allowLoopback: true, allowInsecure: true, allowUnauthenticated: true,
  });
  await new Promise((r) => built.server.listen(0, r));
  const port = built.server.address().port;
  const post = (p, b) => fetch(`http://localhost:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const get = (p) => fetch(`http://localhost:${port}${p}`).then((r) => r.json());

  await t('/health reports verifiesSettlements — a node that cannot check must not look like it can', async () => {
    const v = (await get('/health')).verifiesSettlements;
    // It used to be `!!chain` — TRUE as soon as a url and a fetch existed, which says nothing about
    // Base. Now it is a PROBE, and the shape carries the reason when it cannot verify, because
    // "cannot check" must never be indistinguishable from "checked and fine".
    assert.equal(v.verifying, true, 'this rig injects a working reader');
    assert.equal(v.chainId, 8453);
  });

  await t('a job settles only when the chain agrees, and /credit then shows what WE paid', async () => {
    await post('/work', { to: WORKER, kind: 'help_wanted', jobId: 'idx', task: 'index a contract', as: 'human' });
    await post('/work', { to: WORKER, kind: 'award', jobId: 'idx', worker: WORKER, price: '500 USDC' });
    let before = await get('/credit');
    assert.equal(before.direct.length, 0, 'an award alone confers NOTHING — awarded is not paid');

    const s = await post('/work', { to: WORKER, kind: 'settle', jobId: 'idx', txHash: TX, amountMicro: '500000000' });
    assert.equal(s.settled.verified, true, 'the fake chain serves this tx, so it verifies: ' + JSON.stringify(s.settled));

    const jobs = await get('/jobs');
    assert.equal(jobs.jobs.find((j) => j.jobId === 'idx').state, 'settled');

    const c = await get('/credit');
    assert.equal(c.direct.length, 1);
    assert.equal(c.direct[0].addr, WORKER.toLowerCase());
    assert.equal(c.direct[0].usdcMicro, '500000000', 'the viewer paid 500 USDC, so that is the standing');
    assert.ok(c.limits.some((l) => /no global score/.test(l)), 'the limits ship WITH the number');
    assert.equal(c.evidence[0].txHash, TX, 'and the evidence is re-verifiable by the reader');
  });

  await t('a settle whose AMOUNT does not match the chain confers nothing', async () => {
    await post('/work', { to: WORKER, kind: 'help_wanted', jobId: 'liar', task: 'x', as: 'human' });
    await post('/work', { to: WORKER, kind: 'award', jobId: 'liar', worker: WORKER, price: '9000 USDC' });
    // claim 9000 USDC for a tx that really moved 500 — and the tx is already claimed by 'idx' anyway
    const s = await post('/work', { to: WORKER, kind: 'settle', jobId: 'liar', txHash: TX, amountMicro: '9000000000' });
    assert.equal(s.settled.verified, false);
    const c = await get('/credit');
    assert.equal(c.direct[0].usdcMicro, '500000000', 'standing did not move — still only the real 500');
  });

  await t('the WANTED board lists open claimable jobs, trust-annotated from OUR verified history', async () => {
    await post('/work', { to: WORKER, kind: 'help_wanted', jobId: 'open-1', task: 'review the fold', ref: 'https://github.com/x/y/pull/9', budgetHint: '30 USDC', as: 'human' });
    const w = await get('/wanted');
    const row = w.wanted.find((x) => x.jobId === 'open-1');
    assert.ok(row, 'an open, ready job is a wanted poster');
    assert.equal(row.ref, 'https://github.com/x/y/pull/9');
    assert.equal(row.budgetHint, '30 USDC');
    assert.equal(typeof row.trust.paidUsMicro, 'string', 'each poster carries OUR history with the requester');
    assert.match(row.trust.note, /not a bad mark/, 'a 0 is labelled an absence, never a bad mark');
    assert.ok(!w.wanted.find((x) => x.jobId === 'idx'), 'a settled job is no longer wanted');
  });

  await t('ERC-8004: the registration file is served, and claims only what is TRUE of this node', async () => {
    const c = await get('/.well-known/agent-registration.json');
    assert.equal(c.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    assert.equal(c.active, true);
    assert.ok(c.services.some((s) => s.type === 'MCP' && /\/mcp$/.test(s.url)), 'a REAL live endpoint — 85-97% of registrations in the wild are placeholders');
    assert.deepEqual(c.registrations, [], 'no agentId is fabricated: minting the ERC-721 is a signed tx nothing here performs');
    assert.ok(/\/agent\.svg$/.test(c.image), 'the node serves its OWN image, so the field is fillable without a host we do not control');
    const img = await fetch(c.image);
    assert.equal(img.status, 200, 'and that image really answers — a broken link IS the placeholder pathology');
    assert.match(img.headers.get('content-type') || '', /svg/);
    assert.match(c['x-lawbor'].onchainIdentity, /NOT registered on-chain/, 'the missing on-chain half is disclosed, not implied');
  });

  await t('every service the ERC-8004 card DECLARES actually answers — no promised-but-404 endpoint', async () => {
    // Written after shipping a card that declared `web` at `/` while `/` returned 404 in production.
    // A registration promising an endpoint that does not answer is the placeholder pathology itself.
    const c = await get('/.well-known/agent-registration.json');
    for (const s of c.services) {
      const u = new URL(s.url);
      const r = await fetch(`http://localhost:${port}${u.pathname}`, s.type === 'MCP'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
        : {});
      assert.ok(r.status < 400, 'declared service ' + s.type + ' (' + u.pathname + ') answered ' + r.status);
    }
  });

  await t('PUBLIC-NODE GUARD: MCP read tools stay open, write tools are refused to strangers', async () => {
    /* Found by auditing the node AFTER deploying it publicly: /say, /bot/say, /work, /peers and every
     * MCP write tool were reachable by anyone on the internet — enough to make the node speak under its
     * operator's address, or fill its store. Loopback (this test) is trusted, so the read/write SPLIT is
     * what is asserted here; the remote half is fail-closed by operatorOk with no verifyAuth wired. */
    const call = (name, args) => fetch(`http://localhost:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }) }).then((r) => r.json());
    const read = await call('lawbor_wanted');
    assert.equal(read.result.isError, false, 'a read tool must stay open — that is what the ERC-8004 card advertises');
    // and the classification is default-DENY: an unknown/new tool counts as a write
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /READ_TOOLS\.has/, 'the gate exists');
    assert.match(src, /Default-deny: a tool not on the read list is a write/, 'and is default-deny, so a new tool is not silently public');
    for (const w of ['lawbor_say', 'lawbor_post_job', 'lawbor_settle', 'lawbor_block']) {
      assert.ok(!/lawbor_(say|post_job|settle|block)/.test([...'x'].join('') + src.match(/const READ_TOOLS = new Set\(\[[^\]]*\]/)[0]), w + ' must NOT be on the read list');
    }
  });

  await t('the root page shows the node\'s HONEST state, not a brochure', async () => {
    const r = await fetch(`http://localhost:${port}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /no global score here/, 'the absence of a score is stated, not hidden');
    assert.match(html, /fail-closed/, 'and so is the missing signer');
  });

  await t('ERC-8004: the REFUSAL to write reputation is machine-readable, with its reason', async () => {
    // The refusal must survive in the artefact itself, not only in a code comment nobody reads.
    const c = await get('/.well-known/agent-registration.json');
    assert.equal(c['x-lawbor'].writesToErc8004ReputationRegistry, false);
    assert.match(c['x-lawbor'].whyNot, /second address defeats/, 'the attack is named');
    assert.match(c['x-lawbor'].whyNot, /59-91%/, 'and the measured evidence is cited');
    assert.match(c['x-lawbor'].trustModel, /no global score exists/);
    assert.ok(/\/credit$/.test(c['x-lawbor'].evidenceEndpoint), 'we point at re-verifiable evidence instead');
  });

  await t('the txFacts cache holds only FINAL facts, and is a cache of chain data (not our state)', async () => {
    const lines = fs.readFileSync(facts, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(lines.length >= 1);
    assert.ok(lines.every((f) => f.confirmations >= 12), 'a young tx must not be frozen at its birth confs');
    assert.ok(lines.every((f) => f.txHash && f.from && f.to && f.valueMicro), 'each row is a chain fact');
  });

  await new Promise((r) => built.server.close(r));
  for (const f of [base + '.jsonl', base + '.control', base + '.subs', facts]) { try { fs.unlinkSync(f); } catch {} }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
