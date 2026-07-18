'use strict';
// LAWBOR node + two-view store guards — offline (preflight + transport injected), isolated store.
// Proves Phil's corrected design: a human's inbox AND a "watch my bot" feed, over the reputation-gated relay.
// Run: node test/node.test.js
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
process.env.LAWBOR_DB = path.join(os.tmpdir(), 'lawbor-node-' + process.pid + '.jsonl');
const assert = require('node:assert');
const { createNode: makeNode } = require('../lib/node');
// These cases predate signature verification; they exercise the UNAUTHENTICATED path on purpose
// (relay.js refuses it by default now). See test/lawbor.test.js for the impersonation regressions.
const createNode = (cfg) => makeNode({ allowUnauthenticated: true, ...cfg });
const { createStore } = require('../lib/store');
const { buildEnvelope } = require('../lib/envelope');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const proceed = async () => ({ decision: 'PROCEED', score: 70 });
const lowScore = async () => ({ decision: 'PROCEED', score: 5 });

(async () => {
  console.log('LAWBOR node — human inbox + watch-my-bot views over the gated relay:');
  const store = createStore(process.env.LAWBOR_DB);
  const sent = [];                                     // captured transport
  const send = async (to, env) => { sent.push({ to, env }); };
  const nodeA = createNode({ self: A, human: 'phil', preflight: proceed, send, peers: [B], store });

  let firstEnv;
  await t('human say() → recorded origin:human, envelope built (descriptor to sign), transported to peer', async () => {
    const r = await nodeA.say(B, 'gm bob, from phil');
    assert.equal(r.delivered, true); assert.equal(r.sign.signed, false);
    assert.equal(sent.length, 1); assert.equal(sent[0].to, B.toLowerCase());
    firstEnv = r.envelope; assert.equal(firstEnv.viaHuman, 'phil');
  });
  await t("botSay() → recorded origin:bot (shows in 'watch my bot', NOT the human inbox)", async () => {
    await nodeA.botSay(B, 'bot-to-bot: syncing availability');
    const inbox = store.inbox(A), watch = store.botActivity(A);
    assert.equal(inbox.length, 1, 'inbox has ONLY the human thread');
    assert.equal(watch.length, 1, 'watch has ONLY the bot thread');
    assert.notEqual(inbox[0].thread, watch[0].thread);
  });
  await t('receive() a human-authored peer msg (viaHuman set) → delivered to the INBOX view', async () => {
    const { buildEnvelope } = require('../lib/envelope');
    const env = buildEnvelope({ from: B, to: A, body: 'gm phil, from bob', viaHuman: 'bob' }).envelope;
    const r = await nodeA.receive(env);
    assert.equal(r.action, 'deliver');
    const inbox = store.inbox(A);
    assert.ok(inbox.some((th) => th.last.includes('from bob')), 'appears in human inbox');
  });
  await t("receive() a peer BOT's autonomous msg (no viaHuman) → shows in watch-my-bot, not inbox", async () => {
    const { buildEnvelope } = require('../lib/envelope');
    const env = buildEnvelope({ from: B, to: A, body: 'bot: peer-review request' }).envelope;
    await nodeA.receive(env);
    const watch = store.botActivity(A);
    assert.ok(watch.some((th) => th.last.includes('peer-review')), 'appears in watch-my-bot');
  });
  await t('REPUTATION GATE holds at the node: a low-score peer msg is dropped, never stored', async () => {
    const nodeGated = createNode({ self: A, preflight: lowScore, send, peers: [B], store: createStore(path.join(os.tmpdir(), 'lawbor-gated-' + process.pid + '.jsonl')) });
    const { buildEnvelope } = require('../lib/envelope');
    const env = buildEnvelope({ from: B, to: A, body: 'spam', viaHuman: 'x' }).envelope;
    const r = await nodeGated.receive(env);
    assert.equal(r.action, 'drop'); assert.equal(nodeGated.store.all().length, 0, 'dropped msg never recorded');
  });
  await t('forwarding: a msg not for us is relayed onward (decentralized), not delivered to our human', async () => {
    const C = '0x' + 'cc'.repeat(20);
    const nodeF = createNode({ self: A, preflight: proceed, send, peers: [C], store: createStore(path.join(os.tmpdir(), 'lawbor-fwd-' + process.pid + '.jsonl')) });
    const { buildEnvelope } = require('../lib/envelope');
    const env = buildEnvelope({ from: B, to: C, body: 'for C' }).envelope;
    const before = sent.length;
    const r = await nodeF.receive(env);
    assert.equal(r.action, 'forward'); assert.equal(sent.length, before + 1); assert.equal(nodeF.store.all().length, 0);
  });

  try { fs.unlinkSync(process.env.LAWBOR_DB); } catch {}
  await t('ordering uses OUR clock, not the sender-chosen ts (spam cannot pin itself to the top)', () => {
    const os2 = require('node:os'), p2 = require('node:path');
    const base2 = p2.join(os2.tmpdir(), 'lawbor-rx-' + process.pid);
    const s2 = createStore(base2 + '.jsonl', base2 + '.control');
    const now = Math.floor(Date.now() / 1000);
    // both are first contact from strangers → the Requests bucket (consent gate); the anti-pinning
    // property holds THERE now, which is exactly where cold-outreach spam lands.
    s2.record(buildEnvelope({ from: '0x' + '99'.repeat(20), to: A, body: 'SPAM dated 2036', ts: now + 315360000, viaHuman: 'x' }).envelope, { origin: 'human', dir: 'in', rxAt: 1000 });
    s2.record(buildEnvelope({ from: B, to: A, body: 'real message from bob', ts: now, viaHuman: 'bob' }).envelope, { origin: 'human', dir: 'in', rxAt: 2000 });
    assert.match(s2.requests(A)[0].last, /real message/, 'a future-dated envelope must not outrank a newer real one');
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
