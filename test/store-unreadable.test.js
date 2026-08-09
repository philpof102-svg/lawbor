#!/usr/bin/env node
'use strict';
/**
 * store: une base ILLISIBLE et une base VIDE ne se confondent plus — mais rendent toujours la même chose.
 * ================================================================================================
 * ⛔ CE FICHIER A CHANGÉ DE RÔLE. Il épinglait le DÉFAUT (comportement actuel, correctif à venir); il
 * épingle maintenant le CORRECTIF. La sémantique produit a été tranchée par l'opérateur:
 *
 *     « servir vide AVEC un état explicite que l'appelant peut voir », exposé sur /health.
 *
 * Les deux autres options ont été écartées avec leurs raisons: refuser la lecture transformait /inbox,
 * /requests, /jobs et /graph en 500 sur un nœud vivant — et n'aurait RIEN changé au cas le plus coûteux,
 * la ligne 109, puisque `server.js` appelait déjà `compact()` dans un `try {} catch {}` vide.
 *
 * ⚠️ CONSÉQUENCE DIRECTE, ET C'EST VOULU: LES TROIS PREMIERS CAS DE CE FICHIER SONT RESTÉS VERTS À
 * TRAVERS LE CORRECTIF. Aucune valeur de retour n'a bougé. Ils ne mesurent donc plus un défaut, ils
 * mesurent l'INVARIANT qui protège les ~30 sites d'appel qui font `.filter()` sur `all()` sans rien
 * demander (server.js, mcp.js, lib/autopilot.js, apps/standup.js). Les casser aurait été le vrai
 * incident. Ce qui a été AJOUTÉ, et que les cas suivants épinglent, c'est `store.health()`.
 *
 * CE QUI EST MESURÉ MAINTENANT — les cinq lectures qui avalaient leur échec:
 *
 *     ligne  28  readAll        → readLog(): rend l'état, plus seulement les lignes
 *     ligne  47  readControlRows→ readLog(): le journal de CONTRÔLE a son verdict (il porte les blocages)
 *     ligne  49  JSON.parse     → les lignes illisibles sont désormais COMPTÉES, plus sautées en silence
 *     ligne  89  primeCache     → mémorise le verdict; ne met PAS en cache un échec (il peut être réparé)
 *     ligne 109  compact        → NULLS + état au lieu du zéro neutre qui affirmait « rien à retirer »
 *
 * ⛔ LA LIGNE 109 ÉTAIT LA PLUS COÛTEUSE: `{ removed: 0 }` se lit « j'ai regardé, il n'y avait rien à
 * retirer » — une affirmation sur le journal — alors que la vérité était « je n'ai rien pu lire ». Une
 * valeur neutre n'est pas un énoncé neutre.
 *
 * ⚠️ ET LE ZÉRO OCTET N'EST PAS UNE PREUVE ICI, contrairement au dépôt frère: `compact()` écrit
 * légitimement un fichier vide quand il ne garde aucune ligne (store.js). L'état 'empty' rapporte donc
 * la structure et n'affirme rien; c'est 'damaged' qui porte la preuve d'une perte.
 *
 * Si un cas se met à ÉCHOUER, mettre ce fichier à jour pour épingler le nouveau comportement — surtout
 * pas le neutraliser.
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

console.log('store: illisible / vide / absente / abimee — quatre reponses, une seule forme de retour');

let n = 0;
const fichierTemp = (contenu) => {
  const p = path.join(os.tmpdir(), 'lawbor-store-carac-' + (n++) + '-' + process.pid + '.jsonl');
  if (contenu === null) { try { fs.unlinkSync(p); } catch { /* deja absent */ } }
  else fs.writeFileSync(p, contenu);
  return p;
};
/* ILLISIBLE ≠ ABSENT ≠ ABIME. Pour fabriquer un vrai echec de lecture sans dependre des permissions
 * (ingerables de facon portable entre Windows et Linux), on pointe le store sur un REPERTOIRE. Sonde
 * du 2026-08-09, faite avant d'ecrire ce test et non supposee: `readFileSync` rend EISDIR sur les deux.
 * Le cas n'assert que l'ETAT, jamais le code errno, qui reste une particularite de plateforme. */
const repertoireTemp = () => {
  const p = path.join(os.tmpdir(), 'lawbor-store-dir-' + (n++) + '-' + process.pid);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/* L'API REELLE, LUE dans `lib/store.js` et non supposee: `createStore(file, controlFile, opts)` est
 * POSITIONNEL, et la lecture complete s'appelle `all()`. Mon premier jet passait un objet et appelait
 * `list()` — les deux faux. La garde du test l'a DIT au lieu de laisser passer un cas creux, ce qui est
 * exactement ce qu'on lui demande. */
const ligne = (id, body) => JSON.stringify({ id, thread: 't-1', from: '0x' + '1'.repeat(40),
  to: '0x' + '2'.repeat(40), body, ts: 1, origin: 'human', dir: 'in', rxAt: 1 });

/* ─────────── L'INVARIANT: la forme de retour n'a PAS bougé (les ~30 appelants sont intacts) ─────────── */

t('INVARIANT: all() rend toujours un tableau — absente et corrompue rendent toutes deux []', () => {
  const absente = createStore(fichierTemp(null)).all();
  const corrompue = createStore(fichierTemp('{ceci n est pas du JSON  ')).all();
  assert.deepStrictEqual(absente, corrompue,
    'VOULU: le correctif ne change AUCUNE valeur de retour — la distinction vit dans health(), pas ici');
  assert.strictEqual(absente.length, 0, 'les deux rendent une lecture vide');
  /* ⛔ C'est le contrat choisi: `all()` reste un tableau que ~30 sites `.filter()` sans regarder.
   * Ce que l'appelant peut DESORMAIS faire, c'est demander pourquoi il est vide — cas suivants. */
});

t('temoin — une base LISIBLE et non vide rend bien ses lignes', () => {
  const rows = createStore(fichierTemp(ligne('m-1', 'salut') + '\n')).all();
  assert.ok(Array.isArray(rows), 'la lecture doit rendre un tableau');
  assert.strictEqual(rows.length, 1,
    'temoin: sans ce cas, un store qui rendrait TOUJOURS [] passerait le cas precedent sans rien prouver');
});

t('une ligne CORROMPUE disparait toujours de all() — mais elle est desormais COMPTEE', () => {
  const s = createStore(fichierTemp(
    ligne('m-1', 'un') + '\n{tronque\n' + ligne('m-2', 'deux') + '\n'));
  assert.strictEqual(s.all().length, 2, 'la ligne illisible est toujours SAUTEE (comportement inchange)');
  const h = s.health().messages;
  assert.strictEqual(h.state, 'damaged', 'CE QUI CHANGE: le journal se declare abime, il ne se tait plus');
  assert.strictEqual(h.corruptLines, 1, 'une ligne perdue, comptee');
  assert.strictEqual(h.lines, 3, 'sur trois lignes lues');
  /* ⚠️ Un journal a moitie ecrit — la signature exacte d'un volume plein — perdait des messages sans
   * qu'aucun compteur ne le signale. C'est ce compteur, pas l'erreur `fs`, qui attrape ce cas-la:
   * une queue tronquee se LIT tres bien, elle ne leve rien. Mesure ici, pas supposee. */
});

/* ─────────── LE CORRECTIF: la distinction, ajoutée à côté ─────────── */

t('LE CORRECTIF: health() distingue absente / vide / saine / abimee / illisible', () => {
  const etat = (p) => createStore(p, p + '.control').health().messages.state;
  assert.strictEqual(etat(fichierTemp(null)), 'absent',
    'noeud NEUF: etat NORMAL, aucune action — c est la moitie de la confusion qu on corrige');
  assert.strictEqual(etat(fichierTemp('')), 'empty',
    'fichier de zero octet: rapporte, mais PAS accuse — compact() en produit un legitimement');
  assert.strictEqual(etat(fichierTemp(ligne('m-1', 'ok') + '\n')), 'ok', 'journal sain');
  assert.strictEqual(etat(fichierTemp(ligne('m-1', 'ok') + '\n{tronque\n')), 'damaged', 'queue tronquee');
  assert.strictEqual(etat(repertoireTemp()), 'unreadable', 'la lecture elle-meme a echoue');
  /* ⛔ LE POINT DE TOUT L'EXERCICE: ces cinq-la rendaient hier la meme phrase. « personne ne t a ecrit »
   * et « ton journal est casse » sont maintenant deux reponses differentes a la meme question. */
});

t('un journal ILLISIBLE se declare — avec un detail qui dit que ce N EST PAS un demarrage a froid', () => {
  const h = createStore(repertoireTemp()).health().messages;
  assert.strictEqual(h.state, 'unreadable');
  assert.ok(h.code, 'le code errno de la plateforme est rapporte tel quel (EISDIR ici), jamais devine');
  assert.match(h.detail, /NOT a cold start/,
    'un etat sans phrase est un drapeau que personne ne lit: le detail doit nommer la consequence');
});

t('un journal ABIME sert quand meme ses lignes LISIBLES (le correctif ne fait pas fail-closed)', () => {
  const s = createStore(fichierTemp(ligne('m-1', 'un') + '\n{tronque\n' + ligne('m-2', 'deux') + '\n'));
  assert.deepStrictEqual(s.all().map((m) => m.body).sort(), ['deux', 'un'],
    'refuser la lecture aurait fait perdre les messages LISIBLES en plus de celui qui manquait deja');
});

/* ─────────── La ligne 109: la valeur neutre qui affirmait ─────────── */

t('compact() ne rend PLUS un zero menteur quand il n a rien pu lire', () => {
  const r = createStore(repertoireTemp()).compact();
  assert.strictEqual(r.state, 'unreadable', 'l etat nomme ce qui s est passe');
  assert.strictEqual(r.removed, null, '« removed: 0 » affirmait « rien a retirer »; null dit « je ne sais pas »');
  assert.strictEqual(r.kept, null);
  assert.strictEqual(r.totalBefore, null);
  assert.ok(r.detail, 'et la raison voyage avec');
});

t('compact() sur un noeud NEUF: des zeros HONNETES, et aucun fichier cree', () => {
  const p = fichierTemp(null);
  const r = createStore(p).compact();
  assert.strictEqual(r.state, 'absent', 'un noeud neuf n a rien a compacter, et le dit');
  assert.strictEqual(r.removed, 0, 'ici le zero est VRAI: il n y avait effectivement rien');
  assert.strictEqual(fs.existsSync(p), false,
    'et compacter une base absente ne doit pas la CREER — sinon absent devient empty au premier boot');
});

t('compact() rapporte les lignes qu il vient de detruire pour de bon', () => {
  const p = fichierTemp(ligne('m-1', 'un') + '\n{tronque\n' + ligne('m-2', 'deux') + '\n');
  const s = createStore(p);
  const r = s.compact();
  assert.strictEqual(r.state, 'damaged', 'la reecriture porte sur un journal abime, et le dit');
  assert.strictEqual(r.corruptLines, 1, 'la ligne illisible a ete droppee du disque — definitivement');
  assert.strictEqual(s.health().messages.state, 'ok',
    'apres reecriture le fichier est reellement sain: le verdict suit le disque, il ne se fige pas');
  /* ⚠️ La perte n est donc plus rattrapable APRES coup: elle ne vit que dans cette valeur de retour.
   * C est pourquoi server.js la journalise au boot au lieu de l ignorer comme avant. */
});

/* ─────────── Le journal de CONTRÔLE: celui qui porte les blocages ─────────── */

t('le journal de CONTROLE a son propre verdict — un blocage perdu est un harceleur qui revient', () => {
  const p = fichierTemp(ligne('m-1', 'ok') + '\n');
  const ctrl = p + '.control';
  fs.writeFileSync(ctrl, JSON.stringify({ type: 'block', addr: '0x' + '9'.repeat(40), at: 1 }) + '\n{tronq');
  const h = createStore(p, ctrl).health();
  assert.strictEqual(h.messages.state, 'ok', 'les messages vont bien');
  assert.strictEqual(h.control.state, 'damaged', 'mais la liste de blocages a perdu une ligne');
  assert.strictEqual(h.control.corruptLines, 1);
  /* ⛔ Pourquoi ce cas existe: un demi-journal de controle ne rend pas une boite vide, il rend un
   * BLOCAGE DISPARU. La ligne 47 avalait exactement ca, et c est plus grave qu un message manquant. */
});

t('health().ok est le rollup: vrai sur un noeud sain, faux des qu un journal demande un regard', () => {
  const sain = fichierTemp(ligne('m-1', 'ok') + '\n');
  assert.strictEqual(createStore(sain, sain + '.control').health().ok, true,
    'temoin: un health() qui crierait toujours ne prouverait rien dans les cas ci-dessus');
  const neuf = fichierTemp(null);
  assert.strictEqual(createStore(neuf, neuf + '.control').health().ok, true,
    'un noeud NEUF est sain: absent est benin, c est tout l objet de la distinction');
  const abime = fichierTemp(ligne('m-1', 'ok') + '\n{tronque\n');
  assert.strictEqual(createStore(abime, abime + '.control').health().ok, false,
    'abime demande un regard');
  assert.strictEqual(createStore(repertoireTemp()).health().ok, false, 'illisible aussi');
});

const ATTENDUS = 11;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
