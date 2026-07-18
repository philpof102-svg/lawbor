'use strict';
// LAWBOR consent — the LOCAL gate that makes free H2H messaging safe to switch on. Fully offline
// (preflight + transport injected, isolated temp store + control log). One test per invariant.
// Run: node test/consent.test.js
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
const assert = require('node:assert');
const { foldControl, decideInbound } = require('../lib/consent');
const { createStore } = require('../lib/store');
const { createNode } = require('../lib/node');
const { buildEnvelope } = require('../lib/envelope');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'a1'.repeat(20);   // us (the human receiving)
const B = '0x' + 'b1'.repeat(20);   // a contact we've written to
const S = '0x' + '51'.repeat(20);   // a stranger (first contact)
const X = '0x' + 'e1'.repeat(20);   // to be blocked
const proceed = async () => ({ decision: 'PROCEED', score: 70 });
const lowScore = async () => ({ decision: 'PROCEED', score: 5 });

let n = 0;
// a fresh, isolated node each time (own messages file + own control file)
function freshNode(preflight = proceed) {
  const base = path.join(os.tmpdir(), 'lawbor-consent-' + process.pid + '-' + (++n));
  const store = createStore(base + '.jsonl', base + '.control');
  const sent = [];
  const node = createNode({ self: A, human: 'me', preflight, allowUnauthenticated: true,
    send: async (to, env) => { sent.push({ to, env }); }, peers: [B, S, X], store });
  return { node, store, sent };
}
// an inbound HUMAN message from `from` to us (viaHuman set → it is a person speaking through their bot)
const inHuman = (from, body) => buildEnvelope({ from, to: A, body, viaHuman: 'them' }).envelope;
const inBot = (from, body) => buildEnvelope({ from, to: A, body, viaHuman: null }).envelope;

(async () => {
  console.log('LAWBOR consent — first-contact quarantine + local block, separate from reputation:');

  // ---- pure core ------------------------------------------------------------------------------
  await t('foldControl: last-write-wins per addr; unblock reverses; accept also un-blocks', () => {
    const f1 = foldControl([{ type: 'block', addr: X, at: 1 }, { type: 'unblock', addr: X, at: 2 }, { type: 'block', addr: X, at: 3 }]);
    assert.ok(f1.blocked.has(X.toLowerCase()), 'block after unblock → blocked');
    const f2 = foldControl([{ type: 'block', addr: X, at: 1 }, { type: 'accept', addr: X, at: 2 }]);
    assert.ok(!f2.blocked.has(X.toLowerCase()) && f2.accepted.has(X.toLowerCase()), 'accept un-blocks + whitelists');
    // out-of-order rows must fold the same (sorted by `at`, our clock)
    const f3 = foldControl([{ type: 'block', addr: X, at: 3 }, { type: 'unblock', addr: X, at: 1 }]);
    assert.ok(f3.blocked.has(X.toLowerCase()), 'the later block wins regardless of read order');
  });

  await t('decideInbound: bot origin → bot; blocked → blocked; accepted/replied → inbox; else requests', () => {
    const blocked = new Set([X.toLowerCase()]), accepted = new Set([B.toLowerCase()]);
    const wrote = (a) => a.toLowerCase() === S.toLowerCase();   // we replied to S
    const d = (from, origin = 'human') => decideInbound({ from, self: A, origin, blocked, accepted, hasOutboundTo: wrote }).bucket;
    assert.equal(d(X), 'blocked');
    assert.equal(d(B), 'inbox', 'accepted');
    assert.equal(d(S), 'inbox', 'we replied → implicit consent');
    assert.equal(d('0x' + '77'.repeat(20)), 'requests', 'unknown first contact');
    assert.equal(d(X, 'bot'), 'bot', 'the autonomous feed is never quarantined');
  });

  // ---- 1 & 2: a blocked sender is dropped before storage, with no delivery confirmation ---------
  await t('a blocked sender is DROPPED before the append-only store records anything', async () => {
    const { node, store } = freshNode();
    node.block(X);
    const r = await node.receive(inHuman(X, 'let me in'));
    assert.equal(r.action, 'drop');
    assert.equal(r.reason, 'blocked');
    assert.equal(store.all().length, 0, 'nothing was stored — an abusive body is never persisted');
  });

  await t('a block is indistinguishable from silence (no delivery confirmation leaks)', async () => {
    const { node } = freshNode();
    node.block(X);
    const blockedResp = await node.receive(inHuman(X, 'a'));
    // an UNKNOWN (unblocked) sender that IS delivered returns action:'deliver'; a blocked one must
    // not return anything richer than a plain drop, or the block becomes observable.
    assert.deepEqual({ action: blockedResp.action, reason: blockedResp.reason }, { action: 'drop', reason: 'blocked' });
  });

  // ---- 3,4,5,6: the quarantine + promotion paths ----------------------------------------------
  await t('first contact from an unknown sender lands in REQUESTS, not the inbox', async () => {
    const { node, store } = freshNode();
    await node.receive(inHuman(S, 'gm, we have not met'));
    assert.equal(store.inbox(A).length, 0, 'not in the inbox');
    assert.equal(store.requests(A).length, 1, 'waiting in requests');
    assert.match(store.requests(A)[0].last, /have not met/);
  });

  await t('replying to a request promotes that sender to the inbox (implicit consent)', async () => {
    const { node, store } = freshNode();
    await node.receive(inHuman(S, 'first contact'));
    assert.equal(store.requests(A).length, 1);
    await node.say(S, 'sure, tell me more');           // we wrote to them → known
    assert.equal(store.requests(A).length, 0, 'no longer a request');
    assert.ok(store.inbox(A).some((th) => th.peers.map((p) => p.toLowerCase()).includes(S.toLowerCase())), 'now in the inbox');
  });

  await t('explicit accept() promotes a request to the inbox without replying', async () => {
    const { node, store } = freshNode();
    await node.receive(inHuman(S, 'first contact'));
    node.accept(S);
    assert.equal(store.requests(A).length, 0);
    assert.equal(store.inbox(A).length, 1);
  });

  await t('a known contact (we wrote to them earlier) bypasses quarantine → straight to inbox', async () => {
    const { node, store } = freshNode();
    await node.say(B, 'hey, working together?');       // we know B
    await node.receive(inHuman(B, 'yes, here is my quote'));
    assert.equal(store.requests(A).length, 0, 'never quarantined');
    assert.ok(store.inbox(A).length >= 1);
  });

  // ---- 7: the autonomous watch feed is untouched ----------------------------------------------
  await t('a peer BOT\'s autonomous message is never quarantined and never consent-dropped', async () => {
    const { node, store } = freshNode();
    node.block(X);
    await node.receive(inBot(X, 'autonomous chatter'));   // bot origin, even from a blocked human's bot
    assert.equal(store.botActivity(A).length, 1, 'shows in the watch feed');
    assert.equal(store.requests(A).length, 0);
    assert.equal(store.inbox(A).length, 0);
  });

  // ---- 8,9,10: fold semantics, locality, reversal ---------------------------------------------
  await t('block state is folded from the local control log (unblock restores delivery)', async () => {
    const { node, store } = freshNode();
    node.block(S);
    assert.equal((await node.receive(inHuman(S, 'x'))).action, 'drop');
    node.unblock(S);
    const r = await node.receive(inHuman(S, 'y'));
    assert.equal(r.action, 'deliver', 'unblock restores delivery');
    assert.equal(store.requests(A).length, 1, 'and it lands in requests (still an unknown sender)');
  });

  await t('consent is LOCAL only: the control log is a separate file, never in the message log', async () => {
    const { node, store } = freshNode();
    node.block(X);
    // the block is NOT a message row — it never enters store.all() (which is what gossip/mesh reads)
    assert.equal(store.all().length, 0, 'blocking wrote nothing to the gossip-visible message log');
    assert.ok(store.control().blocked.has(X.toLowerCase()), 'it lives in the separate control fold');
  });

  // ---- 11: reputation and consent are DIFFERENT checks ----------------------------------------
  await t('reputation gate is unchanged: a low-score sender is dropped by the relay before consent', async () => {
    const { node, store } = freshNode(lowScore);
    const r = await node.receive(inHuman(S, 'low rep'));
    assert.equal(r.action, 'drop');
    assert.notEqual(r.reason, 'blocked', 'dropped by REPUTATION, not consent — they never reached the consent check');
    assert.equal(store.all().length, 0);
  });

  // ---- purity guard ---------------------------------------------------------------------------
  await t('consent.js is pure: no network, no key, no funds, decides only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'consent.js'), 'utf8');
    // strip ALL comments first — the header freely says "network", which is not code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/require\(/.test(code), 'no imports — it only decides over sets the store hands it');
    assert.ok(!/\bfetch\b|require\(['"](?:http|https|net|dns)['"]\)|privateKey|eth_sendTransaction|\.transfer\(/i.test(code));
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
