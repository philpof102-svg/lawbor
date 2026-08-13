'use strict';
/**
 * unreleased-work-is-declared — ce qui est CORRIGE mais pas PUBLIE doit etre ECRIT.
 * =================================================================================
 * Mesure du 2026-08-13. lawbor-bot@0.2.1 a ete publie le 2026-07-21T15:54Z depuis 5647185, et c est
 * toujours ce qu une installation recoit. 24 commits de code ont suivi, sous le MEME numero de version —
 * le cas dangereux, pas le rassurant, parce que tout outil repond alors "a jour". Ce que la version
 * publiee ne contient donc PAS:
 *
 *   f521692  un loopback portant un en-tete de forwarding etait traite comme LOCAL, donc non signe
 *   305637b  la lecture d une reponse de pair n etait pas plafonnee (fermeture OOM)
 *   c76c7ec  amplification CPU en O(N) replis par lecture, non bornee
 *   b5b3a20  le plugin lance le serveur MCP via `npx` — il ne demarre pas sur Windows
 *   db02e51  une description d outil de forme prompt-injection, signalee par Hermes
 *
 * PROPRIETE, bidirectionnelle et sans seuil: une section `## Unreleased` existe SI ET SEULEMENT SI du code
 * EMBARQUE a change depuis le commit qui a pose la version courante. Le sens direct empeche un ecart de
 * tenir en silence; la reciproque empeche qu un `## Unreleased` permanent rende le test vide.
 *
 * ⚠️ JUMEAU. biii/test/unreleased-work-is-declared.test.js tient la meme propriete sur l autre paquet. Les
 * deux depots ne partagent aucune bibliotheque, donc la duplication est structurelle et non un choix — mais
 * ils DIVERGERONT: un correctif porte sur l un et pas sur l autre est le motif le plus frequent de ce depot.
 * Ce fichier n est pas une copie: `files` contient ici du code A LA RACINE (mcp.js, server.js, claims.cjs),
 * que la version biii — qui ne lit que les repertoires — aurait silencieusement ignore.
 *
 * ⛔ CE QUE CE TEST NE PROUVE PAS. Il lit GIT, jamais le registre npm: il etablit "l arbre a bouge depuis
 * que ce numero a ete pose", jamais "npm sert X". Il ne juge pas la GRAVITE — un commit de typo et un
 * contournement de signature comptent pareil. Il exige qu on l ECRIVE, pas qu on publie.
 *
 * Run: node test/unreleased-work-is-declared.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const RACINE = path.join(__dirname, '..');
const PKG = require(path.join(RACINE, 'package.json'));
const CHEMIN_CHANGELOG = path.join(RACINE, 'CHANGELOG.md');

const git = (...a) => execFileSync('git', ['-C', RACINE, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

console.log('LAWBOR — le travail corrige mais non publie est declare:');

// Lu depuis `files` plutot qu ecrit en dur, pour qu un nouvel embarque entre tout seul dans la mesure. Deux
// formes coexistent ici et il faut les DEUX: les repertoires, et le code pose a la racine — mcp.js et
// server.js sont les points d entree du paquet, les rater viderait la mesure de l essentiel.
const CODE_LIVRE = (PKG.files || [])
  .filter((f) => !f.startsWith('data'))
  .filter((f) => f.endsWith('/') || /\.(js|cjs|mjs)$/.test(f))
  .map((f) => f.replace(/\/$/, ''));

let depot = true;
try { git('rev-parse', '--git-dir'); } catch { depot = false; }

if (!depot) {
  // Un checkout sans historique ne peut pas mesurer l ecart. On le DIT, et ca ne compte pas comme un succes:
  // un test vert qui n a rien regarde est exactement le fail-open que ce depot chasse ailleurs.
  console.log('  ! IGNORE — pas un checkout git, l ecart avec la version publiee est INMESURABLE ici.');
  console.log('\n' + pass + ' passed, ' + fail + ' failed, 1 skipped');
  process.exit(1);
}

t('CONTRE-BORNE — la mesure voit un vrai corpus embarque, repertoires ET racine', () => {
  assert.ok(CODE_LIVRE.some((f) => /\.(js|cjs|mjs)$/.test(f)),
    'aucun fichier de code a la racine retenu — mcp.js et server.js sont des points d entree du paquet; '
    + 'les manquer laisserait le coeur du produit hors de la mesure.');
  const suivis = git('ls-files', '--', ...CODE_LIVRE).split('\n').filter(Boolean).length;
  assert.ok(suivis >= 40,
    'seulement ' + suivis + ' fichiers embarques suivis par git; sous 40 ce test passerait vert sur un '
    + 'arbre vide — il affirmerait au lieu de mesurer.');
});

t('le commit qui a pose la version courante est resolvable — sans lui, rien n est mesurable', () => {
  const c = git('log', '--format=%H', '-S', '"version": "' + PKG.version + '"', '--', 'package.json')
    .split('\n').filter(Boolean);
  assert.ok(c.length > 0,
    'aucun commit ne pose "version": "' + PKG.version + '" dans package.json. Impossible de dater ce que '
    + 'le numero publie recouvre — le test echoue plutot que de supposer.');
});

t('`## Unreleased` existe SI ET SEULEMENT SI du code embarque a bouge depuis ce numero', () => {
  const commits = git('log', '--format=%H', '-S', '"version": "' + PKG.version + '"', '--', 'package.json')
    .split('\n').filter(Boolean);
  const release = commits[commits.length - 1];          // le plus ancien = celui qui a INTRODUIT le numero
  const bouge = git('diff', '--name-only', release + '..HEAD', '--', ...CODE_LIVRE)
    .split('\n').filter(Boolean);
  const texte = fs.existsSync(CHEMIN_CHANGELOG) ? fs.readFileSync(CHEMIN_CHANGELOG, 'utf8') : '';
  const declare = /^##\s+Unreleased/mi.test(texte);

  if (bouge.length && !declare) {
    assert.fail(bouge.length + ' fichier(s) embarque(s) ont change depuis ' + release.slice(0, 7) + ' (qui a '
      + 'pose ' + PKG.version + '), et CHANGELOG.md n a pas de section `## Unreleased`'
      + (fs.existsSync(CHEMIN_CHANGELOG) ? '' : ' (le fichier n existe meme pas)') + '. Ce que npm sert sous '
      + 'ce numero n est donc PLUS ce que ce depot contient, et rien ne le dit — ici cela inclut un '
      + 'contournement de signature et deux trous DoS. ⛔ Ne PAS corriger en bumpant la version: un numero '
      + 'pose en avance nomme une version qui n existe pas au registre. Le correctif est d ECRIRE la '
      + 'section. Exemples: ' + bouge.slice(0, 3).join(', '));
  }
  if (!bouge.length && declare) {
    assert.fail('CHANGELOG.md porte `## Unreleased` alors qu AUCUN fichier embarque n a bouge depuis '
      + release.slice(0, 7) + '. Une section qui reste en place apres la publication satisfait ce test pour '
      + 'toujours et le vide de son sens — le retirer fait partie du release.');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
