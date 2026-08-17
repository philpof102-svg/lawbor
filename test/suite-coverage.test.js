#!/usr/bin/env node
'use strict';
/**
 * Un test qui n'est lance par personne protege zero.
 *
 * Le 2026-08-09, `npm test` enchainait 25 fichiers alors que `test/` en contenait 28. Les trois absents
 * — `rings.test.js`, `delivery-commitment.test.cjs`, `delivery-fold.test.cjs` — portaient 28 cas, TOUS
 * VERTS, et aucun ne tournait. Deux d'entre eux venaient des DEUX DERNIERS COMMITS: le travail le plus
 * recent du depot n'etait couvert par rien, et la suite restait verte en le disant.
 *
 * ⛔ CE N'EST PAS UN OUBLI ISOLE, C'EST UNE CLASSE. Ajouter un fichier de test et oublier la ligne du
 * `package.json` ne produit aucun signal: pas d'erreur, pas de rouge, juste un compte qui n'augmente
 * pas — et personne ne connait le compte par coeur. Cette porte rend l'oubli visible a la seconde
 * suivante.
 *
 * ⚠️ CE QU'ELLE NE FAIT PAS: juger le contenu d'un test. Un fichier declare mais vide passerait ici.
 * Elle repond a une seule question — « ce fichier est-il LANCE ? » — et c'est deja celle qui manquait.
 *
 * Portee depuis `biii/test/suite-coverage.test.js`, ou la meme porte existe depuis le 2026-08-06 et a
 * deja attrape un orphelin (`scorecard-maturity-window.test.js`, 13 cas qui ne tournaient pas).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const t = (nom, fn) => { try { fn(); pass++; console.log('  ok   ' + nom); }
  catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); } };

const RACINE = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
/* Tous les scripts npm comptent, pas seulement `test`: un fichier lance par `test:integration` est
 * lance. Ne regarder que `test` produirait de faux orphelins et userait la confiance dans la porte. */
const toutesLesCommandes = Object.values(scripts).join(' && ');

/** Les fichiers de test presents sur le disque. */
const surDisque = fs.readdirSync(path.join(RACINE, 'test'))
  .filter((f) => /\.(test\.)?(js|cjs|mjs)$/.test(f))
  .filter((f) => !f.startsWith('_'))          // convention: `_helper.js` n'est pas un test
  .sort();

/**
 * ⛔ EXCLUSIONS DECLAREES. Un fichier ici doit porter une RAISON, et la raison est le point: elle
 * oblige a dire pourquoi un test existe sans jamais tourner. Une liste qui grossit sans raison finit
 * par tout autoriser — le cas `aucune exclusion FANTOME` ci-dessous l'empeche.
 */
const EXCLUS = {
  'suite-coverage.test.js': 'c est cette porte elle-meme',
};

console.log('couverture de la suite : tout fichier de test est-il reellement lance ?');

t('★ l INVENTAIRE n est pas vide — sinon cette porte passerait en ne verifiant rien', () => {
  /* Un succes-vide est le motif que ce genre de porte doit le moins reproduire: si `test/` change de
   * forme ou que la lecture echoue, tout « passe » et la couverture semble parfaite. */
  assert.ok(surDisque.length >= 10, 'seulement ' + surDisque.length + ' fichier(s) vu(s) dans test/ — '
    + 'la lecture du dossier ne rend plus ce qu on croit');
  assert.ok(toutesLesCommandes.includes('node test/'), 'aucun script npm ne lance de fichier test/ — '
    + 'la forme du package.json a change et cette porte ne mesure plus rien');
});

t('★ aucun fichier de test n est ORPHELIN', () => {
  const orphelins = surDisque.filter((f) => !toutesLesCommandes.includes('test/' + f) && !(f in EXCLUS));
  assert.deepStrictEqual(orphelins, [], 'fichier(s) present(s) dans test/ et lance(s) par AUCUN script '
    + 'npm:\n       ' + orphelins.join(', ')
    + '\n       Les ajouter au script `test` — ou les declarer dans EXCLUS avec la RAISON. '
    + 'Un test qu on ne lance pas ne protege rien, et il reste vert en le disant.');
});

t('★ le script ne reference pas un fichier DISPARU', () => {
  /* Cas oppose du precedent: une ligne qui pointe sur un fichier supprime fait echouer `npm test` avec
   * une erreur de module, ce qui se lit mal. Autant le dire ici. */
  const references = [...toutesLesCommandes.matchAll(/node (test\/[\w.-]+)/g)].map((m) => m[1]);
  const manquants = [...new Set(references)].filter((r) => !fs.existsSync(path.join(RACINE, r)));
  assert.deepStrictEqual(manquants, [], 'script(s) npm pointant sur un fichier absent: ' + manquants.join(', '));
});

t('★ la porte MORD — un orphelin simule est detecte', () => {
  const simule = [...surDisque, 'un-test-que-personne-ne-lance.test.js'];
  const orph = simule.filter((f) => !toutesLesCommandes.includes('test/' + f) && !(f in EXCLUS));
  assert.deepStrictEqual(orph, ['un-test-que-personne-ne-lance.test.js'],
    'la porte doit reperer un fichier de test que rien ne lance');
});

/* ⛔ « REFERENCE PAR UN SCRIPT » N'EST PAS « LANCE PAR LA SUITE », ET L'EN-TETE DE CE FICHIER PROMET
 * LA SECONDE. `toutesLesCommandes` agrege TOUS les scripts npm — ce qui est juste pour ne pas
 * fabriquer de faux orphelins — mais un fichier cable sur un script que personne n'invoque jamais
 * (`test:publish`, `sim:*`) est compte « couvert » alors qu'il ne tourne a AUCUN commit ordinaire.
 *
 * Mesure du 2026-08-17: en ajoutant `test/publish-is-possible.js` cable sur `test:publish`, cette
 * porte est restee verte — correctement selon sa definition, et pourtant le fichier ne tourne dans
 * aucune suite. `biii` repond a la question plus stricte (il ne lit que `scripts.test`) au prix
 * d'une liste d'exclusions justifiees. Aucune des deux conceptions n'est fausse; ce qui manquait
 * ici, c'est de DIRE laquelle des deux couvertures on regarde.
 *
 * Ce cas separe donc les deux populations et exige que la seconde soit DECLAREE — un fichier qui ne
 * tourne qu'a la demande est une decision, pas un effet de bord de nommage. */
const CHAINE_TEST = scripts.test || '';
const SUR_DEMANDE = {
  'publish-is-possible.js':
    'reseau (registre npm) — hors de `npm test` par dessein: une dependance reseau rend la suite '
    + 'rouge pour des motifs qui ne sont pas le code. A lancer via `npm run test:publish` AVANT de '
    + 'croire qu un correctif est distribue.',
};

t('★ chaque fichier lance SUR DEMANDE seulement est DECLARE comme tel', () => {
  const surDemande = surDisque.filter((f) => !(f in EXCLUS)
    && !CHAINE_TEST.includes('test/' + f) && toutesLesCommandes.includes('test/' + f));
  const nonDeclares = surDemande.filter((f) => !(f in SUR_DEMANDE));
  assert.deepStrictEqual(nonDeclares, [],
    'fichier(s) cable(s) sur un script npm mais ABSENT(s) de `npm test` — ils ne tournent a aucun '
    + 'commit ordinaire:\n       ' + nonDeclares.join(', ')
    + '\n       Les mettre dans la chaine `test`, ou les declarer dans SUR_DEMANDE avec la raison.');
  const fantomes = Object.keys(SUR_DEMANDE).filter((f) => !surDemande.includes(f));
  assert.deepStrictEqual(fantomes, [],
    'entree(s) SUR_DEMANDE qui ne correspondent plus a un fichier hors-suite: ' + fantomes.join(', '));
});

t('LES DEUX COUVERTURES sont distinctes — et le chiffre le dit', () => {
  /* Sans ce cas, une future refonte pourrait aligner les deux populations et personne ne verrait que
   * la porte a cesse de distinguer. On exige donc que la couverture SUITE soit un sous-ensemble
   * STRICT ou EGAL de la couverture TOUS SCRIPTS, et que le calcul porte sur des ensembles reels. */
  const parSuite = surDisque.filter((f) => CHAINE_TEST.includes('test/' + f));
  const parTous = surDisque.filter((f) => toutesLesCommandes.includes('test/' + f));
  assert.ok(parSuite.length > 0 && parTous.length > 0, 'succes vide: une des deux couvertures est nulle');
  assert.ok(parSuite.length <= parTous.length, 'la suite ne peut pas couvrir plus que tous les scripts');
  for (const f of parSuite) assert.ok(parTous.includes(f), 'incoherence sur ' + f);
});

t('aucune exclusion FANTOME — une entree morte masquerait un vrai orphelin', () => {
  const fantomes = Object.keys(EXCLUS).filter((f) => !surDisque.includes(f));
  assert.deepStrictEqual(fantomes, [], 'entree(s) de EXCLUS qui ne correspondent a aucun fichier: '
    + fantomes.join(', ') + ' — les retirer, sinon la liste autorise du vide');
});

t('★ tout binaire expedie dans `files` est declare dans `bin`', () => {
  /* Meme classe de silence, un cran a cote: `bin/lawbor-signed-node.js` etait EXPEDIE (files: ["bin/"])
   * sans figurer dans la table `bin`. Apres `npm i -g`, le seul chemin « noeud qui signe » n etait donc
   * sur le PATH de personne, et rien ne le disait. */
  const declares = new Set(Object.values(pkg.bin || {}).map((v) => v.replace(/^\.\//, '')));
  const expedies = (pkg.files || []).some((f) => f.replace(/\/$/, '') === 'bin')
    ? fs.readdirSync(path.join(RACINE, 'bin')).filter((f) => f.endsWith('.js')).map((f) => 'bin/' + f)
    : [];
  const nonDeclares = expedies.filter((f) => !declares.has(f));
  assert.deepStrictEqual(nonDeclares, [], 'binaire(s) expedie(s) mais absent(s) de la table `bin`: '
    + nonDeclares.join(', ') + ' — ils partent chez tous les installateurs sans etre sur leur PATH.');
});

/* L'inventaire imprime les DEUX couvertures: un seul chiffre laisserait croire que « couvert » veut
 * dire « tourne a chaque commit », ce qui est faux pour les gates hors-suite. */
console.log('\n  inventaire: ' + surDisque.length + ' fichier(s) de test · '
  + surDisque.filter((f) => (scripts.test || '').includes('test/' + f)).length + ' lance(s) par `npm test` · '
  + Object.keys(SUR_DEMANDE).length + ' sur demande (declare(s)) · '
  + Object.keys(EXCLUS).length + ' exclusion(s) declaree(s)');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
