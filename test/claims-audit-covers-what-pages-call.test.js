#!/usr/bin/env node
'use strict';
/**
 * L'audit de revendications doit couvrir ce que les PAGES appellent vraiment.
 *
 * `claims.cjs` existe parce que la meme faute est arrivee trois fois en un apres-midi — son propre
 * en-tete: « the pattern is always the same — a claim aimed at someone else, shipped without being
 * checked ». Il verifie « the routes the node's own pages and messages point at ».
 *
 * ⛔ MAIS SA LISTE EST ECRITE EN DUR, et elle n'a pas grandi avec le produit. Mesure du 2026-08-15:
 * `claims.cjs` sonde 11 chemins, les apps en appellent 12, et SEPT sont appeles par une page sans
 * jamais etre sondes. Six appartiennent a `apps/messenger.js`, c'est-a-dire a la face du produit.
 * C'est le motif que ce fichier decrit, applique a lui-meme.
 *
 * Deux d'entre eux comptent plus que les autres. La section 4 de `claims.cjs` sonde la SURFACE
 * D'ECRITURE en POSTant comme un inconnu et en exigeant un 401 — « this audit runs from outside, like
 * an attacker ». `/accept` et `/block` sont des routes d'ecriture, et elles n'y sont pas.
 * ⛔ CE TEST N'AFFIRME RIEN SUR LEUR COMPORTEMENT: personne ne les a sondees. Il dit qu'elles ne SONT
 * PAS AUDITEES, ce qui est une propriete de l'audit, pas du serveur.
 *
 * Ce test ne fait AUCUN reseau: il compare deux fichiers. Il transforme une derive invisible en une
 * LISTE EXPLICITE, exactement comme `suite-coverage.test.js` le fait pour les tests non lances — « une
 * liste d'exclusion par motif se remplit toute seule et finit par cacher exactement ce que ce test
 * cherche ; une liste explicite oblige a justifier chaque ligne ».
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const R = path.join(__dirname, '..');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* Chemins que les pages APPELLENT reellement (fetch dans les chaines de page). */
const appeles = new Map();
for (const f of fs.readdirSync(path.join(R, 'apps')).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(R, 'apps', f), 'utf8');
  for (const m of src.matchAll(/fetch\(\s*['"`](\/[a-z0-9][a-z0-9._/-]*)/gi)) {
    const p = '/' + m[1].slice(1).split(/[?#]/)[0].split('/')[0];
    if (!appeles.has(p)) appeles.set(p, new Set());
    appeles.get(p).add(f);
  }
}

/* Chemins que claims.cjs SONDE. */
const claims = fs.readFileSync(path.join(R, 'claims.cjs'), 'utf8');
const sondes = new Set([...claims.matchAll(/['"`](\/[a-z0-9][a-z0-9._/-]*)['"`]/gi)]
  .map((m) => '/' + m[1].slice(1).split('/')[0]));

/* ── TEMOINS: les deux lectures doivent voir quelque chose, sinon l'ecart ne veut rien dire. ────── */
ok(sondes.size >= 8, 'TEMOIN: claims.cjs sonde ' + sondes.size + ' chemins (' + [...sondes].sort().join(' ') + ')');
ok(appeles.size >= 8, 'TEMOIN: les apps appellent ' + appeles.size + ' chemins');
const couverts = [...appeles.keys()].filter((p) => sondes.has(p));
ok(couverts.length >= 3,
  'TEMOIN: ' + couverts.length + ' chemins sont dans les DEUX (' + couverts.sort().join(' ') + ') — sans'
  + ' ce recouvrement, les deux extracteurs pourraient lire des choses sans rapport');

/* ── LA LISTE EXPLICITE. Chaque ligne doit se justifier ; on ne tolere pas un motif. ────────────── */
const NON_AUDITES = new Map([
  ['/inbox', 'lecture messenger — jamais sondee ; ajouter a la section 3 (routes liees)'],
  ['/requests', 'lecture messenger — la quarantaine de premier contact, non sondee'],
  ['/bot-activity', 'lecture messenger — le flux de transparence, non sondee'],
  ['/thread', 'lecture messenger — non sondee'],
  ['/accept', 'ECRITURE — absente de la section 4 (surface d ecriture, 401 attendu)'],
  ['/block', 'ECRITURE — absente de la section 4 (surface d ecriture, 401 attendu)'],
  ['/app', 'prefixe de montage des apps, pas une route en soi'],
]);

const manquants = [...appeles.keys()].filter((p) => !sondes.has(p)).sort();
ok(JSON.stringify(manquants) === JSON.stringify([...NON_AUDITES.keys()].sort()),
  'Les chemins appeles-mais-non-sondes sont EXACTEMENT ceux listes ici.\n       trouve : '
  + manquants.join(' ') + '\n       liste  : ' + [...NON_AUDITES.keys()].sort().join(' ')
  + '\n       ⇒ Un chemin EN PLUS = une page appelle une route que l audit post-deploiement ne verifie'
  + ' pas. Un chemin EN MOINS = il a ete ajoute a claims.cjs: retirer sa ligne d ici.');

/* ── ET LES DEUX ROUTES D ECRITURE DOIVENT RESTER SIGNALEES COMME TELLES. ──────────────────────── */
for (const p of ['/accept', '/block']) {
  ok(/ECRITURE/.test(NON_AUDITES.get(p) || ''),
    p + ' est signale comme une route d ECRITURE non auditee — la section 4 de claims.cjs existe pour'
    + ' verifier qu un inconnu recoit 401, et celle-ci n y passe pas');
}

/* ── DETECTION POWER: un nouveau chemin non sonde ferait-il rougir ? ───────────────────────────── */
const AVEC_NOUVEAU = [...manquants, '/nouvelle-route'].sort();
ok(JSON.stringify(AVEC_NOUVEAU) !== JSON.stringify([...NON_AUDITES.keys()].sort()),
  'DETECTION POWER: un chemin supplementaire appele par une page fait diverger les deux listes');

console.log('  ' + n + ' passed, 0 failed');
console.log('  ⛔ AUCUN reseau: compare deux fichiers. N affirme rien sur le comportement de /accept ni');
console.log('     de /block — seulement qu ils ne sont pas audites.');
