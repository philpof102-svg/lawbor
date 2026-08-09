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
 * ⛔ CORRECTION DU 2026-08-09 — LA RAISON ÉCRITE ICI ÉTAIT FAUSSE, ET ELLE COÛTAIT LA FONCTIONNALITÉ.
 * Ce fichier disait: « `lawbor` n'embarque pas d'`ecrecover` parce qu'il a ZÉRO dépendance par choix ».
 * Mesuré: `package.json` a bien `dependencies: {}` — mais aussi
 * **`optionalDependencies: { viem: "^2.21.0" }`**, que npm installe, et `lib/verify.js` est déjà un
 * adaptateur paresseux dessus. Mieux: `createAuthVerifier()` y répond EXACTEMENT à la question que la
 * moitié Base pose — « cette adresse a-t-elle signé cette chaîne » (EIP-191, `verifyMessage`).
 *
 * 💎 Le helper existait, et ce fichier — l'appelant à fort enjeu — ne l'appelait pas. La conséquence
 * n'était pas théorique: la moitié Base était déclarée impossible et portée sur la liste des décisions
 * de l'opérateur, alors qu'elle était déjà tranchée par le dépôt.
 *
 * ⛔ ET LE DÉFAUT SE CACHAIT DERRIÈRE UN REFUS. `jugerLiaison` faisait `verifier(...) === true` en
 * SYNCHRONE; `createAuthVerifier` est `async`. Une Promise n'est jamais `=== true`, donc brancher le
 * seul ecrecover disponible aurait produit un refus PERMANENT et SILENCIEUX. Fail-closed, donc pas un
 * trou de sécurité — mais une porte qui ne s'ouvre jamais, invisible à tout test, parce qu'un refus
 * ressemble à un refus. Le maillon est désormais `async`, et il accepte toujours les vérificateurs
 * synchrones (`await` sur une valeur rend la valeur).
 *
 * ⚠️ LA PROPRIÉTÉ FAIL-CLOSED EST CONSERVÉE. `viem` reste OPTIONNEL: s'il n'est pas installé,
 * `createAuthVerifier()` rend `null`, ce module refuse comme avant, et il DIT laquelle des deux
 * moitiés manque au lieu de rendre un `false` muet.
 *
 * USAGE:
 *   LAWBOR_BINDING_VERIFIER=./examples/binding-verifier.js   → les DEUX moitiés si viem est là
 *   ou, dans votre propre module:  module.exports = faireVerificateur({ ecrecover })
 */
const crypto = require('node:crypto');
const { createAuthVerifier } = require('../lib/verify');

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
/**
 * L'`ecrecover` que le dépôt sait déjà fournir, adapté au contrat attendu ici.
 *
 * `createAuthVerifier()` rend `verifyAuth({message, sig, claimed}) → {ok, signer}` ou **null** quand
 * viem est absent. On propage ce `null`: « pas d'ecrecover » reste un état supporté, pas une panne.
 *
 * ⚠️ C'est une vérification CONTRE UNE ADRESSE FIXE, pas une récupération de clé. `lib/verify.js` le
 * dit explicitement et interdit de « l'optimiser » en `recover…Address` sans garder la comparaison:
 * une signature valide par la MAUVAISE clé doit rester refusée.
 */
function ecrecoverDuDepot() {
  const verifyAuth = createAuthVerifier();
  if (!verifyAuth) return null;                    // viem absent — le module refusera, et dira pourquoi
  return async function ecrecover({ message, signature, address }) {
    const r = await verifyAuth({ message, sig: signature, claimed: address });
    return !!(r && r.ok === true);
  };
}

function faireVerificateur(deps = {}) {
  /* ⚠️ `'ecrecover' in deps` PLUTÔT QU'UN DÉFAUT: un `null` EXPLICITE doit pouvoir dire « pas
   * d'ecrecover » quoi qu'il soit installé sur la machine de test. C'est l'idiome que `lib/verify.js`
   * emploie déjà pour viem — sans lui, le cas « moitié manquante » deviendrait intestable dès que
   * viem est présent, c'est-à-dire précisément après ce correctif. */
  const ecrecover = ('ecrecover' in deps) ? deps.ecrecover : ecrecoverDuDepot();
  const { decodeSig = null } = deps;

  const enOctets = decodeSig || ((s) => {
    const t = String(s || '').replace(/^0x/, '');
    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return Buffer.from(t, 'hex');
    return Buffer.from(String(s || ''), 'base64');
  });

  return async function verifier({ message, attestation }) {
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

    /* ── 2. LE CÔTÉ BASE — DÉSORMAIS FAISABLE, MAIS SEULEMENT SI viem EST LÀ ──────────────────────── */
    if (typeof ecrecover !== 'function') {
      /* On n'arrive ici que si viem est absent (dépendance OPTIONNELLE) ou si l'appelant a passé un
       * `ecrecover: null` explicite. Les deux sont des états supportés, et le refus reste correct. */
      /* ⛔ ICI EST TOUT L'ENJEU. La moitié DID vient de passer — la tentation est de rendre `true`.
       * Mais la liaison est BIDIRECTIONNELLE: sans la signature Base, n'importe qui possédant un DID
       * pourrait revendiquer l'adresse de quelqu'un d'autre en ne signant que de son côté. C'est
       * exactement l'usurpation que toute la chaîne d'admission existe pour empêcher. */
      return false;
    }
    if (!a.sigBase || !a.address) return false;
    /* ⛔ L'`await` EST LE CORRECTIF. Sans lui, une Promise n'est jamais `=== true` et le seul ecrecover
     * que ce dépôt sait construire refusait TOUJOURS, en silence. */
    try { return (await ecrecover({ message: String(message), signature: a.sigBase, address: a.address })) === true; }
    catch { return false; }                         // un ecrecover qui jette n'est pas un ecrecover qui dit oui
  };
}

/* L'export par défaut vérifie désormais les DEUX moitiés quand `viem` est installé — c'est-à-dire dans
 * toute installation normale, puisque le paquet le tire. Sans viem il refuse, exactement comme avant.
 * ⚠️ Ce qui n'a PAS changé: il ne rend jamais `true` sur une seule moitié. La liaison est
 * bidirectionnelle par conception, et c'est ce que les tests asservissent. */
module.exports = faireVerificateur();
module.exports.faireVerificateur = faireVerificateur;
module.exports.ecrecoverDuDepot = ecrecoverDuDepot;
module.exports.cleDepuisDid = cleDepuisDid;
module.exports.base58Decode = base58Decode;
