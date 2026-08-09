'use strict';
/**
 * did-binding.js — l'adresse au bout d'une enveloppe appartient-elle VRAIMENT à ce DID gitlawb ?
 * ================================================================================================
 * Dernier morceau du preflight d'admission. `admission-gitlawb.js` décide, `gitlawb-standing.js` lit la
 * réputation d'un DID — encore faut-il savoir QUEL DID correspond à l'adresse qui frappe à la porte.
 *
 * ⛔ ET C'EST LE MAILLON OÙ UNE PORTE S'OUVRE EN GRAND SI ON SE TROMPE. Le standing gitlawb est
 * attaché à un DID. Si n'importe qui peut prétendre « mon adresse = ce DID », alors n'importe qui
 * emprunte la réputation d'un agent établi. La liaison n'est donc PAS une déclaration: c'est une
 * attestation BIDIRECTIONNELLE — la clé d'identité ET la clé Base signent le MÊME message canonique.
 * Chacun peut la revérifier sans nous croire. C'est ce qui la rend utilisable par un tiers.
 *
 * ═══ POURQUOI LA VÉRIFICATION DE SIGNATURE EST INJECTÉE ═══
 *
 * `lawbor` n'a AUCUNE dépendance, et ça n'est pas un accident: recouvrer un signataire secp256k1 exige
 * `ecrecover`, valider un `did:key` Ed25519 exige une autre courbe encore. `lib/relay.js` a déjà tranché
 * ce compromis pour les enveloppes — « Verification is INJECTED » — et ce fichier suit exactement le
 * même chemin plutôt que d'en inventer un second.
 *
 * ⛔ CONSÉQUENCE, ET ELLE EST LA RÈGLE PRINCIPALE ICI: sans vérificateur, `bound` vaut FAUX. Jamais
 * « probablement ». Une attestation structurellement impeccable dont personne n'a validé les signatures
 * est une PRÉTENTION — et `admission-gitlawb.js` la refuse déjà sous ce nom. Ce fichier ne doit jamais
 * lui fournir un `bound: true` qu'il n'a pas mérité.
 *
 * ⚠️ ET L'EXPIRATION EST UNE VRAIE VÉRIFICATION, PAS UNE FORMALITÉ. Une liaison sans fin transforme une
 * clé compromise un jour en accès permanent: la rotation ne peut pas rattraper ce qui n'expire jamais.
 * Une attestation expirée est donc refusée même signée — et « pas de date d'expiration » est un cas
 * DISTINCT, rendu tel quel, pour que l'opérateur choisisse s'il l'accepte.
 */

/** Un `did:key` bien formé. On ne valide pas la courbe ici — le vérificateur injecté le fait. */
const FORME_DID = /^did:[a-z0-9]+:[A-Za-z0-9._%-]+$/;
const FORME_ADRESSE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Le message canonique que LES DEUX clés doivent avoir signé.
 *
 * ⛔ Son ordre et son format sont le contrat: un vérificateur tiers le reconstruit à l'identique ou la
 * vérification échoue. Le changer casse toutes les attestations existantes — donc il ne se change pas,
 * on en versionne un nouveau.
 */
function messageDeLiaison({ did, address, nonce, chainId = 8453, expiry = 0 } = {}) {
  return [
    'lawbor-did-binding/v1',
    'did: ' + String(did || '-'),
    'address: ' + String(address || '-').toLowerCase(),
    'chainId: ' + String(chainId),
    'nonce: ' + String(nonce || '-'),
    'expiry: ' + String(expiry || 0),
  ].join('\n');
}

/**
 * Juge une attestation. PUR: aucune horloge implicite, aucun disque, aucun réseau.
 *
 * @param {object|null} att  { did, address, nonce, chainId?, expiry?, sigDid?, sigBase? }
 * @param {object} o
 * @param {number} o.now
 * @param {(a:{message:string, attestation:object})=>boolean|Promise<boolean>} [o.verifier]
 *        injecté; son absence => bound:false. SYNCHRONE OU ASYNCHRONE — voir ci-dessous.
 * @returns {Promise<{bound:boolean, did:string|null, address:string|null, message:string|null, raison:string, reVerify:string}>}
 *
 * ⛔ CETTE FONCTION EST `async` PARCE QU'ELLE NE POUVAIT PAS APPELER LE SEUL VERIFICATEUR DU DEPOT.
 * Elle faisait `verifier(...) === true` en synchrone. Or `lib/verify.js::createAuthVerifier` — le
 * `verifyMessage` de viem, c'est-a-dire exactement l'`ecrecover` que la liaison reclame — est `async`.
 * Une Promise n'est jamais `=== true`, donc le seul ecrecover disponible ici REFUSAIT toujours, en
 * silence. Fail-CLOSED, donc pas un trou de securite: une porte qui ne s'ouvre jamais, et aucun test
 * ne le voyait parce qu'un refus ressemble a un refus.
 *
 * ⚠️ Et le reste de la chaine etait DEJA asynchrone — `lireLiaison` et `preflightGitlawb` `await`. Ce
 * maillon-ci etait le seul synchrone, et c'est celui qui bloquait la capacite que le paquet embarque.
 *
 * `await` sur une valeur non-Promise rend la valeur, donc les verificateurs SYNCHRONES continuent de
 * marcher a l'identique: c'est un elargissement, pas un remplacement.
 */
async function jugerLiaison(att, { now = 0, verifier = null } = {}) {
  const reVerify = 'reconstruire `message` avec messageDeLiaison() puis verifier LES DEUX signatures: '
    + 'sigBase (ecrecover vers `address`) ET sigDid (la courbe du did:key). Ne pas nous croire.';
  const non = (raison, extra = {}) => ({ bound: false, did: null, address: null, message: null,
    raison, reVerify, ...extra });

  if (!att || typeof att !== 'object') return non('aucune attestation pour cette adresse');
  const did = typeof att.did === 'string' ? att.did.trim() : '';
  const address = typeof att.address === 'string' ? att.address.trim() : '';
  if (!FORME_DID.test(did)) return non('DID absent ou mal forme — rien a interroger sur le reseau');
  if (!FORME_ADRESSE.test(address)) return non('adresse absente ou mal formee');
  if (!att.nonce) {
    /* Sans nonce, une attestation signee une fois se rejoue indefiniment sur une autre liaison. */
    return non('attestation SANS NONCE: elle serait rejouable telle quelle', { did });
  }

  const message = messageDeLiaison({ did, address, nonce: att.nonce, chainId: att.chainId, expiry: att.expiry });
  const expiry = Number(att.expiry) || 0;
  if (expiry > 0 && Number.isFinite(now) && now >= expiry) {
    return { bound: false, did, address, message, reVerify,
      raison: 'attestation EXPIREE — une liaison perimee reste refusee meme signee, sinon une cle '
        + 'compromise un jour donnerait un acces permanent' };
  }

  if (typeof verifier !== 'function') {
    /* ⛔ LE CAS QUI PROTEGE TOUT LE RESTE. Structure parfaite + personne pour valider les signatures
     * = une PRETENTION. `admission-gitlawb.js` la refuse sous ce nom exact. */
    return { bound: false, did, address, message, reVerify,
      raison: 'aucun verificateur de signature fourni: structure conforme mais RIEN n est prouve — '
        + 'c est une pretention, pas une liaison' };
  }

  let ok = false;
  /* ⛔ L'`await` EST DANS LE `try`, ET C'EST LOAD-BEARING. Une Promise REJETEE doit atterrir dans la
   * meme branche qu'un verificateur synchrone qui JETTE — sinon une panne de crypto asynchrone
   * remonterait en rejet non gere au lieu d'etre nommee « on n a pas pu verifier ». */
  try { ok = (await verifier({ message, attestation: att })) === true; }
  catch (e) {
    /* Un verificateur qui JETTE n'est pas un verificateur qui dit non: le distinguer evite de lire une
     * panne de crypto comme une signature invalide. */
    return { bound: false, did, address, message, reVerify,
      raison: 'le verificateur de signature a ECHOUE (' + String((e && e.message) || e)
        + ') — ce n est pas « signature invalide », c est « on n a pas pu verifier »' };
  }
  if (!ok) {
    return { bound: false, did, address, message, reVerify, raison: 'signatures INVALIDES pour ce message' };
  }
  return { bound: true, did, address, message, reVerify,
    raison: 'liaison bidirectionnelle verifiee' + (expiry > 0 ? '' : ' ⚠️ SANS DATE D EXPIRATION') };
}

/**
 * Fabrique le `lireLiaison(addr)` que `makeGitlawbPreflight` attend.
 * @param {object} deps
 * @param {(addr:string)=>Promise<object|null>} deps.magasin  rend l'attestation stockee pour une adresse
 * @param {Function} [deps.verifier]   vérificateur de signatures; absent => aucune liaison ne sera `bound`
 * @param {()=>number} [deps.horloge]
 */
function makeLireLiaison(deps = {}) {
  const { magasin, verifier = null, horloge = Date.now } = deps;
  if (typeof magasin !== 'function') throw new Error('did-binding: `magasin` est requis');
  return async function lireLiaison(addr) {
    const att = await magasin(addr);      // une PANNE du magasin remonte: le relais sait gerer un throw
    /* ⛔ `null` QUAND LE MAGASIN N'A RIEN, et ce n'est pas cosmetique. `admission-gitlawb.js` distingue
     * `NO-BINDING` (aucune attestation) de `UNVERIFIED-CLAIM` (attestation presente, non prouvee) —
     * deux etats qui n'appellent pas la meme reaction: le premier est un agent qui n'a jamais rien
     * depose, le second peut etre une tentative. Rendre l'objet raisonne de `jugerLiaison(null)` dans
     * les deux cas les ECRASE en `UNVERIFIED-CLAIM`, et le signal d'abus disparait.
     * Defaut trouve en composant la chaine entiere, pas en relisant le code. */
    if (att === null || att === undefined) return null;
    return await jugerLiaison(att, { now: horloge(), verifier });
  };
}

module.exports = { messageDeLiaison, jugerLiaison, makeLireLiaison, FORME_DID, FORME_ADRESSE };
