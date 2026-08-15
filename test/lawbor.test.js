'use strict';
// LAWBOR core guards — envelope + reputation-gated relay. Offline (preflight injected), deterministic.
// Run: node test/lawbor.test.js
const assert = require('node:assert');
const { buildEnvelope, validateEnvelope, envelopeId, signablePayload } = require('../lib/envelope');
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
  await t('envelope: `viaHuman` is SIGNED — a relay cannot forge provenance by recomputing the id', () => {
    /* ⛔ L'ATTAQUE, MESUREE LE 2026-08-15. `envelopeId` couvrait `viaHuman`, la SIGNATURE non — et
     * l'en-tete affirmait que « both cover it now ». Un id est un sha256 de champs PUBLICS: un relais
     * intermediaire le recalcule sans secret. Il pouvait donc mettre viaHuman:'phil' sur le message
     * AUTONOME d'un bot, recalculer l'id, passer validateEnvelope ET la verification de signature —
     * puis node.js:163 (`origin: env.viaHuman ? 'human' : 'bot'`) le rangeait dans la BOITE DU HUMAIN,
     * attribue a une personne nommee. Le sens inverse cachait un message humain hors de l'inbox.
     * 💎 Seule la signature lie: un identifiant recalculable est une somme de controle, pas une preuve. */
    const { envelope: autonome } = buildEnvelope({ from: A, to: B, body: 'message autonome du bot', ts: 1783000000, nonce: 'n1' });
    assert.equal(autonome.viaHuman, null, 'temoin: le bot parle bien SANS humain');

    const forge = { ...autonome, viaHuman: 'phil' };
    forge.id = envelopeId(forge);                       // le relais recalcule l'id: aucun secret n'y entre
    assert.equal(validateEnvelope(forge).ok, true,
      'l id recalcule passe TOUJOURS le controle de structure — c est pourquoi il ne protege pas');

    // CE QUI DOIT DIFFERER: les bytes signes. Sinon la signature d origine couvre la forgerie.
    const sOrig = JSON.stringify(signablePayload(autonome).message);
    const sForge = JSON.stringify(signablePayload(forge).message);
    assert.notEqual(sOrig, sForge, 'viaHuman doit entrer dans les bytes signes, sinon la forgerie verifie');
    assert.match(sOrig, /"viaHuman":""/, 'absent normalise en chaine vide, comme dans envelopeId');
    assert.match(sForge, /"viaHuman":"phil"/);

    // CAS OPPOSE: le sens inverse (effacer une provenance humaine) doit aussi casser la signature.
    const { envelope: humain } = buildEnvelope({ from: A, to: B, body: 'msg', ts: 1783000000, nonce: 'n2', viaHuman: 'phil' });
    const efface = { ...humain, viaHuman: null };
    efface.id = envelopeId(efface);
    assert.notEqual(JSON.stringify(signablePayload(humain).message), JSON.stringify(signablePayload(efface).message),
      'effacer viaHuman doit casser la signature autant que l ajouter');

    // TEMOIN: deux enveloppes IDENTIQUES produisent le meme payload — le correctif n a rien rendu instable.
    const { envelope: jumeau } = buildEnvelope({ from: A, to: B, body: 'message autonome du bot', ts: 1783000000, nonce: 'n1' });
    assert.equal(JSON.stringify(signablePayload(jumeau).message), sOrig, 'meme entree -> memes bytes signes');
  });

  await t('relay LOOP BOUND: it is DEDUP that stops infinite circulation, not the hop cap', async () => {
    /* ⚠️ L'en-tete creditait le plafond de « no infinite relay loops ». `hops` n'est ni signe ni dans
     * l'id — il ne PEUT pas l'etre, chaque relais l'incremente — donc un relais hostile le remet a 0.
     * Mesure du 2026-08-15: le plafond borne UN CHEMIN TEL QU'IL SE DECLARE; c'est le dedup qui borne
     * la circulation (un id passe une fois par relais, donc au plus N relais dans un mesh de N).
     * ⛔ Ce test existe pour que rendre `seen` evictant ROUGISSE: ca rouvrirait la boucle, et le
     * plafond ne rattraperait rien. */
    const env = mkEnv(A, C, 'en transit');

    // (a) le plafond FAIT son travail sur une chaine honnete
    const neuf = createRelay({ self: B, preflight: proceed, peers: [A, C], maxHops: 6 });
    const trop = await neuf.accept({ ...env, hops: 7 });
    assert.equal(trop.action, 'drop');
    assert.match(trop.reason, /hop cap/, 'une chaine honnete trop longue est bien coupee');

    // (b) mais un relais hostile qui remet hops a 0 est arrete par le DEDUP, pas par le plafond
    const r = createRelay({ self: B, preflight: proceed, peers: [A, C], maxHops: 6 });
    assert.equal((await r.accept({ ...env, hops: 3 })).action, 'forward', 'premier passage: relaye');
    const rejeu = await r.accept({ ...env, hops: 0 });
    assert.equal(rejeu.action, 'drop');
    assert.match(rejeu.reason, /already seen/,
      'c est le DEDUP qui refuse le rejeu, pas le plafond — hops=0 le passerait');

    // (c) TEMOIN de la borne: un relais qui ne l a jamais vue RELAYE l enveloppe a hops remis a zero.
    // Sans ce cas, on croirait que le plafond protege quelque chose qu il ne protege pas.
    const jamaisVue = createRelay({ self: B, preflight: proceed, peers: [A, C], maxHops: 6 });
    assert.equal((await jamaisVue.accept({ ...env, hops: 0 })).action, 'forward',
      'le plafond n arrete PAS une enveloppe dont hops a ete remis a zero: seul le dedup la borne');
  });

  await t('relay DEDUP: the unbounded `seen` set is DISCLOSED and its growth is OBSERVABLE', async () => {
    /* `seen` grandit d'une entree par enveloppe, a vie, et c'est le choix CORRECT: evincer ferait
     * re-livrer une vieille enveloppe au premier rejeu de gossip. Ce qui manquait etait de le DIRE et
     * de le rendre mesurable — lib/mesh.js borne son memo explicitement (« bounded: drop oldest »),
     * meme depot, meme classe de structure, et ici rien n'annoncait la croissance. Sans compteur, une
     * croissance qu'on ne peut pas mesurer ne se decide pas. */
    const r = createRelay({ self: B, preflight: proceed, peers: [A, C] });
    assert.equal(r.seenCount, 0, 'un relais neuf n a rien vu');
    assert.equal(r.seenIsBounded, false, 'le Set par defaut est NON borne, et le dit');

    await r.accept(mkEnv(A, B, 'un'));
    assert.equal(r.seenCount, 1, 'une enveloppe acceptee est comptee');
    await r.accept(mkEnv(A, B, 'deux'));
    assert.equal(r.seenCount, 2, 'la croissance est visible, pas un instantane fige a la construction');

    // ⛔ CAS OPPOSE 1: un DROP ne doit RIEN retenir — sinon un expediteur refuse ferait grossir la
    // memoire du relais gratuitement, ce qui serait un vecteur d'epuisement au lieu d'un dedup.
    const bas = createRelay({ self: B, preflight: lowScore, peers: [A] });
    assert.equal((await bas.accept(mkEnv(A, B, 'spam'))).action, 'drop');
    assert.equal(bas.seenCount, 0, 'une enveloppe REFUSEE n entre pas dans le dedup');

    // ⛔ CAS OPPOSE 2: un Set INJECTE rend la politique a l operateur — on ne pretend pas la connaitre.
    const inj = createRelay({ self: B, preflight: proceed, peers: [A], seen: new Set() });
    assert.equal(inj.seenIsBounded, null, 'seen injecte: la politique appartient a l operateur, pas a nous');
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

  /* ---- defects found by an adversarial panel on 2026-07-18, each reproduced before fixing ----- */

  await t('TOCTOU: the same envelope over two gossip paths in one tick delivers ONCE', async () => {
    const slow = async () => { await new Promise((r) => setTimeout(r, 10)); return { decision: 'PROCEED', score: 80 }; };
    const r = createRelay({ self: B, preflight: slow });
    const env = mkEnv(A, B, 'deliver the work');
    const [x, y] = await Promise.all([r.accept(env), r.accept(env)]);
    assert.notEqual(x.action === 'deliver' && y.action === 'deliver', true, 'dedup must hold under concurrency');
    assert.equal([x, y].filter((o) => o.action === 'deliver').length, 1);
  });

  await t('a REFUSED envelope does not burn its id — the sender can legitimately retry', async () => {
    let n = 0;
    const flaky = async () => { n++; if (n === 1) throw new Error('oracle down'); return { decision: 'PROCEED', score: 80 }; };
    const r = createRelay({ self: B, preflight: flaky });
    const env = mkEnv(A, B, 'retry me');
    assert.equal((await r.accept(env)).action, 'drop');
    assert.equal((await r.accept(env)).action, 'deliver', 'a transient oracle failure must not blacklist the id');
  });

  await t('viaHuman is COVERED by the id: tampering WITHOUT recomputing the id is detected', () => {
    /* ⚠️ CE TEST S'APPELAIT « a relay cannot forge a bot message into the human inbox » — une
     * affirmation de SECURITE que son corps ne prouvait pas. Il altere `viaHuman` SANS recalculer
     * l'id, donc validateEnvelope echoue forcement. Or un relais qui veut forger RECALCULE l'id:
     * c'est un sha256 de champs publics, il n'y entre aucun secret. Le test modelisait un attaquant
     * qui fait MOINS que le vrai, et son nom promettait la propriete que cet ecart laissait ouverte.
     * 💎 Il reste utile — il prouve que l'id LIE le champ — mais son nom dit desormais ce qu'il prouve.
     * La propriete de securite est assertee par « `viaHuman` is SIGNED » plus haut, qui modelise
     * l'attaquant qui recalcule. Mesure du 2026-08-15. */
    const bot = buildEnvelope({ from: A, to: B, body: 'autonomous chatter', viaHuman: null }).envelope;
    assert.equal(validateEnvelope({ ...bot, viaHuman: 'phil' }).ok, false, 'setting viaHuman is detected');
    const human = buildEnvelope({ from: A, to: B, body: 'a person wrote this', viaHuman: 'phil' }).envelope;
    assert.equal(validateEnvelope({ ...human, viaHuman: null }).ok, false, 'stripping viaHuman is detected');
    assert.equal(validateEnvelope(bot).ok, true, 'and honest envelopes still validate');
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
