'use strict';
// LAWBOR MCP guards — the open-source tool surface any openclaude/gitlawb agent mounts.
// Offline: the node is injected with a stubbed preflight + captured transport. Run: node test/mcp.test.js
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
const assert = require('node:assert');
const { dispatch, TOOLS, PROTOCOL, SERVER } = require('../mcp');
const { createNode } = require('../lib/node');
const { createStore } = require('../lib/store');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const db = path.join(os.tmpdir(), 'lawbor-mcp-' + process.pid + '.jsonl');
const sent = [];
const node = createNode({ self: A, human: 'phil', preflight: async () => ({ decision: 'PROCEED', score: 71 }),
  send: async (to, env) => { sent.push({ to, env }); }, peers: [B], store: createStore(db) });
const call = (name, args) => dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }, { node });
const payload = (r) => JSON.parse(r.result.content[0].text);

(async () => {
  console.log('LAWBOR MCP — the gitlawb/openclaude tool surface:');

  await t('initialize + tools/list expose the 19 lawbor tools on protocol ' + PROTOCOL, async () => {
    const init = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { node });
    assert.equal(init.result.protocolVersion, PROTOCOL); assert.equal(init.result.serverInfo.name, 'lawbor');
    const list = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { node });
    assert.equal(list.result.tools.length, 19);
    assert.equal(list.result.tools.map((x) => x.name).sort().join(),
      'lawbor_accept,lawbor_award,lawbor_bid,lawbor_block,lawbor_bot_say,lawbor_credit,lawbor_graph,lawbor_inbox,lawbor_jobs,lawbor_post_job,lawbor_requests,lawbor_say,lawbor_settle,lawbor_thread,lawbor_unblock,lawbor_validate,lawbor_wanted,lawbor_watch,lawbor_whoami');
  });

  await t('lawbor_credit refuses to let 0 read as "bad counterparty" when nothing can verify', async () => {
    // Used standalone (no chain reader injected) NO settlement can ever verify. Returning bare zeros
    // would libel an honest worker; the tool must say why the number is zero.
    const r = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lawbor_credit', arguments: {} } }, { node });
    const p = JSON.parse(r.result.content[0].text);
    assert.equal(p.viewer, node.self);
    assert.ok(p.limits.some((l) => /no chain reader is wired/.test(l)), 'must disclose that nothing can verify');
    assert.ok(p.limits.some((l) => /cold start is total/.test(l)));
    assert.ok(p.limits.some((l) => /settled means PAID, never delivered/.test(l)));
  });

  await t('every WORK tool description states plainly that settlement is not included', async () => {
    // An agent reads these descriptions and nothing else. If they imply payment, the tool lies to
    // the only audience it has — which is precisely the anti-hype rule this project holds itself to.
    const list = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { node });
    for (const name of ['lawbor_jobs', 'lawbor_award']) {
      const d = list.result.tools.find((x) => x.name === name).description;
      assert.match(d, /NOT included|no funds are held|NEGOTIATION ONLY/i, name + ' must not imply payment');
    }
  });
  await t('lawbor_whoami → identity + peers + the REAL reputation floor (no undefined)', async () => {
    const p = payload(await call('lawbor_whoami'));
    assert.equal(p.self, A.toLowerCase()); assert.deepEqual(p.peers, [B.toLowerCase()]);
    assert.equal(typeof p.minScore, 'number', 'minScore must be a real number');
    assert.equal(typeof p.maxHops, 'number');
    assert.match(p.oracle, /MainStreet/);
  });
  let threadId;
  await t('lawbor_say → relays + returns the EIP-712 descriptor, signed:false (operator signs)', async () => {
    const p = payload(await call('lawbor_say', { to: B, body: 'gm from the MCP' }));
    assert.equal(p.delivered, true); assert.equal(p.sign.signed, false);
    assert.match(p.sign.execution, /FORBIDDEN/);
    assert.equal(p.sign.typedData.primaryType, 'LawborMessage');
    threadId = p.thread;
    assert.equal(sent.length, 1, 'actually transported to the peer');
  });
  await t('lawbor_inbox shows the human message; lawbor_watch does NOT (the two views stay separate)', async () => {
    const inbox = payload(await call('lawbor_inbox'));
    assert.ok(inbox.threads.some((th) => th.last.includes('from the MCP')));
    const watch = payload(await call('lawbor_watch'));
    assert.ok(!watch.threads.some((th) => th.last.includes('from the MCP')));
  });
  await t('lawbor_bot_say → autonomous message lands in the WATCH view, not the inbox', async () => {
    const p = payload(await call('lawbor_bot_say', { to: B, body: 'bot: peer sync' }));
    assert.equal(p.delivered, true);
    const watch = payload(await call('lawbor_watch'));
    assert.ok(watch.threads.some((th) => th.last.includes('peer sync')));
    const inbox = payload(await call('lawbor_inbox'));
    assert.ok(!inbox.threads.some((th) => th.last.includes('peer sync')));
  });
  await t('lawbor_thread returns the conversation; missing id → honest tool error', async () => {
    const p = payload(await call('lawbor_thread', { id: threadId }));
    assert.ok(p.messages.length >= 1);
    const bad = await call('lawbor_thread', {});
    assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /id required/);
  });
  await t('unknown tool → -32602 · unknown method → -32601 · notification → null', async () => {
    assert.equal((await call('lawbor_drain_wallet')).error.code, -32602);
    assert.equal((await dispatch({ jsonrpc: '2.0', id: 9, method: 'nope' }, { node })).error.code, -32601);
    assert.equal(await dispatch({ jsonrpc: '2.0', method: 'tools/list' }, { node }), null);
  });
  await t('SAFETY: no tool name is a money/signing verb, and nothing returns signed:true', async () => {
    assert.ok(TOOLS.every((x) => !/(^|_)(send|sign|swap|pay|transfer|withdraw|deploy)(_|$)/i.test(x.name)));
    const p = payload(await call('lawbor_say', { to: B, body: 'safety check' }));
    assert.equal(p.sign.signed, false);
  });
  await t('no node injected → clean -32603, never a crash', async () => {
    const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lawbor_inbox' } }, {});
    assert.equal(r.error.code, -32603);
  });

  try { fs.unlinkSync(db); } catch {}
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
