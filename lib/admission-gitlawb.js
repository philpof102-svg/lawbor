'use strict';
/**
 * admission-gitlawb.js — remplacer l'oracle d'admission par la réputation gitlawb, sans nous.
 * ================================================================================================
 * CE QUE CE FICHIER CORRIGE, mesuré sur le nœud en production le 2026-08-09:
 *
 *     admissionOracle: { url: <un service que NOUS opérons>, minScore: 40, operatedByUs: TRUE }
 *     peers: 0 · edges: 0 · originatesSigned: false
 *
 * Un nœud « décentralisé » dont la porte d'entrée est une URL sous notre contrôle est centralisé
 * exactement là où ça compte. Le nœud le DÉCLARE lui-même — c'est de l'instrumentation honnête, et
 * c'est ce champ-là qui doit tomber.
 *
 * ⛔ LA COUTURE EXISTAIT DÉJÀ. `server.js` lit `deps.preflight`: quand un opérateur en injecte un,
 * `operatedByUs` passe à FALSE et aucun oracle HTTP n'est consulté. Il ne manquait pas d'architecture,
 * il manquait une implémentation qui ne soit pas la nôtre. C'est ce fichier.
 *
 * ═══ CE QUI REND LA CHOSE DÉCENTRALISÉE, ET CE QUI NE L'EST PAS ═══
 *
 * Décentralisé: le score ne vient plus d'un service que nous opérons mais de la réputation par DID du
 * réseau gitlawb, et la LIAISON entre le DID et l'adresse Base est une attestation BIDIRECTIONNELLE —
 * chaque clé signe le même message canonique, donc n'importe qui la revérifie sans nous croire.
 *
 * ⚠️ MAIS SI LE NŒUD GITLAWB INTERROGÉ EST UN NŒUD QUE NOUS OPÉRONS, LA CENTRALISATION A DÉMÉNAGÉ,
 * ELLE N'A PAS DISPARU. Ce module rend donc TOUJOURS l'identité de la source qui a répondu, et
 * l'opérateur peut la pointer où il veut. Sans ce champ, « décentralisé » serait invérifiable — le
 * même défaut que celui qu'on corrige, avec un autre chapeau.
 *
 * ═══ POURQUOI L'ABSENCE DE LIAISON REFUSE, ET NE TEMPORISE PAS ═══
 *
 * Une adresse sans attestation prouvée n'a pas de DID: gitlawb n'a rien à dire d'elle. Ce n'est pas une
 * panne, c'est une réponse — « cet agent n'a pas de standing prouvé ici ». Un standing doit être GAGNÉ
 * et PROUVÉ, jamais supposé. Et une attestation présente mais non vérifiée est une PRÉTENTION, pas une
 * liaison; les traiter pareil laisserait entrer quiconque sait écrire du JSON.
 *
 * ⛔ EN REVANCHE, UNE PANNE DE LECTURE DOIT LANCER. Le relais gère un preflight qui JETTE (probation ou
 * fail-closed selon sa config) mais il ne gère pas un retour neutre: rendre `{score: 0}` sur une panne
 * transformerait « je n'ai pas pu lire » en « cet agent vaut zéro », et le nœud croirait avoir jugé.
 * C'est le motif n°1 de ces dépôts, appliqué à une porte d'entrée.
 *
 * Pur et sans dépendance, comme tout `lawbor/lib`: la lecture de la réputation et celle de la liaison
 * sont INJECTÉES, donc tout se teste hors ligne.
 */

/** L'échelle du nœud. `minScore` y vit (40 par défaut); gitlawb rend 0..1. */
const ECHELLE = 100;

/**
 * La décision, pure.
 *
 * @param {object} a
 * @param {{bound:boolean, did:string|null}|null} a.binding  l'attestation résolue, ou null si aucune
 * @param {number|null} a.trust     le `trust_score` gitlawb (0..1), ou null si non lu
 * @param {number} a.minScore       le plancher du nœud, sur l'échelle du nœud
 * @param {string|null} a.source    QUI a répondu — sans ça « décentralisé » est invérifiable
 * @returns {{decision:string, score:number, did:string|null, source:string|null, reason:string}}
 */
function planAdmission({ binding, trust, minScore, source = null } = {}) {
  const plancher = Number.isFinite(minScore) ? minScore : 40;

  if (!binding || typeof binding !== 'object') {
    return { decision: 'NO-BINDING', score: 0, did: null, source,
      reason: 'aucune attestation ne lie cette adresse a un DID gitlawb — le reseau n a rien a dire d elle. '
        + 'Un standing se GAGNE et se PROUVE, il ne se suppose pas.' };
  }
  if (binding.bound !== true) {
    /* Une attestation non verifiee est une PRETENTION. La traiter comme une liaison laisserait entrer
     * quiconque sait ecrire du JSON — la signature est tout ce qui separe les deux. */
    return { decision: 'UNVERIFIED-CLAIM', score: 0, did: binding.did || null, source,
      reason: 'attestation presente mais NON VERIFIEE: une pretention n est pas une liaison, et seules '
        + 'les signatures les distinguent' };
  }
  if (typeof trust !== 'number' || !Number.isFinite(trust) || trust < 0 || trust > 1) {
    /* ⛔ Ce n'est PAS une panne — une panne doit lancer avant d'arriver ici. C'est une valeur qu'on a
     * lue et qui ne veut rien dire: hors de [0,1], elle n'est pas un `trust_score`. Refuser est la
     * seule lecture sure, et le dire evite qu'on croie avoir juge. */
    return { decision: 'TRUST-UNREADABLE', score: 0, did: binding.did || null, source,
      reason: 'la reputation lue n est pas un score dans [0,1] — elle ne se convertit pas, donc rien '
        + 'n est affirme sur cet agent' };
  }

  const score = trust * ECHELLE;
  /* ⚠️ `>=` avec un `score` fini des deux cotes: la garde NaN est faite au-dessus, precisement parce
   * qu'un NaN rendrait TOUTE comparaison fausse et fermerait la porte en ayant l'air de decider. */
  if (score >= plancher) {
    return { decision: 'PROCEED', score, did: binding.did, source,
      reason: 'standing gitlawb ' + trust.toFixed(3) + ' soit ' + score.toFixed(1) + ' sur l echelle du '
        + 'noeud, au-dessus du plancher ' + plancher };
  }
  return { decision: 'BELOW-FLOOR', score, did: binding.did, source,
    reason: 'standing gitlawb ' + trust.toFixed(3) + ' soit ' + score.toFixed(1) + ' — sous le plancher '
      + plancher + ', qui exige un trust_score gitlawb d au moins ' + (plancher / ECHELLE).toFixed(2) };
}

/**
 * Fabrique le `preflight(addr)` que `server.js` injecte.
 *
 * ⛔ IL LANCE SUR PANNE, il ne rend jamais un score neutre. Le relais sait gerer un throw; il ne sait
 * pas distinguer « j'ai lu zero » de « je n'ai pas pu lire », et c'est la difference entre mettre un
 * agent en probation et le condamner.
 *
 * @param {object} deps
 * @param {(addr:string)=>Promise<object|null>} deps.lireLiaison  attestation resolue pour une adresse
 * @param {(did:string)=>Promise<{trust:number, source:string}>} deps.lireStanding  reputation gitlawb
 * @param {number} [deps.minScore]
 */
function makeGitlawbPreflight(deps = {}) {
  const { lireLiaison, lireStanding, minScore = 40 } = deps;
  if (typeof lireLiaison !== 'function' || typeof lireStanding !== 'function') {
    throw new Error('admission-gitlawb: lireLiaison et lireStanding sont requis — sans eux ce preflight '
      + 'admettrait ou refuserait sans rien lire');
  }
  return async function preflightGitlawb(addr) {
    const binding = await lireLiaison(addr);          // une PANNE ici remonte: c'est voulu
    if (!binding || binding.bound !== true) {
      return planAdmission({ binding, trust: null, minScore, source: null });
    }
    const st = await lireStanding(binding.did);       // idem: un throw atteint le relais
    return planAdmission({ binding, trust: st && st.trust, minScore, source: (st && st.source) || null });
  };
}

module.exports = { planAdmission, makeGitlawbPreflight, ECHELLE };
