'use strict';
/**
 * UN jobId EST CHOISI PAR LE PAIR, ET IL FINISSAIT DANS innerHTML SANS ETRE ECHAPPE.
 * ==================================================================================================
 * `lib/work.js` le dit en toutes lettres ligne 30: « jobId is CHOSEN BY THE REQUESTER ». Il passe par
 * `str(x, 80)` — un trim et une troncature, AUCUNE neutralisation. 80 caracteres suffisent tres
 * largement: un `<img src=x onerror=…>` utile en fait moins de 30.
 *
 * MESURE DU 2026-08-15, en enchainant les VRAIS composants (buildWork -> graphOf -> l expression de
 * rendu extraite du fichier livre), avec un jobId hostile:
 *     apps/standup.js  ecrivait  <span class="chip"><img src=x onerror=alert(1)></span>
 * La charge ressortait INTACTE. `apps/orggraph.js` portait le meme defaut sur la meme donnee
 * (dependsOn / blockedBy sont des listes de jobIds, jointes dans le corps du panneau).
 *
 * ⚖️ POURQUOI CA PESE ICI PLUS QU AILLEURS. Un script injecte dans une page LAWBOR herite de son
 * origine, donc des routes d ECRITURE du noeud (/say, /accept, /block). C est exactement le modele de
 * menace que `desktop/preload.cjs` raisonne deja par ecrit — et dans le pod desktop, la page obtient
 * en plus `window.lawbor`.
 *
 * 🧬 LES DEUX FICHIERS SAVAIENT. `standup.js` PORTAIT un `esc` de portee MODULE qu il n appelait
 * NULLE PART: le rendu vit dans le script de la page, une autre portee. `orggraph.js` utilisait
 * `textContent` pour le TITRE du panneau et construisait son CORPS en HTML. L echappeur correct
 * existait des deux cotes, hors de portee du seul endroit qui en avait besoin.
 *
 * ⛔ BORNES. Ce test ne monte pas de navigateur et n ouvre aucune connexion. Il mesure la chaine
 * DONNEE -> RENDU: ce que le pair peut ecrire, et ce que le fichier livre en fait. Il ne dit rien de
 * l ADMISSION (qui a le droit de deposer un message) — c est la porte du consent gate, mesuree
 * ailleurs, et elle ne rend pas l echappement facultatif.
 *
 * Run: node test/peer-strings-never-reach-innerhtml.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const work = require('../lib/work');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const APPS = path.join(__dirname, '..', 'apps');
const lire = (f) => fs.readFileSync(path.join(APPS, f), 'utf8');
const CHARGE = '<img src=x onerror=alert(1)>';

/** Un extrait VERBATIM du fichier livre: du marqueur jusqu au prochain `;` apres `fin`. */
function extrait(src, marqueur, fin) {
  const i = src.indexOf(marqueur);
  assert.ok(i >= 0, 'marqueur introuvable, le test ne mesure plus rien: ' + marqueur);
  const j = src.indexOf(';', src.indexOf(fin, i));
  assert.ok(j > i, 'fin d expression introuvable apres: ' + fin);
  return src.slice(i, j + 1);
}
/** L echappeur de la PAGE (pas celui de portee module, qui a une autre forme). */
function escDePage(src) {
  const i = src.indexOf('function esc(s){');
  return i < 0 ? null : src.slice(i, src.indexOf('\n', i));
}

console.log('LAWBOR — une chaine choisie par un pair n atteint jamais innerHTML telle quelle:');

/* ── CONTRE-BORNE: sans elle, tout ce qui suit passerait sur une charge que le noeud aurait refusee. */
let ready = null;
t('CONTRE-BORNE — un jobId hostile TRAVERSE bel et bien buildWork puis le graphe', () => {
  const corps = work.buildWork('help_wanted', { jobId: CHARGE, task: 'ship it', budget: '10 USDC' });
  assert.equal(JSON.parse(corps).jobId, CHARGE,
    'str(x,80) ne neutralise rien: si ce n est plus vrai, ce test doit etre relu, pas supprime');
  const g = work.graphOf([{ from: '0x' + 'aa'.repeat(20), to: '0x' + 'bb'.repeat(20), body: corps, at: 1, id: 'm1' }]);
  assert.equal(g.ready.length, 1, 'le job hostile doit atteindre la ready frontier pour que la suite mesure quelque chose');
  assert.equal(g.ready[0], CHARGE, 'et y arriver INTACT');
  ready = g.ready;
});

t('★ standup — la ready frontier est ECHAPPEE avant d entrer dans innerHTML', () => {
  const src = lire('standup.js');
  const esc = escDePage(src);
  assert.ok(esc, 'apps/standup.js n a plus d echappeur DANS SA PAGE. Celui de portee module ne compte '
    + 'pas: le rendu ne le voit pas.');
  const expr = extrait(src, "document.getElementById('frontier').innerHTML", '.join(');
  let ecrit = null;
  const document = { getElementById: () => ({ set innerHTML(v) { ecrit = v; } }) };
  // eslint-disable-next-line no-new-func
  new Function('document', 'd', esc + '\n' + expr)(document, { readyFrontier: ready });
  assert.ok(String(ecrit).indexOf(CHARGE) < 0, 'la charge ressort INTACTE dans le DOM: ' + ecrit);
  assert.ok(String(ecrit).indexOf('&lt;img') >= 0, 'le < doit etre echappe: ' + ecrit);
});

t('★ orggraph — dependsOn / blockedBy sont ECHAPPES dans le corps du panneau', () => {
  const src = lire('orggraph.js');
  const esc = escDePage(src);
  assert.ok(esc, 'apps/orggraph.js n a plus d echappeur dans sa page');
  /* `row` tient sur UNE ligne et son `;` est A L INTERIEUR des accolades: le decoupage au premier
   * point-virgule coupait avant la fermante. On prend la ligne entiere. */
  const iRow = src.indexOf('function row(l,v){');
  assert.ok(iRow >= 0, 'helper `row` introuvable dans apps/orggraph.js');
  const row = src.slice(iRow, src.indexOf('\n', iRow));
  const expr = extrait(src, "document.getElementById('pbody').innerHTML", "row('blocked by'");
  let ecrit = null;
  const document = { getElementById: () => ({ set innerHTML(v) { ecrit = v; }, set textContent(v) {} }) };
  const n = { jobId: 'j1', state: 'open', ready: true, requester: '0x' + 'aa'.repeat(20), bids: 0,
    dependsOn: [CHARGE], blockedBy: [] };
  // eslint-disable-next-line no-new-func
  new Function('document', 'g', 'selected', esc + '\n' + row + '\nvar st="ready";var n=g.nodes[0];\n' + expr)(
    document, { nodes: [n] }, 'j1');
  assert.ok(String(ecrit).indexOf(CHARGE) < 0, 'la charge ressort INTACTE dans le DOM: ' + ecrit);
  assert.ok(String(ecrit).indexOf('&lt;img') >= 0, 'le < doit etre echappe: ' + ecrit);
});

t('⚖️ TEMOIN — un jobId ordinaire reste LISIBLE (l echappeur ne detruit pas les valeurs normales)', () => {
  const src = lire('standup.js');
  const expr = extrait(src, "document.getElementById('frontier').innerHTML", '.join(');
  let ecrit = null;
  const document = { getElementById: () => ({ set innerHTML(v) { ecrit = v; } }) };
  // eslint-disable-next-line no-new-func
  new Function('document', 'd', escDePage(src) + '\n' + expr)(document, { readyFrontier: ['ship-v2'] });
  assert.match(String(ecrit), /ship-v2/, 'une valeur ordinaire doit sortir telle quelle: ' + ecrit);
  assert.ok(String(ecrit).indexOf('&amp;') < 0, 'et sans echappement parasite: ' + ecrit);
});

/* ── RECENSEMENT: aucune page ne doit ecrire dans innerHTML sans jamais echapper. ─────────────────
 * ⚠️ Ce contrôle est TEXTUEL et il ne dit pas que chaque valeur est echappee — seulement qu un
 * fichier qui construit du HTML connait son echappeur. Un fichier qui n echappe RIEN est une
 * certitude; un fichier qui echappe quelque part reste a lire. La liste est explicite pour que le
 * jour ou une page nouvelle arrive, ce soit une DECISION et pas un silence. */
const SANS_ECHAPPEMENT_ASSUME = {};   // vide: apres 2026-08-15, plus aucune page n est dans ce cas

t('★ aucune page ne construit du HTML sans jamais echapper', () => {
  const nus = [];
  for (const f of fs.readdirSync(APPS).filter((x) => x.endsWith('.js'))) {
    const src = lire(f);
    const sinks = (src.match(/innerHTML\s*=/g) || []).length;
    if (!sinks) continue;
    const appels = (src.match(/[^a-zA-Z]esc\(/g) || []).length;
    if (!appels) nus.push(f);
  }
  assert.deepEqual(nus.sort(), Object.keys(SANS_ECHAPPEMENT_ASSUME).sort(),
    'page(s) qui ecrivent du HTML sans appeler d echappeur: ' + (nus.join(' ') || '(aucune')
    + '. Chaque valeur venant d un pair doit passer par esc() — ou la ligne doit etre justifiee ici.');
});

t('★ la porte MORD — une page fictive sans echappement serait detectee', () => {
  const faux = "document.getElementById('x').innerHTML = '<b>'+d.v+'</b>';";
  assert.equal((faux.match(/innerHTML\s*=/g) || []).length, 1, 'le detecteur voit le sink');
  assert.equal((faux.match(/[^a-zA-Z]esc\(/g) || []).length, 0, 'et voit qu aucun echappeur n est appele');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
