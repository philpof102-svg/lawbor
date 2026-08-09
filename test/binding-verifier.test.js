#!/usr/bin/env node
'use strict';
/**
 * binding-verifier: les DEUX moitiés doivent marcher POUR DE VRAI, et une seule ne suffit jamais.
 *
 * ⛔ LE CAS QUI PORTE TOUT: la signature `did:key` peut être parfaitement valide et le vérificateur
 * doit QUAND MÊME rendre `false` sans la moitié Base. La liaison est BIDIRECTIONNELLE — sans elle,
 * n'importe qui possédant un DID revendiquerait l'adresse d'autrui en ne signant que de son côté.
 *
 * ⚠️ ET LES CLÉS SONT VRAIES, DES DEUX CÔTÉS. `node:crypto` génère un vrai couple Ed25519 pour le DID,
 * et `viem` un vrai couple secp256k1 pour l'adresse Base. Un test avec des signatures factices
 * prouverait que le code lit des chaînes, pas qu'il vérifie une signature.
 *
 * ⛔ ET LE CAS QUI A MOTIVÉ LA RÉVISION DU 2026-08-09: un `ecrecover` ASYNCHRONE. Le vérificateur
 * faisait `ecrecover(...) === true` en synchrone; le seul ecrecover que ce dépôt sache construire
 * (`lib/verify.js::createAuthVerifier`, sur viem) est `async`. Une Promise n'est jamais `=== true`,
 * donc il refusait TOUJOURS, en silence. Un refus permanent ressemble à un refus légitime: aucun test
 * de refus ne pouvait le voir. Il en faut un qui exige un SUCCÈS.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const { faireVerificateur, cleDepuisDid, base58Decode, ecrecoverDuDepot } = require('../examples/binding-verifier');
const { messageDeLiaison } = require('../lib/did-binding');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('binding-verifier: les deux moities vraiment verifiees, une seule jamais suffisante');

/* Encodeur base58 — cote TEST seulement, pour fabriquer un did:key a partir d une vraie cle. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}

/** Un vrai couple Ed25519 + le did:key qui lui correspond. */
function identite() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const brute = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);   // 32 octets
  const did = 'did:key:z' + base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), brute]));
  return { did, privateKey, brute };
}

const ADR = '0x' + 'a'.repeat(40);
const attestation = (id, msg) => ({ did: id.did, address: ADR, nonce: 'n-1', chainId: 8453, expiry: 0,
  sigDid: crypto.sign(null, Buffer.from(msg, 'utf8'), id.privateKey).toString('hex'), sigBase: '0xdeadbeef' });

/* ⛔ `ecrecover: null` EXPLICITE, et non « pas de clé ». Depuis que la moitié Base est branchée sur
 * viem, omettre la clé donne l'ecrecover DU DÉPÔT — le cas « moitié manquante » deviendrait donc
 * intestable sur toute machine où viem est installé, c'est-à-dire toutes. */
const SANS_BASE = { ecrecover: null };

/* ── 1. LA MOITIÉ DID, VÉRIFIÉE POUR DE VRAI ──────────────────────────────────────────────────────── */

t('★ un vrai did:key se decode en sa cle publique de 32 octets', () => {
  const id = identite();
  const lue = cleDepuisDid(id.did);
  assert.ok(Buffer.isBuffer(lue), 'le decodage doit rendre des octets');
  assert.strictEqual(lue.length, 32);
  assert.ok(lue.equals(id.brute), 'la cle relue doit etre EXACTEMENT celle qui a genere le did');
});

t('★ avec un ecrecover fourni, une VRAIE signature Ed25519 est acceptee', async () => {
  const id = identite();
  const msg = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const v = faireVerificateur({ ecrecover: () => true });
  assert.strictEqual(await v({ message: msg, attestation: attestation(id, msg) }), true,
    'sans ce cas, un verificateur qui refuse TOUT passerait tous les tests de refus ci-dessous');
});

t('★ une signature faite sur un AUTRE message est refusee — la signature est vraiment verifiee', async () => {
  const id = identite();
  const bon = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const autre = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-2' });
  const v = faireVerificateur({ ecrecover: () => true });
  /* Signee sur `autre`, presentee comme couvrant `bon`: c est exactement un rejeu de signature. */
  assert.strictEqual(await v({ message: bon, attestation: attestation(id, autre) }), false);
});

t("★ la signature d'une AUTRE identite ne passe pas pour celle du DID annonce", async () => {
  const vrai = identite(), imposteur = identite();
  const msg = messageDeLiaison({ did: vrai.did, address: ADR, nonce: 'n-1' });
  const att = attestation(imposteur, msg);
  att.did = vrai.did;                                   // l imposteur annonce le DID d un autre
  const v = faireVerificateur({ ecrecover: () => true });
  assert.strictEqual(await v({ message: msg, attestation: att }), false, 'usurpation de DID refusee');
});

/* ── 2. CE QUI PORTE LE PLUS: UNE SEULE MOITIÉ NE SUFFIT JAMAIS ───────────────────────────────────── */

t('★ SANS moitie Base: la signature DID est VALIDE et le verdict reste FAUX', async () => {
  const id = identite();
  const msg = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const att = attestation(id, msg);
  /* Preuve que la moitie DID passe vraiment, pour que le refus ci-dessous ne soit pas un echec deguise. */
  assert.strictEqual(await faireVerificateur({ ecrecover: () => true })({ message: msg, attestation: att }), true);
  /* Et le meme cas, sans ecrecover: */
  assert.strictEqual(await faireVerificateur(SANS_BASE)({ message: msg, attestation: att }), false,
    'rendre true sur une moitie laisserait n importe quel porteur de DID revendiquer l adresse d autrui');
});

t('un ecrecover qui refuse fait refuser, et un ecrecover qui JETTE aussi', async () => {
  const id = identite();
  const msg = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const att = attestation(id, msg);
  assert.strictEqual(await faireVerificateur({ ecrecover: () => false })({ message: msg, attestation: att }), false);
  assert.strictEqual(await faireVerificateur({ ecrecover: () => { throw new Error('libsecp absente'); } })
    ({ message: msg, attestation: att }), false, 'un ecrecover qui jette n est pas un ecrecover qui dit oui');
  /* ⚠️ Et une Promise REJETEE doit atterrir au meme endroit qu un throw synchrone. */
  assert.strictEqual(await faireVerificateur({ ecrecover: async () => { throw new Error('rpc down'); } })
    ({ message: msg, attestation: att }), false, 'un rejet asynchrone n est pas un oui non plus');
});

/* ── 3. LE DÉFAUT DU 2026-08-09: UN ECRECOVER ASYNCHRONE DOIT MARCHER ─────────────────────────────── */

t('★ un ecrecover ASYNCHRONE est vraiment attendu — le defaut qui refusait en silence', async () => {
  const id = identite();
  const msg = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const att = attestation(id, msg);
  /* ⛔ CE CAS EXIGE UN SUCCES, et c est la seule forme qui pouvait voir le defaut: avant le correctif,
   * `Promise === true` valait false, donc le verdict etait `false` — indiscernable d un refus legitime
   * pour tout test qui n attend qu un refus. */
  assert.strictEqual(await faireVerificateur({ ecrecover: async () => true })({ message: msg, attestation: att }), true,
    'un ecrecover async doit etre AWAIT: sinon le seul ecrecover du depot refuse toujours, en silence');
  /* Le cas OPPOSE, pour que le succes ci-dessus ne vienne pas d un `await` qui accepte n importe quoi. */
  assert.strictEqual(await faireVerificateur({ ecrecover: async () => false })({ message: msg, attestation: att }), false);
});

/* ── 4. LA MOITIÉ BASE POUR DE VRAI, AVEC UNE SIGNATURE secp256k1 GÉNÉRÉE ICI ─────────────────────── */

t('★ CHAINE COMPLETE: deux VRAIES signatures, Ed25519 pour le DID et secp256k1 pour l adresse', async () => {
  let viem, comptes;
  try { viem = require('viem'); comptes = require('viem/accounts'); }
  catch { console.log('       (viem absent — cas non applicable, et c est un etat supporte)'); return; }

  const id = identite();
  /* Un vrai couple secp256k1, et l adresse qui en DERIVE — pas une adresse choisie. */
  const compte = comptes.privateKeyToAccount('0x' + '2b'.repeat(32));
  const msg = messageDeLiaison({ did: id.did, address: compte.address, nonce: 'n-1' });

  const att = { did: id.did, address: compte.address, nonce: 'n-1', chainId: 8453, expiry: 0,
    sigDid: crypto.sign(null, Buffer.from(msg, 'utf8'), id.privateKey).toString('hex'),
    sigBase: await compte.signMessage({ message: msg }) };

  const v = faireVerificateur();                       // l ecrecover DU DEPOT, pas un bouchon
  assert.strictEqual(await v({ message: msg, attestation: att }), true,
    'les deux moities signees pour de vrai doivent produire une liaison');

  /* ⛔ LE CAS OPPOSE QUI COMPTE: meme signature Base, presentee pour une AUTRE adresse. Une signature
   * valide par la MAUVAISE cle doit rester refusee — c est l usurpation cote Base. */
  const autre = comptes.privateKeyToAccount('0x' + '3c'.repeat(32));
  assert.strictEqual(await v({ message: msg, attestation: { ...att, address: autre.address } }), false,
    'la signature d une adresse ne doit pas valider une autre adresse');

  /* Et une signature Base faite sur un AUTRE message: rejeu refuse. */
  const autreMsg = messageDeLiaison({ did: id.did, address: compte.address, nonce: 'n-2' });
  assert.strictEqual(await v({ message: msg,
    attestation: { ...att, sigBase: await compte.signMessage({ message: autreMsg }) } }), false,
    'une signature Base valide sur un autre message est un rejeu');
});

t('l ecrecover du depot EXISTE quand viem est la — temoin de la capacite', () => {
  let present = true;
  try { require('viem'); } catch { present = false; }
  const ec = ecrecoverDuDepot();
  if (present) {
    assert.strictEqual(typeof ec, 'function',
      'viem est installe: la moitie Base doit etre disponible, sinon le refus serait un mensonge');
  } else {
    assert.strictEqual(ec, null, 'sans viem, l absence doit etre un `null` explicite, pas un throw');
  }
});

/* ── 5. LES ENTRÉES QU'ON NE DEVINE PAS ───────────────────────────────────────────────────────────── */

t('un DID mal forme, d une autre courbe, ou absent: refus sans supposition', async () => {
  const v = faireVerificateur({ ecrecover: () => true });
  for (const d of [undefined, null, '', 'pas-un-did', 'did:web:exemple.fr',
    'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme']) {   // secp256k1, pas Ed25519
    assert.strictEqual(cleDepuisDid(d), null, 'did=' + String(d));
    assert.strictEqual(await v({ message: 'm', attestation: { did: d, sigDid: 'aa', address: ADR } }), false);
  }
});

t('base58Decode preserve les zeros de tete — sinon la cle relue serait tronquee', () => {
  const avecZeros = Buffer.from([0, 0, 1, 2, 3]);
  assert.ok(base58Decode(base58Encode(avecZeros)).equals(avecZeros));
});

const ATTENDUS = 11;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
