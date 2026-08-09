'use strict';
/**
 * admission-wiring.js — rendre l'oracle d'admission REMPLAÇABLE par un opérateur, sans écrire de code.
 * ================================================================================================
 * ⛔ LE DÉFAUT QUE CE FICHIER CORRIGE EST DANS MON PROPRE TRAVAIL. `build(deps)` accepte un
 * `deps.preflight` depuis toujours — c'est la couture qui fait basculer `operatedByUs` à `false`. Mais
 * mesuré le 2026-08-09: `server.js` lancé directement appelle `build({ apps: [...] })` **sans jamais
 * passer de preflight**, et `lawbor-node` EST `server.js`. Donc `admission-gitlawb.js`,
 * `gitlawb-standing.js` et `did-binding.js` étaient INATTEIGNABLES pour quiconque lance le binaire
 * livré. Une couture que personne ne peut atteindre n'est pas une couture, c'est une intention.
 *
 * ═══ POURQUOI ÇA NE S'ACTIVE PAS TOUT SEUL ═══
 *
 * Sans magasin d'attestations, le preflight gitlawb rend `NO-BINDING` pour TOUT LE MONDE: aucune
 * adresse n'a de DID prouvé, donc plus personne n'entre. C'est exactement « la porte se ferme sur tout
 * le monde », l'une des deux façons dont une admission casse — et elle est testée comme telle.
 *
 * ⛔ D'OÙ LA RÈGLE ICI: inerte tant que `LAWBOR_ORACLE` n'est pas posé, et REFUS DE DÉMARRER —
 * bruyant, avec la liste de ce qui manque — si l'opérateur le pose sans fournir de quoi le faire
 * fonctionner. Un nœud qui démarre en n'admettant plus personne est bien pire qu'un nœud qui refuse de
 * démarrer: le premier a l'air vivant.
 *
 * ⚠️ CE QUE CE FICHIER NE TRANCHE PAS. Qui dépose les attestations, comment elles circulent, et qui
 * vérifie les signatures restent des décisions d'opérateur. Il lit un fichier de liaisons et exige
 * qu'un vérificateur soit fourni — il n'en invente aucun, et sans vérificateur `did-binding` refuse
 * déjà de lier quoi que ce soit.
 */
const path = require('node:path');

/**
 * Décide, sans rien construire. Pur, donc testable sans disque ni réseau.
 *
 * @param {object} env  l'environnement, injecté
 * @returns {{mode:'defaut'|'gitlawb', ok:boolean, manque:string[], node:string|null,
 *            bindings:string|null, raison:string}}
 */
/** Les oracles que ce fichier sait cabler. Sert aussi a detecter une confusion de variable. */
const ORACLES = Object.freeze(['gitlawb']);

function planAdmissionWiring(env = {}) {
  /* ⛔ LA CONFUSION `LAWBOR_ADMIT` / `LAWBOR_ORACLE`, ET POURQUOI ELLE EST SILENCIEUSE.
   *
   * `LAWBOR_ADMIT` existe deja et gouverne ce qui se passe quand l'oracle est EN PANNE:
   * `server.js:261` teste `=== 'probation'`, donc TOUTE autre valeur coupe la probation. Le nœud de
   * production l'a posee a `probation`.
   *
   * Quelqu'un qui tape `LAWBOR_ADMIT=gitlawb` en croyant CHOISIR un oracle obtient donc deux choses,
   * toutes deux fausses et toutes deux muettes: son oracle n'est pas change (c'est `LAWBOR_ORACLE` qui
   * le fait), et il vient de DESACTIVER la probation. Renommer ma variable ne protege pas de ca — seule
   * une detection le fait. */
  const admit = typeof env.LAWBOR_ADMIT === 'string' ? env.LAWBOR_ADMIT.trim().toLowerCase() : '';
  if (admit && ORACLES.includes(admit)) {
    return { mode: 'defaut', ok: false, manque: ['LAWBOR_ADMIT'], node: null, bindings: null, verifier: null,
      raison: 'LAWBOR_ADMIT="' + admit + '" — cette variable ne CHOISIT PAS d oracle, elle decide de la '
        + 'conduite en cas de PANNE (seul "probation" l active). Telle quelle elle vient de DESACTIVER '
        + 'la probation sans changer d oracle. Vous vouliez probablement LAWBOR_ORACLE="' + admit + '"' };
  }

  const choix = typeof env.LAWBOR_ORACLE === 'string' ? env.LAWBOR_ORACLE.trim().toLowerCase() : '';
  if (!choix) {
    return { mode: 'defaut', ok: true, manque: [], node: null, bindings: null,
      verifier: null,
      raison: 'LAWBOR_ORACLE non pose — l oracle par defaut reste en place, et `operatedByUs` restera true' };
  }
  if (choix !== 'gitlawb') {
    return { mode: 'defaut', ok: false, manque: ['LAWBOR_ORACLE'], node: null, bindings: null,
      verifier: null,
      raison: 'LAWBOR_ORACLE="' + choix + '" inconnu — seul "gitlawb" est cable a ce jour' };
  }

  const manque = [];
  const lire = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  const node = lire('GITLAWB_NODE');
  const bindings = lire('LAWBOR_BINDINGS');
  const verifier = lire('LAWBOR_BINDING_VERIFIER');
  /* ⛔ AUCUN DEFAUT SUR LE NOEUD. Retomber sur celui de `gl` remplacerait notre oracle par le leur sans
   * que personne l'ait decide — le deplacement de centralisation que tout ce travail evite. */
  if (!node) manque.push('GITLAWB_NODE (l URL du noeud gitlawb interroge — aucun defaut, c est une decision)');
  if (!bindings) manque.push('LAWBOR_BINDINGS (le fichier des attestations DID<->adresse; sans lui PERSONNE n entre)');
  /* ⛔ ET LE VERIFICATEUR EST LA TROISIEME EXIGENCE, trouvee en cablant: sans lui `did-binding` rend
   * `bound: false` pour TOUTE attestation, donc `UNVERIFIED-CLAIM` pour tout le monde — la meme porte
   * fermee, atteinte par un autre chemin. `lawbor` a zero dependance par choix et ne peut pas verifier
   * une signature lui-meme; `lib/relay.js` a deja tranche ce compromis en INJECTANT. */
  if (!verifier) {
    manque.push('LAWBOR_BINDING_VERIFIER (module exportant une fonction de verification de signatures; '
      + 'sans lui chaque attestation reste une PRETENTION et personne n entre non plus)');
  }

  if (manque.length) {
    return { mode: 'gitlawb', ok: false, manque, node, bindings, verifier,
      raison: 'admission gitlawb demandee mais incomplete — un noeud qui demarre en n admettant PLUS '
        + 'PERSONNE a l air vivant, ce qui est pire qu un refus de demarrer' };
  }
  return { mode: 'gitlawb', ok: true, manque: [], node, bindings, verifier,
    raison: 'admission gitlawb: standing lu sur ' + node + ', liaisons lues dans '
      + path.basename(bindings) + ', signatures verifiees par ' + path.basename(verifier) };
}

/** Le message d'arret, pour que l'operateur sache exactement quoi poser. */
function messageDeRefus(plan) {
  return ['LAWBOR: ' + plan.raison, ...plan.manque.map((m) => '  manque: ' + m),
    '  (retirer LAWBOR_ORACLE revient a l oracle par defaut)'].join('\n');
}

module.exports = { planAdmissionWiring, messageDeRefus };
