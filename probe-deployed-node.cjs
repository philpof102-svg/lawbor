#!/usr/bin/env node
// probe-deployed-node.cjs — le noeud PUBLIC porte-t-il les correctifs, ou seulement le depot ?
// ================================================================================================
// Ce depot n avait aucun instrument pour cette question, et elle n a jamais ete posee avant le
// 2026-08-14. Corriger le depot ne corrige pas ce qui tourne, et l ecart ne se voit pas: un noeud
// perime repond 200 a tout, exactement comme un noeud a jour.
//
// ⛔ CE QU IL NE FAUT PAS EN CONCLURE. Ce probe mesure LE NOEUD HEBERGE, qui est deploye depuis git.
// Il ne dit RIEN du paquet npm: mesure du 2026-08-14, lawbor-bot@0.2.1 date du 21/07 et lui manque
// tout ce qui a suivi. Les deux chemins DIVERGENT, et c est le chemin auto-heberge qui est le moins
// protege — le `.claude-plugin/plugin.json` publie lance `npx -y lawbor-bot`, ce qui va CHERCHER le
// paquet sur npm au lancement, donc un utilisateur parti d un clone frais execute quand meme la
// version publiee. Un noeud vert ici ne protege que ceux qui appellent CE noeud.
//
// ⚠️ CETTE ECHELLE BORNE PAR LE BAS, JAMAIS PAR LE HAUT. Elle ne connait que les marqueurs qu on y
// ajoute; son barreau le plus recent date du 2026-08-09. Un noeud qui les porte tous peut manquer
// tout ce qui est venu apres. La branche "tout present" le DIT au lieu d imprimer « a jour ».
//
// ⛔ QUAND UN CORRECTIF NOTABLE PART, AJOUTER SON BARREAU ICI, en tete. Chaque marqueur doit etre
// pose INCONDITIONNELLEMENT sur son chemin — un champ conditionnel absent ne prouve rien.
//
// 👯 JUMEAU: biii/hermes/economy/probe-deployed-biii.js tient la meme forme sur l autre noeud. Les
// deux depots ne partagent aucune bibliotheque, donc la duplication est structurelle — mais ils
// DIVERGERONT, et un correctif porte sur l un et pas sur l autre est le motif n°1 de ces depots.
//
// ⛔ Lecture seule. Aucun paiement, aucune signature, une seule route GET publique. L en-tete
// `x-ms-monitor: 1` est pose par coherence avec l autre probe: nos propres sondes ne doivent jamais
// devenir la preuve que le produit est utilise.
//
// Run: node probe-deployed-node.cjs        (LAWBOR_URL pour viser un autre noeud)
'use strict';

const URL_BASE = process.env.LAWBOR_URL || 'https://lawbor-node-production.up.railway.app';

/* Chaque barreau: un champ pose INCONDITIONNELLEMENT dans la reponse /health, la date de son commit,
 * et ce que son ABSENCE etablirait. Du plus recent au plus ancien. */
const ECHELLE = [
  { date: '2026-08-09', champ: 'logs',
    quoi: '`logs` — l etat de lecture du journal (store.health)',
    cout: 'son absence date le noeud AVANT le 09/08. Or les trois correctifs de securite du 21/07 '
        + '(loopback signe, plafond OOM, amplification CPU) et la description d outil du 23/07 sont '
        + 'ANTERIEURS a ce barreau: s il est present, ils y sont; absent, il faut redescendre l echelle.' },
  { date: '2026-07-19', champ: 'admissionOracle',
    quoi: '`admissionOracle` — QUI est consulte pour admettre un expediteur',
    cout: 'son absence date le noeud avant le 19/07, donc avant que le noeud ne declare la seule '
        + 'dependance externe capable de l arreter. Un operateur ne pouvait pas savoir qui il faisait confiance.' },
  { date: '2026-07-18', champ: 'authenticatesSenders',
    quoi: '`authenticatesSenders` — le relais verifie-t-il ses expediteurs',
    cout: 'son absence place le noeud avant le 18/07 — anterieur a tout ce que cette echelle connait.' },
];

async function main() {
  console.log('\n  noeud sonde : ' + URL_BASE);

  let sante = null, panne = null;
  try {
    const r = await fetch(URL_BASE + '/health', {
      headers: { 'x-ms-monitor': '1', accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sante = await r.json();
  } catch (e) { panne = String((e && e.message) || e); }

  /* ⚠️ TROIS ETATS, et le troisieme compte le plus. Une sonde qui ne repond pas ne dit RIEN sur la
   * version deployee; la compter « en retard » serait accuser sur notre propre incapacite a lire. */
  if (panne) {
    console.log('\n  ⚠️ NON LU : ' + panne);
    console.log('  Ce n est PAS « le noeud est en retard » — c est « on n a pas pu savoir ».');
    process.exitCode = 2;
    return;
  }
  if (!sante || typeof sante !== 'object') {
    console.log('\n  ⚠️ Forme inattendue — les marqueurs ne peuvent pas etre lus. Ne rien conclure.');
    process.exitCode = 2;
    return;
  }

  console.log('  /health     : ' + Object.keys(sante).length + ' cles servies\n');
  const absents = [], presents = [];
  for (const b of ECHELLE) {
    const present = Object.prototype.hasOwnProperty.call(sante, b.champ);
    console.log('  ' + b.date + '  ' + (present ? 'PRESENT' : 'ABSENT ') + '  ' + b.quoi);
    (present ? presents : absents).push(b);
  }

  /* C est le plus ANCIEN barreau manquant qui borne, pas le plus recent: annoncer la borne large
   * imprimerait aussi la consequence la moins grave, ce qui enterre la plus grave sous elle. */
  if (absents.length) {
    const borne = absents[absents.length - 1];
    const plancher = presents[0] || null;
    console.log('\n  ⛔ Le noeud en ligne est ANTERIEUR au ' + borne.date
      + (plancher ? ', et POSTERIEUR au ' + plancher.date + '.' : '.'));
    console.log('     ' + borne.cout);
    process.exitCode = 1;
    return;
  }

  console.log('\n  ✅ Le noeud porte tous les marqueurs de cette echelle (le plus recent: '
    + ECHELLE[0].date + ').');
  console.log('     ⛔ Ce qui ne dit PAS « a jour ». L echelle borne par le BAS: le noeud peut manquer');
  console.log('     tout ce qui est venu apres cette date, et rien ici ne le verrait.');
  console.log('     ⛔ Et cela ne dit rien du PAQUET npm — voir l en-tete: le chemin plugin execute');
  console.log('     la version publiee, pas ce noeud.');
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
