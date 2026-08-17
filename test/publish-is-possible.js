#!/usr/bin/env node
'use strict';
/**
 * CE QUI EST CORRIGE ICI PEUT-IL SEULEMENT ATTEINDRE QUELQU'UN ?
 * Run: npm run test:publish        (reseau — DELIBEREMENT hors de `npm test`)
 *
 * ⚠️ LA CONDITION LETALE, ET ELLE EST SILENCIEUSE DES DEUX COTES. npm REFUSE de republier une
 * version existante. Donc quand la version locale EGALE la version publiee alors que des fichiers
 * expedies ont change, il ne se passe rien de visible: le registre annonce la meme version que le
 * depot — ce qui se lit « a jour » — et `npm publish` echouera le jour ou quelqu'un l'essaie. Entre
 * les deux, chaque correctif ecrit ici est INATTEIGNABLE pour un installateur.
 *
 * MESURE DU 2026-08-17: `lawbor-bot` publie en 0.2.1 le 2026-07-21, version locale AUSSI 0.2.1,
 * et 39 commits ont touche des chemins de `files` depuis. Parmi eux, ce mois-ci: le flux premium
 * qui accusait l'operateur sur un dossier illisible, le plancher de reputation qui s'affaiblissait
 * en silence sur une faute de frappe, la garde de compaction concurrente, la revalidation du cache.
 * Aucun n'est installable.
 *
 * ⚖️ POURQUOI CE FICHIER EST UNE COPIE ASSUMEE, alors que ce depot combat les copies. `biii` porte
 * un jumeau. La regle qu'on applique ailleurs vise les COMPARATEURS dont les verdicts doivent
 * s'accorder — deux copies y divergent et l'une ment. Ici il n'y a AUCUN verdict partage: chaque
 * exemplaire lit SON package.json et SON git log, et parle d'un paquet different. Le seul vehicule
 * qui traverse une frontiere de depot etant la note de memoire, la copie est le prix, et il est dit.
 *
 * ⛔ LECTURE SEULE. Un `npm view` borne. Aucune publication, aucun jeton, aucune ecriture.
 * Codes de sortie: 0 = publier est possible (ou rien a publier) · 1 = BLOQUE · 2 = sonde muette.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
const EXPEDIES = (PKG.files || []).filter((f) => !f.startsWith('!'));

let pass = 0, fail = 0;
const t = (nom, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + nom); }
  else { fail++; console.log('  ✗ ' + nom + (detail ? '\n      ' + detail : '')); }
};

(async () => {
  console.log('publier est-il possible ? — ' + PKG.name + ' ' + PKG.version + ' contre le registre:\n');

  let meta;
  try {
    meta = JSON.parse(execFileSync('npm', ['view', PKG.name, '--json'], { encoding: 'utf8', shell: true, timeout: 60000 }));
  } catch (e) {
    /* ⚖️ Un registre muet n'est PAS un verdict. Sortie 2, distincte du blocage (1) et du vert (0). */
    console.log('  registre INJOIGNABLE : ' + String((e && e.message) || e).split('\n')[0]);
    console.log('\n  ⚠️ AUCUNE CONCLUSION.');
    process.exitCode = 2; return;
  }

  const publiee = meta.version;
  const quand = (meta.time && meta.time[publiee]) || null;
  console.log('  version locale  : ' + PKG.version);
  console.log('  version publiee : ' + publiee + (quand ? '  (' + quand.slice(0, 10) + ')' : ''));

  if (PKG.version !== publiee) {
    t('la version locale DIFFERE de la publiee — un publish peut partir', true);
    console.log('\n  ⛔ Ce gate ne dit PAS que le contenu est a jour: il dit que rien ne BLOQUE la publication.');
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0; return;
  }

  if (!quand) {
    console.log('  le registre ne date pas cette version — impossible de compter ce qui a change depuis.');
    console.log('\n  ⚠️ AUCUNE CONCLUSION.');
    process.exitCode = 2; return;
  }

  let commits = [];
  try {
    commits = execFileSync('git', ['log', '--oneline', '--since=' + quand, '--', ...EXPEDIES],
      { cwd: RACINE, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch (e) {
    console.log('  git muet : ' + String((e && e.message) || e).split('\n')[0]);
    process.exitCode = 2; return;
  }

  t('version identique au publie ET aucun fichier expedie modifie depuis', commits.length === 0,
    commits.length + ' commit(s) ont touche des chemins de `files` depuis la publication de ' + publiee
      + '.\n      npm REFUSE de republier une version existante, donc RIEN de tout cela ne peut atteindre'
      + '\n      un installateur. Les cinq plus recents:\n      · ' + commits.slice(0, 5).join('\n      · ')
      + '\n\n      Geste: monter la version dans package.json, puis publier.');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
