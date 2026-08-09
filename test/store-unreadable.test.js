#!/usr/bin/env node
'use strict';
/**
 * store: une base ILLISIBLE et une base VIDE rendent aujourd'hui la même chose.
 * ================================================================================================
 * ⛔ CECI EST UN TEST DE CARACTÉRISATION, PAS UN CORRECTIF. Il épingle le comportement ACTUEL, il ne
 * le change pas. Ce que doit répondre un nœud dont la base ne se lit pas — servir vide, ou refuser —
 * est une sémantique produit, et elle appartient à l'opérateur. `lawbor-node-production` tourne.
 *
 * CE QUI EST MESURÉ. `lib/store.js` porte cinq lectures qui avalent leur échec:
 *
 *     ligne  28  let raw; try { … } catch { return []; }
 *     ligne  47  let raw; try { … } catch { return []; }
 *     ligne  49  try { out.push(JSON.parse(l)); } catch {}
 *     ligne  89  let raw = ''; try { … } catch {}
 *     ligne 109  catch { return { totalBefore: 0, kept: 0, removed: 0 }; }
 *
 * Conséquence: un nœud NEUF (aucun message, état parfaitement normal) et un nœud dont le journal est
 * CORROMPU ou illisible produisent une réponse identique. Pour une messagerie c'est la pire confusion
 * possible: l'utilisateur conclut que personne ne lui a écrit.
 *
 * ⚠️ ET CE N'EST PAS THÉORIQUE DANS CE PROJET. Un volume plein a déjà corrompu une base ici, et un
 * fichier de zéro octet en est la signature exacte. Le dépôt frère a corrigé exactement ce motif dans
 * `funder-history.js`, qui distingue depuis trois états — absente (normal pour un nœud neuf),
 * illisible (quelque chose a cassé), chargée — précisément parce que les confondre efface l'incident.
 *
 * ⛔ LA LIGNE 109 EST LA PLUS COÛTEUSE DES CINQ: une compaction qui échoue rapporte `{ removed: 0 }`,
 * c'est-à-dire « j'ai regardé, il n'y avait rien à retirer », alors qu'elle n'a rien pu lire. La valeur
 * neutre y devient une AFFIRMATION.
 *
 * Si ce test se met à ÉCHOUER, c'est que quelqu'un a corrigé le défaut: mettre ce fichier à jour pour
 * épingler le nouveau comportement, surtout pas le neutraliser.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/store');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('store: caracterisation — illisible et vide se confondent (comportement ACTUEL)');

let n = 0;
const fichierTemp = (contenu) => {
  const p = path.join(os.tmpdir(), 'lawbor-store-carac-' + (n++) + '-' + process.pid + '.jsonl');
  if (contenu === null) { try { fs.unlinkSync(p); } catch { /* deja absent */ } }
  else fs.writeFileSync(p, contenu);
  return p;
};

/* L'API REELLE, LUE dans `lib/store.js` et non supposee: `createStore(file, controlFile, opts)` est
 * POSITIONNEL, et la lecture complete s'appelle `all()`. Mon premier jet passait un objet et appelait
 * `list()` — les deux faux. La garde du test l'a DIT au lieu de laisser passer un cas creux, ce qui est
 * exactement ce qu'on lui demande. */
const ligne = (id, body) => JSON.stringify({ id, thread: 't-1', from: '0x' + '1'.repeat(40),
  to: '0x' + '2'.repeat(40), body, ts: 1, origin: 'human', dir: 'in', rxAt: 1 });

t('★ LE DEFAUT: base ABSENTE et base ILLISIBLE rendent la meme chose', () => {
  const absente = createStore(fichierTemp(null)).all();
  const corrompue = createStore(fichierTemp('{ceci n est pas du JSON  ')).all();
  assert.deepStrictEqual(absente, corrompue,
    'si ces deux-la different desormais, le defaut est CORRIGE: mettre ce test a jour, pas le neutraliser');
  assert.strictEqual(absente.length, 0, 'les deux rendent une lecture vide');
  /* ⛔ C est le point: rien dans la reponse ne permet a un appelant de distinguer
   * « nouveau noeud, personne n a ecrit » de « journal corrompu, tes messages sont illisibles ». */
});

t('★ le cas OPPOSE — une base LISIBLE et non vide rend bien ses lignes', () => {
  const rows = createStore(fichierTemp(ligne('m-1', 'salut') + '\n')).all();
  assert.ok(Array.isArray(rows), 'la lecture doit rendre un tableau');
  assert.strictEqual(rows.length, 1,
    'temoin: sans ce cas, un store qui rendrait TOUJOURS [] passerait le test precedent sans rien prouver');
});

t('★ une ligne CORROMPUE au milieu de lignes valides disparait SANS COMPTEUR', () => {
  const rows = createStore(fichierTemp(
    ligne('m-1', 'un') + '\n{tronque\n' + ligne('m-2', 'deux') + '\n')).all();
  assert.strictEqual(rows.length, 2, 'la ligne illisible est SAUTEE (store.js:49)');
  /* ⚠️ Un journal a moitie ecrit — la signature exacte d un volume plein — perd donc des messages sans
   * qu aucun compteur ne le signale. Mesure ici, pas suppose. */
});

const ATTENDUS = 3;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
