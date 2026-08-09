#!/usr/bin/env node
'use strict';
/**
 * binding-verifier: la moitié faisable doit marcher POUR DE VRAI, et l'autre doit refuser.
 *
 * ⛔ LE CAS QUI PORTE TOUT: la signature `did:key` peut être parfaitement valide et le vérificateur
 * doit QUAND MÊME rendre `false` sans `ecrecover`. La liaison est BIDIRECTIONNELLE — sans la signature
 * Base, n'importe qui possédant un DID revendiquerait l'adresse d'autrui en ne signant que de son côté.
 * C'est l'usurpation que toute la chaîne d'admission existe pour empêcher, et c'est la tentation
 * naturelle une fois qu'une moitié passe.
 *
 * ⚠️ ET LES CLÉS SONT VRAIES. `node:crypto` génère un vrai couple Ed25519, on construit un vrai
 * `did:key` à partir de la clé publique, on signe le vrai message canonique. Un test avec des
 * signatures factices prouverait que le code lit des chaînes, pas qu'il vérifie une signature.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const { faireVerificateur, cleDepuisDid, base58Decode } = require('../examples/binding-verifier');
const { messageDeLiaison } = require('../lib/did-binding');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('binding-verifier: la moitie DID vraiment verifiee, l autre honnetement refusee');

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

/* ── 1. LA MOITIÉ FAISABLE MARCHE POUR DE VRAI ────────────────────────────────────────────────────── */

t('★ un vrai did:key se decode en sa cle publique de 32 octets', () => {
  const id = identite();
  const lue = cleDepuisDid(id.did);
  assert.ok(Buffer.isBuffer(lue), 'le decodage doit rendre des octets');
  assert.strictEqual(lue.length, 32);
  assert.ok(lue.equals(id.brute), 'la cle relue doit etre EXACTEMENT celle qui a genere le did');
});

t('★ avec un ecrecover fourni, une VRAIE signature Ed25519 est acceptee', () => {
  const id = identite();
  const msg = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const v = faireVerificateur({ ecrecover: () => true });
  assert.strictEqual(v({ message: msg, attestation: attestation(id, msg) }), true,
    'sans ce cas, un verificateur qui refuse TOUT passerait tous les tests de refus ci-dessous');
});

t('★ une signature faite sur un AUTRE message est refusee — la signature est vraiment verifiee', () => {
  const id = identite();
  const bon = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const autre = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-2' });
  const v = faireVerificateur({ ecrecover: () => true });
  /* Signee sur `autre`, presentee comme couvrant `bon`: c est exactement un rejeu de signature. */
  assert.strictEqual(v({ message: bon, attestation: attestation(id, autre) }), false);
});

t("★ la signature d'une AUTRE identite ne passe pas pour celle du DID annonce", () => {
  const vrai = identite(), imposteur = identite();
  const msg = messageDeLiaison({ did: vrai.did, address: ADR, nonce: 'n-1' });
  const att = attestation(imposteur, msg);
  att.did = vrai.did;                                   // l imposteur annonce le DID d un autre
  const v = faireVerificateur({ ecrecover: () => true });
  assert.strictEqual(v({ message: msg, attestation: att }), false, 'usurpation de DID refusee');
});

/* ── 2. CE QUI PORTE LE PLUS: LA MOITIÉ MANQUANTE REFUSE ──────────────────────────────────────────── */

t('★ SANS ecrecover: la signature DID est VALIDE et le verdict reste FAUX', () => {
  const id = identite();
  const msg = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const att = attestation(id, msg);
  /* Preuve que la moitie DID passe vraiment, pour que le refus ci-dessous ne soit pas un echec deguise. */
  assert.strictEqual(faireVerificateur({ ecrecover: () => true })({ message: msg, attestation: att }), true);
  /* Et le meme cas, sans ecrecover: */
  assert.strictEqual(require('../examples/binding-verifier')({ message: msg, attestation: att }), false,
    'rendre true sur une moitie laisserait n importe quel porteur de DID revendiquer l adresse d autrui');
});

t('un ecrecover qui refuse fait refuser, et un ecrecover qui JETTE aussi', () => {
  const id = identite();
  const msg = messageDeLiaison({ did: id.did, address: ADR, nonce: 'n-1' });
  const att = attestation(id, msg);
  assert.strictEqual(faireVerificateur({ ecrecover: () => false })({ message: msg, attestation: att }), false);
  assert.strictEqual(faireVerificateur({ ecrecover: () => { throw new Error('libsecp absente'); } })
    ({ message: msg, attestation: att }), false, 'un ecrecover qui jette n est pas un ecrecover qui dit oui');
});

/* ── 3. LES ENTRÉES QU'ON NE DEVINE PAS ───────────────────────────────────────────────────────────── */

t('un DID mal forme, d une autre courbe, ou absent: refus sans supposition', () => {
  const v = faireVerificateur({ ecrecover: () => true });
  for (const d of [undefined, null, '', 'pas-un-did', 'did:web:exemple.fr',
    'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme']) {   // secp256k1, pas Ed25519
    assert.strictEqual(cleDepuisDid(d), null, 'did=' + String(d));
    assert.strictEqual(v({ message: 'm', attestation: { did: d, sigDid: 'aa', address: ADR } }), false);
  }
});

t('base58Decode preserve les zeros de tete — sinon la cle relue serait tronquee', () => {
  const avecZeros = Buffer.from([0, 0, 1, 2, 3]);
  assert.ok(base58Decode(base58Encode(avecZeros)).equals(avecZeros));
});

const ATTENDUS = 8;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
