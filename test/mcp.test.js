'use strict';
// LAWBOR MCP guards — the open-source tool surface any openclaude/gitlawb agent mounts.
// Offline: the node is injected with a stubbed preflight + captured transport. Run: node test/mcp.test.js
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
/* unique par CONSTRUCTION: un pid n est pas un id de run (Windows les recycle), et un nom
 * reutilise fait heriter le store du run precedent. Voir test/consent.test.js pour l enquete. */
const LAWBOR_TMP = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lawbor-t-"));
const assert = require('node:assert');
const { dispatch, TOOLS, PROTOCOL, SERVER } = require('../mcp');
const { createNode } = require('../lib/node');
const { createStore } = require('../lib/store');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const db = path.join(LAWBOR_TMP, 'mcp.jsonl');
const sent = [];
const node = createNode({ self: A, human: 'phil', preflight: async () => ({ decision: 'PROCEED', score: 71 }),
  send: async (to, env) => { sent.push({ to, env }); }, peers: [B], store: createStore(db) });
const call = (name, args) => dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }, { node });
const payload = (r) => JSON.parse(r.result.content[0].text);

(async () => {
  console.log('LAWBOR MCP — the gitlawb/openclaude tool surface:');

  await t('initialize + tools/list expose the 27 lawbor tools on protocol ' + PROTOCOL, async () => {
    const init = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { node });
    assert.equal(init.result.protocolVersion, PROTOCOL); assert.equal(init.result.serverInfo.name, 'lawbor');
    const list = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { node });
    assert.equal(list.result.tools.length, 27);
    assert.equal(list.result.tools.map((x) => x.name).sort().join(),
      'lawbor_accept,lawbor_award,lawbor_bazaar,lawbor_bid,lawbor_block,lawbor_bot_say,lawbor_confirm,lawbor_credit,lawbor_graph,lawbor_inbox,lawbor_jobs,lawbor_offer,lawbor_peer,lawbor_post_job,lawbor_quote,lawbor_requests,lawbor_rings,lawbor_say,lawbor_settle,lawbor_thread,lawbor_unblock,lawbor_validate,lawbor_vet,lawbor_wanted,lawbor_watch,lawbor_whoami,lawbor_why');
  });

  await t('lawbor_vet: two lenses side by side, LABELED — oracle word is never merged into local proof', async () => {
    /* The composition verb. The oracle lens must carry its own disclosure (REPORTED, not verified),
     * the local lens must carry its own (or the no-chain-reader honesty), and no combined number may
     * exist — averaging them would launder "MainStreet said" into "this node verified". */
    const p = payload(await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'lawbor_vet', arguments: { of: B } } },
      { node, preflight: async () => ({ decision: 'PROCEED', score: 71, counterparty: { settlements: 3, youPaidThemMicro: '5000000' } }) }));
    assert.equal(p.subject, B.toLowerCase());
    assert.equal(p.oracle.decision, 'PROCEED');
    assert.equal(p.oracle.counterparty.youPaidThemMicro, '5000000', 'oracle conservation block passes through');
    assert.match(p.oracle.disclosure, /ORACLE-REPORTED/);
    assert.match(p.oracle.disclosure, /none of it enters local standing/);
    assert.equal(p.local.directUsdcMicro, '0', 'local lens stays what THIS node verified — the oracle number never leaks in');
    assert.match(p.local.disclosure, /no chain reader is wired/, 'standalone: local 0 is explained, not left to be misread');
    assert.match(p.note, /no combined score exists/);
    for (const k of Object.keys(p)) assert.ok(!/^(combined|merged|total|overall)/i.test(k), 'no merged-score field may exist: ' + k);
  });

  await t('lawbor_vet: a dead oracle DISCLOSES on this advisory read instead of failing the call', async () => {
    const p = payload(await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'lawbor_vet', arguments: { of: B } } },
      { node, preflight: async () => { throw new Error('ECONNREFUSED'); } }));
    assert.match(p.oracle.error, /oracle unreachable/);
    assert.match(p.oracle.disclosure, /fail-closed/, 'must say where fail-closed still holds (the relay), so honesty here cannot be read as softness there');
    assert.equal(p.local.directUsdcMicro, '0', 'local lens still answers');
    const bad = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'lawbor_vet', arguments: {} } }, { node });
    assert.equal(bad.result.isError, true, 'missing of → honest tool error');
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

  await t('THE PUBLISHED SKILL CANNOT GO STALE: every write tool must be taught in SKILL.md', async () => {
    /* SKILL.md is served publicly at /skill.md and is the primary way an outside agent learns to use
     * this node. It had drifted to teaching 8 tools while the surface exposed 19, and still claimed
     * "LAWBOR models no settlement" long after settlements were being verified on-chain — a published
     * artefact describing a node that no longer existed. This test makes drift fail instead of rot. */
    const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
    const READ_ONLY_OK = new Set(['lawbor_inbox', 'lawbor_thread', 'lawbor_requests', 'lawbor_unblock', 'lawbor_accept', 'lawbor_bot_say', 'lawbor_say']);
    const missing = TOOLS.map((x) => x.name).filter((n) => !READ_ONLY_OK.has(n) && !skill.includes(n));
    assert.deepEqual(missing, [], 'these tools exist but SKILL.md never mentions them: ' + missing.join(', '));
  });

  await t('SKILL.md states the CURRENT honesty rules, not the ones it was born with', async () => {
    const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
    assert.match(skill, /`settled` means PAID/i, 'settled must be defined as paid');
    assert.match(skill, /[Nn]either means delivered/, 'and explicitly NOT as delivered');
    assert.match(skill, /no global score/i, 'the absence of a global score is the headline property');
    assert.ok(!/LAWBOR models negotiation and coordination, not execution\/settlement/.test(skill),
      'the old "no settlement" claim is now false and must not survive in the published skill');
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
    assert.equal(p.forwarded, true); assert.equal(p.delivered, null, 'a stub transport reports nothing, so delivery is UNKNOWN — never assumed'); assert.equal(p.sign.signed, false);
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
    assert.equal(p.forwarded, true); assert.equal(p.delivered, null, 'a stub transport reports nothing, so delivery is UNKNOWN — never assumed');
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

  await t('a work reply CONTINUES the job thread; lawbor_thread shows the parsed haggle + the derived deal', async () => {
    // Runs LAST: it adds work sends to the shared `sent`/store, so it must not precede count assertions.
    const { buildWork } = require('../lib/work');
    const { buildEnvelope } = require('../lib/envelope');
    const offer = payload(await call('lawbor_offer', { to: B, jobId: 'th-neg', item: 'an MCP tool' }));
    const th = offer.thread;
    const q = payload(await call('lawbor_quote', { to: B, jobId: 'th-neg', amountMicro: '5000000' }));  // owner A quotes
    assert.equal(q.thread, th, 'the quote reply CONTINUED the offer thread, it did not root a new one');
    // a matching counterparty quote from B, in the same thread, so agreedPrice derives
    node.store.record(buildEnvelope({ from: B, to: A, body: buildWork('quote', { jobId: 'th-neg', amountMicro: '5000000' }), thread: th, viaHuman: null }).envelope, { origin: 'bot', dir: 'in' });
    const tr = payload(await call('lawbor_thread', { id: th }));
    assert.ok(tr.messages.some((m) => m.work && m.work.kind === 'offer'), 'the offer is parsed inline (not an opaque blob)');
    assert.ok(tr.messages.some((m) => m.work && m.work.kind === 'quote' && m.work.amountMicro === '5000000'), 'the quote is parsed inline — a readable number');
    const j = tr.jobs.find((x) => x.jobId === 'th-neg');
    assert.ok(j && j.agreedPrice && j.agreedPrice.amountMicro === '5000000', 'the DERIVED agreedPrice is visible in the thread view — one read = the whole deal');
  });

  await t('lawbor_peer → the whole relationship: trust + jobs we BOTH took part in + our threads', async () => {
    const { buildWork } = require('../lib/work');
    const { buildEnvelope } = require('../lib/envelope');
    await call('lawbor_post_job', { to: B, jobId: 'pr-job', task: 'index a contract' });                 // A posts
    node.store.record(buildEnvelope({ from: B, to: A, body: buildWork('bid', { jobId: 'pr-job', price: '8 USDC' }), viaHuman: null }).envelope, { origin: 'bot', dir: 'in' }); // B bids
    await call('lawbor_award', { to: B, jobId: 'pr-job', worker: B, price: '8 USDC' });                   // A awards B
    const p = payload(await call('lawbor_peer', { of: B }));
    assert.equal(p.peer, B.toLowerCase());
    const j = p.jobs.find((x) => x.jobId === 'pr-job');
    assert.ok(j && j.role === 'requester' && j.state === 'awarded', 'the shared, awarded job shows with my role');
    assert.ok(p.trust && p.trust.local && p.trust.oracle, 'both trust lenses present');
    assert.ok(Array.isArray(p.threads), 'our conversations are listed');
    // a job that does NOT involve B must be excluded
    const C = '0x' + 'cc'.repeat(20);
    node.store.record(buildEnvelope({ from: A, to: C, body: buildWork('help_wanted', { jobId: 'pr-other', task: 'x' }), viaHuman: null }).envelope, { origin: 'bot', dir: 'out' });
    assert.ok(!payload(await call('lawbor_peer', { of: B })).jobs.some((x) => x.jobId === 'pr-other'), 'a job with a DIFFERENT peer is not in this relationship');
  });

  try { fs.unlinkSync(db); } catch {}
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
