'use strict';
/**
 * gitlawb-standing.js — lire le standing d'un DID sur le réseau gitlawb, sans nous croire sur parole.
 * ================================================================================================
 * `lib/admission-gitlawb.js` décide; ce fichier LIT. La séparation est volontaire: la décision se teste
 * hors ligne, la lecture parle à un processus externe, et mélanger les deux rendrait la première
 * intestable et la seconde impossible à raisonner.
 *
 * ═══ CE QUE LA CLI REND VRAIMENT, SONDÉ AVANT D'ÉCRIRE UNE LIGNE (gl 0.7.0, 2026-08-09) ═══
 *
 *     gl node trust <DID> --node <URL>
 *         Trust score for did:key:zZZZ…
 *           Score:  0.00
 *           Level:  newcomer
 *           Pushes: 0
 *
 * 🚨 ET C'EST LE PIÈGE PRINCIPAL DE CE FICHIER: un DID **totalement inexistant** rend `0.00 / newcomer`,
 * exactement comme un DID réel sans historique. `trust` seul ne distingue donc PAS « inconnu du réseau »
 * de « connu, sans standing ». `resolve`, lui, le dit franchement:
 *
 *     gl node resolve <DID> --node <URL>
 *         DID not found: did:key:zZZZ…  (not this node and not in peer list)
 *
 * Les deux sont donc appelés, et l'état est rendu séparément du score. Pour l'admission le refus est le
 * même dans les deux cas — mais un opérateur qui lit « score 0 » sur une identité FABRIQUÉE doit voir
 * que le réseau ne la connaît pas du tout: c'est la différence entre un agent qui débute et un agent
 * qui n'existe pas.
 *
 * ═══ POURQUOI `--node` EST UN PARAMÈTRE ET NON UNE CONSTANTE ═══
 *
 * `gl` a un défaut (`https://node.gitlawb.com`, via `GITLAWB_NODE`). Le figer ici reviendrait à
 * remplacer notre oracle par le leur — la centralisation aurait déménagé, pas disparu. L'appelant
 * choisit, et le nœud qui a répondu voyage dans la réponse. ⚠️ Sondé ce jour: `gl node status` contre
 * le nœud public n'a **rien** rendu — injoignable, config locale manquante, ou réponse vide, et rien
 * ici ne tranche. Un nœud doit donc être choisi et VÉRIFIÉ par l'opérateur, pas supposé vivant.
 *
 * 💎 Ce qui rend le choix défendable plutôt qu'arbitraire: `gl node register` mise du $GITLAWB
 * **on-chain sur Base** avec un cooldown de sept jours au retrait. Un nœud n'est donc pas juste une URL
 * — c'est un opérateur qui a immobilisé du capital. ⛔ Mais ce module ne VÉRIFIE pas cette mise: le
 * dire serait une affirmation que rien ici ne mesure.
 *
 * ⛔ AUCUNE ÉCRITURE, JAMAIS. Ce fichier n'appelle que `trust` et `resolve`. Ni `register`, ni `init`,
 * ni `identity` — la première crée une identité, la seconde mise des fonds. Le lanceur est injecté et
 * la liste des sous-commandes autorisées est vérifiée avant chaque appel.
 */

/** Les seules sous-commandes que ce module a le droit d'invoquer. Tout le reste écrit ou mise. */
const LECTURES_AUTORISEES = Object.freeze(['trust', 'resolve']);

/**
 * Extrait le score d'une sortie `gl node trust`.
 *
 * ⛔ REND `null` PLUTÔT QUE ZÉRO quand rien n'est lisible. Zéro est un SCORE — la note la plus basse
 * qu'un agent réel puisse avoir. Le rendre sur une sortie illisible transformerait « je n'ai pas su
 * lire » en « cet agent ne vaut rien », et la décision d'admission croirait avoir jugé.
 *
 * @returns {{score:number|null, level:string|null}}
 */
function parseTrust(sortie) {
  const txt = typeof sortie === 'string' ? sortie : '';
  const mScore = txt.match(/Score:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const mLevel = txt.match(/Level:\s*([A-Za-z][A-Za-z-]*)/i);
  if (!mScore) return { score: null, level: mLevel ? mLevel[1].toLowerCase() : null };
  const n = Number(mScore[1]);
  /* Hors de [0,1] ce n'est pas un `trust_score`: on ne le convertit pas, on refuse de le lire. */
  if (!Number.isFinite(n) || n < 0 || n > 1) return { score: null, level: mLevel ? mLevel[1].toLowerCase() : null };
  return { score: n, level: mLevel ? mLevel[1].toLowerCase() : null };
}

/**
 * Le DID est-il CONNU du réseau ? Lu sur `gl node resolve`, pas déduit d'un score nul.
 * @returns {boolean|null} null si la sortie ne permet pas de trancher
 */
function parseResolve(sortie) {
  const txt = typeof sortie === 'string' ? sortie : '';
  if (!txt.trim()) return null;                                   // rien lu: on ne tranche pas
  if (/not found/i.test(txt)) return false;
  return true;
}

/**
 * Fabrique le `lireStanding(did)` que `makeGitlawbPreflight` attend.
 *
 * @param {object} deps
 * @param {(args:string[])=>Promise<string>} deps.lancer  exécute `gl node …` et rend sa sortie texte
 * @param {string} deps.node   l'URL du nœud interrogé — OBLIGATOIRE, aucun défaut ici
 */
function makeLireStanding(deps = {}) {
  const { lancer, node } = deps;
  if (typeof lancer !== 'function') throw new Error('gitlawb-standing: `lancer` est requis');
  if (typeof node !== 'string' || !node.trim()) {
    /* ⛔ Pas de défaut. Hériter silencieusement du nœud par défaut de `gl` remplacerait notre oracle
     * par le leur sans que personne l'ait décidé — c'est exactement le déplacement de centralisation
     * que tout ce travail cherche à éviter. */
    throw new Error('gitlawb-standing: `node` est requis — choisir le noeud interroge est la decision, '
      + 'et un defaut implicite la prendrait a la place de l operateur');
  }

  const appel = async (sous, did) => {
    if (!LECTURES_AUTORISEES.includes(sous)) throw new Error('sous-commande non autorisee: ' + sous);
    return lancer(['node', sous, did, '--node', node]);
  };

  return async function lireStanding(did) {
    /* Les deux lectures. Une PANNE de l'une ou l'autre remonte: le relais sait gerer un throw. */
    const [brutTrust, brutResolve] = await Promise.all([appel('trust', did), appel('resolve', did)]);
    const { score, level } = parseTrust(brutTrust);
    const connu = parseResolve(brutResolve);
    return {
      trust: score,
      level,
      knownToNetwork: connu,
      source: node,
      /* ⚠️ Rendu explicitement: un score de 0 sur un DID que le reseau ne connait pas n'est pas la meme
       * information qu'un 0 sur un DID reel, meme si l'admission refuse les deux. */
      note: connu === false
        ? 'le reseau ne connait PAS ce DID — un score de 0 y est un artefact, pas un jugement'
        : connu === null ? 'impossible de dire si le reseau connait ce DID' : null,
    };
  };
}

module.exports = { parseTrust, parseResolve, makeLireStanding, LECTURES_AUTORISEES };
