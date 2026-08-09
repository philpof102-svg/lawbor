'use strict';
/**
 * binding-verifier.js — un vérificateur de référence pour `LAWBOR_BINDING_VERIFIER`.
 * ================================================================================================
 * `did-binding.js` refuse de lier quoi que ce soit sans vérificateur de signatures — c'est ce qui
 * sépare une LIAISON prouvée d'une PRÉTENTION. Mais dire « ça s'injecte » ne suffit pas: si personne ne
 * peut en écrire un, la fonctionnalité reste théorique. Ce fichier existe pour que la moitié faisable
 * le soit vraiment, et pour NOMMER précisément la moitié qui ne l'est pas.
 *
 * ═══ CE QUE `node:crypto` PEUT ET NE PEUT PAS, MESURÉ AVANT D'ÉCRIRE ═══
 *
 *   Ed25519 (la courbe des `did:key`)  ✅ NATIF — `crypto.verify(null, msg, cle, sig)` fonctionne.
 *   courbe secp256k1                   ✅ présente.
 *   keccak256                          ⛔ ABSENT — `crypto.getHashes()` ne contient aucun `keccak`.
 *
 * ⛔ ET LA DERNIÈRE LIGNE DÉCIDE TOUT LE FICHIER. Ethereum/Base hachent en **Keccak-256**, qui n'est PAS
 * `sha3-256`: les deux normes diffèrent par leur padding et produisent des empreintes différentes.
 * `ecrecover` — retrouver l'adresse Base qui a signé — est donc IMPOSSIBLE avec la bibliothèque
 * standard seule. Ce n'est pas une limite de ce fichier, c'est une limite de Node.
 *
 * ═══ CE QUE CE VÉRIFICATEUR FAIT DONC ═══
 *
 *   · il vérifie RÉELLEMENT la signature `did:key` (Ed25519) contre le message canonique ;
 *   · il REFUSE tant que le côté Base n'est pas vérifié, et dit exactement ce qui manque.
 *
 * ⛔ IL NE REND JAMAIS `true` SUR UNE MOITIÉ. La liaison est BIDIRECTIONNELLE par conception: si une
 * seule des deux clés a signé, n'importe qui pourrait revendiquer l'adresse d'un autre en signant de
 * son côté. Rendre `true` ici serait exactement l'usurpation que toute la chaîne existe pour empêcher.
 *
 * ⚠️ POUR ALLER JUSQU'AU BOUT, l'opérateur passe un `ecrecover` — une ligne avec `viem`, `ethers` ou
 * `@noble/curves`. `lawbor` ne l'embarque pas parce qu'il a ZÉRO dépendance par choix, et
 * `lib/relay.js` avait déjà tranché ce compromis en injectant la vérification d'enveloppe.
 *
 * USAGE:
 *   LAWBOR_BINDING_VERIFIER=./examples/binding-verifier.js      → moitié DID vérifiée, refuse ensuite
 *   ou, dans votre propre module:  module.exports = faireVerificateur({ ecrecover })
 */
const crypto = require('node:crypto');

/* Le préfixe multicodec d'une clé publique Ed25519 dans un `did:key`: 0xed 0x01, puis 32 octets. */
const PREFIXE_ED25519 = Buffer.from([0xed, 0x01]);
const ALPHABET_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58btc → octets. Écrit ici parce que `node:crypto` ne le fournit pas et qu'on refuse les deps. */
function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET_B58.indexOf(c);
    if (i < 0) throw new Error('caractere base58 invalide: ' + c);
    n = n * 58n + BigInt(i);
  }
  const octets = [];
  while (n > 0n) { octets.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; octets.unshift(0); }   // les zeros de tete
  return Buffer.from(octets);
}

/**
 * Extrait la clé publique Ed25519 brute d'un `did:key:z...`.
 * @returns {Buffer|null} null si ce n'est pas un did:key Ed25519 — on ne devine pas.
 */
function cleDepuisDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) return null;
  let brut;
  try { brut = base58Decode(did.slice('did:key:z'.length)); } catch { return null; }
  if (brut.length !== PREFIXE_ED25519.length + 32) return null;
  if (!brut.subarray(0, 2).equals(PREFIXE_ED25519)) return null;    // autre courbe: pas notre affaire
  return brut.subarray(2);
}

/** Emballe une clé Ed25519 brute au format que `crypto.verify` attend (SPKI DER). */
function cleVerifiable(brute) {
  const entete = Buffer.from('302a300506032b6570032100', 'hex');    // SPKI Ed25519, 12 octets
  return crypto.createPublicKey({ key: Buffer.concat([entete, brute]), format: 'der', type: 'spki' });
}

/**
 * Fabrique le vérificateur que `makeLireLiaison` attend.
 *
 * @param {object} [deps]
 * @param {(o:{message:string, signature:string, address:string})=>boolean} [deps.ecrecover]
 *        vérifie la signature BASE. Sans lui, ce vérificateur refuse — voir l'en-tête.
 * @param {(s:string)=>Buffer} [deps.decodeSig] décodeur de `sigDid` (hex ou base64), défaut: hex puis base64
 * @returns {(o:{message:string, attestation:object})=>boolean}
 */
function faireVerificateur(deps = {}) {
  const { ecrecover = null, decodeSig = null } = deps;

  const enOctets = decodeSig || ((s) => {
    const t = String(s || '').replace(/^0x/, '');
    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return Buffer.from(t, 'hex');
    return Buffer.from(String(s || ''), 'base64');
  });

  return function verifier({ message, attestation }) {
    const a = attestation || {};

    /* ── 1. LE CÔTÉ DID, VÉRIFIÉ POUR DE VRAI ─────────────────────────────────────────────────────── */
    const brute = cleDepuisDid(a.did);
    if (!brute) return false;                       // pas un did:key Ed25519 → on ne prétend rien
    if (!a.sigDid) return false;
    let didOk = false;
    try {
      didOk = crypto.verify(null, Buffer.from(String(message), 'utf8'), cleVerifiable(brute), enOctets(a.sigDid));
    } catch { return false; }                       // signature illisible: refus, jamais une supposition
    if (!didOk) return false;

    /* ── 2. LE CÔTÉ BASE, QU'ON NE PEUT PAS FAIRE SEUL ────────────────────────────────────────────── */
    if (typeof ecrecover !== 'function') {
      /* ⛔ ICI EST TOUT L'ENJEU. La moitié DID vient de passer — la tentation est de rendre `true`.
       * Mais la liaison est BIDIRECTIONNELLE: sans la signature Base, n'importe qui possédant un DID
       * pourrait revendiquer l'adresse de quelqu'un d'autre en ne signant que de son côté. C'est
       * exactement l'usurpation que toute la chaîne d'admission existe pour empêcher. */
      return false;
    }
    if (!a.sigBase || !a.address) return false;
    try { return ecrecover({ message: String(message), signature: a.sigBase, address: a.address }) === true; }
    catch { return false; }                         // un ecrecover qui jette n'est pas un ecrecover qui dit oui
  };
}

/* L'export par défaut: utilisable tel quel, et il refusera tant qu'un `ecrecover` n'est pas fourni.
 * C'est voulu — un vérificateur livré « qui marche » sans vérifier la moitié Base serait un piège. */
module.exports = faireVerificateur();
module.exports.faireVerificateur = faireVerificateur;
module.exports.cleDepuisDid = cleDepuisDid;
module.exports.base58Decode = base58Decode;
