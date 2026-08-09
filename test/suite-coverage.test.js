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

console.log('\n  inventaire: ' + surDisque.length + ' fichier(s) de test · '
  + [...new Set([...toutesLesCommandes.matchAll(/node (test\/[\w.-]+)/g)].map((m) => m[1]))].length
  + ' declare(s) · ' + Object.keys(EXCLUS).length + ' exclusion(s) declaree(s)');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
