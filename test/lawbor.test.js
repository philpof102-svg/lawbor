'use strict';
// LAWBOR core guards — envelope + reputation-gated relay. Offline (preflight injected), deterministic.
// Run: node test/lawbor.test.js
const assert = require('node:assert');
const { buildEnvelope, validateEnvelope, envelopeId } = require('../lib/envelope');
const { createRelay: makeRelay } = require('../lib/relay');

// These relay cases predate signature verification and exercise the UNAUTHENTICATED path on purpose
// (relay.js now refuses it by default). Declaring the opt-in once, here, keeps every case honest
// about what it proves: gating behaviour GIVEN a sender whose `from` was never verified. The
// impersonation cases at the bottom cover the authenticated path and the reason it exists.
const createRelay = (cfg) => makeRelay({ allowUnauthenticated: true, ...cfg });

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), C = '0x' + 'cc'.repeat(20);
const proceed = async () => ({ decision: 'PROCEED', score: 72 });
const lowScore = async () => ({ decision: 'PROCEED', score: 12 });
const avoid = async () => ({ decision: 'AVOID', score: 3 });
const down = async () => { throw new Error('mainstreet 503'); };

(async () => {
  console.log('LAWBOR envelope + reputation-gated relay:');

  await t('envelope: built + deterministic id + EIP-712 signable descriptor (descriptor-only)', () => {
    const { envelope, sign } = buildEnvelope({ from: A, to: B, body: 'gm', ts: 1783000000, nonce: 'n1' });
    assert.equal(envelope.id, envelopeId(envelope));
    assert.equal(envelope.thread, envelope.id, 'fresh thread rooted at the id');
    assert.equal(sign.signed, false); assert.match(sign.execution, /FORBIDDEN/);
    assert.equal(sign.typedData.primaryType, 'LawborMessage');
    assert.equal(sign.typedData.message.from, A);
  });
  await t('envelope: viaHuman provenance carried (human speaks THROUGH their bot)', () => {
    const { envelope } = buildEnvelope({ from: A, to: B, body: 'hi from phil', viaHuman: 'phil' });
    assert.equal(envelope.viaHuman, 'phil');
  });
  await t('envelope guards: self-message / empty body / bad addr all throw', () => {
    assert.throws(() => buildEnvelope({ from: A, to: A, body: 'x' }), /does not message itself/);
    assert.throws(() => buildEnvelope({ from: A, to: B, body: '' }), /body required/);
    assert.throws(() => buildEnvelope({ from: 'nope', to: B, body: 'x' }), /0x address/);
  });
  await t('validateEnvelope: detects tampering (body changed after id)', () => {
    const { envelope } = buildEnvelope({ from: A, to: B, body: 'original' });
    assert.equal(validateEnvelope(envelope).ok, true);
    envelope.body = 'tampered';
    assert.equal(validateEnvelope(envelope).ok, false);
  });

  // relay: B is us; A sends to B; C is a peer
  const mkEnv = (from, to, body) => buildEnvelope({ from, to, body }).envelope;

  await t('relay: PROCEED sender + to===self → DELIVER to the human, with the sender score', async () => {
    const r = createRelay({ self: B, preflight: proceed, peers: [A, C] });
    const res = await r.accept(mkEnv(A, B, 'hello B'));
    assert.equal(res.action, 'deliver'); assert.equal(res.to, 'human'); assert.equal(res.senderScore, 72);
  });
  await t('relay REPUTATION GATE: low score → DROP (anti-spam, safe-to-talk)', async () => {
    const r = createRelay({ self: B, preflight: lowScore, peers: [A] });
    const res = await r.accept(mkEnv(A, B, 'spam'));
    assert.equal(res.action, 'drop'); assert.match(res.reason, /score 12 < 40/);
  });
  await t('relay REPUTATION GATE: AVOID sender → DROP', async () => {
    const r = createRelay({ self: B, preflight: avoid });
    assert.equal((await r.accept(mkEnv(A, B, 'x'))).action, 'drop');
  });
  await t('relay FAIL CLOSED: preflight down → DROP (never relay without a reputation read)', async () => {
    const r = createRelay({ self: B, preflight: down });
    const res = await r.accept(mkEnv(A, B, 'x'));
    assert.equal(res.action, 'drop'); assert.match(res.reason, /FAIL CLOSED/);
  });
  await t('relay: not-for-us → FORWARD one hop (decentralized gossip), hops incremented', async () => {
    const r = createRelay({ self: B, preflight: proceed, peers: [A, C] });
    const res = await r.accept(mkEnv(A, C, 'for C via B'));   // A→C, B relays
    assert.equal(res.action, 'forward'); assert.deepEqual(res.targets, [C.toLowerCase()]);
    assert.equal(res.envelope.hops, 1);
  });
  await t('relay DEDUP: the same envelope is handled once (gossip retries are safe)', async () => {
    const r = createRelay({ self: B, preflight: proceed, peers: [A] });
    const env = mkEnv(A, B, 'once');
    assert.equal((await r.accept(env)).action, 'deliver');
    assert.equal((await r.accept(env)).action, 'drop');       // second time → dedup drop
  });
  await t('relay HOP CAP: over maxHops → DROP (no infinite relay loops)', async () => {
    const r = createRelay({ self: B, preflight: proceed, peers: [C], maxHops: 2 });
    const env = { ...mkEnv(A, C, 'x'), hops: 3 };
    assert.equal((await r.accept(env)).action, 'drop');
  });
  await t('relay originate: a bot forwards its OWN outbound to peers; foreign from → drop', async () => {
    const r = createRelay({ self: A, preflight: proceed, peers: [B] });
    const out = await r.originate(mkEnv(A, B, 'outbound'));
    assert.equal(out.action, 'forward'); assert.deepEqual(out.targets, [B.toLowerCase()]);
    assert.equal((await r.originate(mkEnv(C, B, 'not mine'))).action, 'drop');
  });
  await t('relay originate: no peers → drop with "join the mesh first"', async () => {
    const r = createRelay({ self: A, preflight: proceed, peers: [] });
    assert.match((await r.originate(mkEnv(A, B, 'x'))).reason, /join the mesh/);
  });

  // --- IMPERSONATION: the hole this whole mechanism exists to close --------------------------
  // Found 2026-07-18 while reviewing the mesh design, then reproduced against the real relay: an
  // attacker refused under their own address was admitted with score 90 simply by writing a
  // reputable address into `from`. No key, no signature. Base addresses are public, so the attack
  // cost was zero — which made "reputation-gated" decorative.
  const REPUTABLE = '0x' + '22'.repeat(20), ATTACKER = '0x' + '99'.repeat(20);
  const byAddr = async (a) => (a.toLowerCase() === REPUTABLE.toLowerCase()
    ? { decision: 'PROCEED', score: 90 } : { decision: 'BLOCK', score: 0 });
  // a stand-in for viem/ethers: the signature IS the signer's address here, so tests stay offline
  const verifySig = async ({ sig }) => (typeof sig === 'string' && /^0x[0-9a-fA-F]{40}$/.test(sig)
    ? { ok: true, signer: sig } : { ok: false });
  const signedBy = (signer, env) => ({ ...env, sig: signer });

  await t('impersonation: writing a reputable address into `from` no longer inherits its score', async () => {
    const r = makeRelay({ self: B, preflight: byAddr, verifySig, peers: [] });
    const spoof = signedBy(ATTACKER, mkEnv(REPUTABLE, B, 'I am the reputable bot'));
    const out = await r.accept(spoof);
    assert.equal(out.action, 'drop');
    assert.match(out.reason, /impersonation refused/);
  });
  await t('impersonation: a genuinely signed reputable sender still gets through, authenticated', async () => {
    const r = makeRelay({ self: B, preflight: byAddr, verifySig, peers: [] });
    const out = await r.accept(signedBy(REPUTABLE, mkEnv(REPUTABLE, B, 'gm')));
    assert.equal(out.action, 'deliver');
    assert.equal(out.senderScore, 90);
    assert.equal(out.authenticated, true);
  });
  await t('FAIL CLOSED: with no verifier and no explicit opt-in, inbound is refused, not trusted', async () => {
    const r = makeRelay({ self: B, preflight: byAddr, peers: [] });
    const out = await r.accept(mkEnv(REPUTABLE, B, 'gm'));
    assert.equal(out.action, 'drop');
    assert.match(out.reason, /FAIL CLOSED/);
    assert.equal(r.authenticates, false, 'and it admits it does not authenticate');
  });
  await t('FAIL CLOSED: a verifier that throws or returns junk never falls open', async () => {
    const boom = makeRelay({ self: B, preflight: byAddr, verifySig: async () => { throw new Error('rpc down'); } });
    assert.match((await boom.accept(signedBy(REPUTABLE, mkEnv(REPUTABLE, B, 'x')))).reason, /FAIL CLOSED/);
    const junk = makeRelay({ self: B, preflight: byAddr, verifySig: async () => ({ ok: true }) });   // ok but no signer
    assert.equal((await junk.accept(signedBy(REPUTABLE, mkEnv(REPUTABLE, B, 'x')))).action, 'drop');
  });
  await t('a signed envelope with no `sig` attached is refused before the oracle is even asked', async () => {
    let asked = 0;
    const r = makeRelay({ self: B, preflight: async (a) => { asked++; return byAddr(a); }, verifySig });
    const out = await r.accept(mkEnv(REPUTABLE, B, 'no sig'));
    assert.equal(out.action, 'drop');
    assert.equal(asked, 0, 'authentication runs BEFORE the reputation lookup — no oracle call is wasted on a stranger');
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
