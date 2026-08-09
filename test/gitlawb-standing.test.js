#!/usr/bin/env node
'use strict';
/**
 * gitlawb-standing: les cas viennent de sorties RÉELLES de `gl 0.7.0`, sondées avant d'écrire le module.
 *
 * ⛔ LE PIÈGE CENTRAL, mesuré et non supposé: un DID totalement inexistant rend
 *
 *     Trust score for did:key:zZZZinexistantZZZ
 *       Score:  0.00
 *       Level:  newcomer
 *
 * — c'est-à-dire EXACTEMENT ce que rend un vrai agent sans historique. Un module qui ne lirait que
 * `trust` publierait donc « score 0 » sur une identité fabriquée sans jamais dire que le réseau ne la
 * connaît pas. `resolve` tranche (« DID not found … not in peer list »), donc les deux sont lus.
 *
 * ⛔ ET UNE SORTIE ILLISIBLE DOIT RENDRE `null`, JAMAIS ZÉRO. Zéro est un score — la pire note qu'un
 * agent réel puisse avoir. Le rendre sur une lecture ratée transformerait « je n'ai pas su lire » en
 * « cet agent ne vaut rien », et l'admission croirait avoir jugé.
 */
const assert = require('node:assert');
const { parseTrust, parseResolve, makeLireStanding, LECTURES_AUTORISEES } = require('../lib/gitlawb-standing');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('gitlawb-standing: lire un standing sans inventer de zero');

/* Sorties RÉELLES, copiées de la sonde du 2026-08-09 contre gl 0.7.0. */
const TRUST_INCONNU = 'Trust score for did:key:zZZZinexistantZZZ\n  Score:  0.00\n  Level:  newcomer\n  Pushes: 0\n';
const RESOLVE_INCONNU = 'DID not found: did:key:zZZZinexistantZZZ\n  (not this node and not in peer list)\n';

/* ── 1. LE PARSING, SUR LA SORTIE RÉELLE ──────────────────────────────────────────────────────────── */

t('★ la sortie REELLE de gl se lit: score et niveau', () => {
  const r = parseTrust(TRUST_INCONNU);
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.level, 'newcomer');
});

t('★ un score lisible NON NUL se lit aussi — sinon le parseur pourrait rendre 0 pour tout', () => {
  const r = parseTrust('Trust score for did:key:zA\n  Score:  0.73\n  Level:  established\n');
  assert.strictEqual(r.score, 0.73, 'temoin: un parseur qui rend toujours 0 passerait le cas precedent');
  assert.strictEqual(r.level, 'established');
});

t('★ une sortie ILLISIBLE rend null, jamais zero', () => {
  for (const s of ['', '   ', 'erreur reseau', null, undefined, 42, 'Level: newcomer']) {
    assert.strictEqual(parseTrust(s).score, null, 'entree=' + JSON.stringify(s)
      + ' : zero serait un JUGEMENT, pas une lecture ratee');
  }
});

t('★ un score HORS de [0,1] est refuse, pas tronque', () => {
  for (const v of ['1.5', '42', '-0.2']) {
    assert.strictEqual(parseTrust('Score:  ' + v).score, null, 'score=' + v + ' n est pas un trust_score');
  }
});

/* ── 2. CE QUE `trust` SEUL NE PEUT PAS DIRE ──────────────────────────────────────────────────────── */

t('★ `resolve` distingue INCONNU de connu-sans-standing — ce que `trust` confond', () => {
  assert.strictEqual(parseResolve(RESOLVE_INCONNU), false);
  assert.strictEqual(parseResolve('did:key:zA\n  node: https://n\n  last seen: 2026-08-09\n'), true);
  assert.strictEqual(parseResolve(''), null, 'rien lu: on ne tranche pas, on le dit');
});

t('★ un DID FABRIQUE est rapporte comme inconnu, meme si son score vaut 0 comme un vrai debutant', async () => {
  const lire = makeLireStanding({
    node: 'https://noeud-choisi-par-l-operateur',
    lancer: async (args) => (args[1] === 'trust' ? TRUST_INCONNU : RESOLVE_INCONNU),
  });
  const r = await lire('did:key:zZZZinexistantZZZ');
  assert.strictEqual(r.trust, 0);
  assert.strictEqual(r.knownToNetwork, false, 'le module doit DIRE que le reseau ignore ce DID');
  assert.ok(/artefact/.test(r.note), 'la note doit expliquer que ce 0 n est pas un jugement: ' + r.note);
});

t('★ le cas OPPOSE: un DID connu avec du standing ne porte aucune note d alerte', async () => {
  const lire = makeLireStanding({
    node: 'https://n',
    lancer: async (args) => (args[1] === 'trust'
      ? 'Score:  0.61\n  Level:  established\n' : 'did:key:zA\n  node: https://n\n'),
  });
  const r = await lire('did:key:zA');
  assert.strictEqual(r.trust, 0.61);
  assert.strictEqual(r.knownToNetwork, true);
  assert.strictEqual(r.note, null, 'une note d alerte sur un cas normal la rendrait ignorable');
});

/* ── 3. LE NŒUD EST UNE DÉCISION, PAS UN DÉFAUT ───────────────────────────────────────────────────── */

t('★ sans `node`, le module REFUSE de se construire — un defaut prendrait la decision a notre place', () => {
  assert.throws(() => makeLireStanding({ lancer: async () => '' }), /node.*requis/i);
  assert.throws(() => makeLireStanding({ lancer: async () => '', node: '  ' }), /node.*requis/i);
  assert.throws(() => makeLireStanding({ node: 'https://n' }), /lancer.*requis/i);
});

t('★ le noeud interroge VOYAGE dans la reponse — sans ca « decentralise » est invérifiable', async () => {
  const n = 'https://un-noeud-tiers-mise-on-chain';
  const lire = makeLireStanding({ node: n, lancer: async () => 'Score:  0.5\n' });
  assert.strictEqual((await lire('did:key:zA')).source, n);
});

t('★ le noeud choisi est REELLEMENT passe a la CLI, pas seulement rapporte', async () => {
  const vus = [];
  const lire = makeLireStanding({ node: 'https://choisi', lancer: async (a) => { vus.push(a.join(' ')); return 'Score:  0.5\n'; } });
  await lire('did:key:zA');
  assert.ok(vus.every((c) => c.includes('--node https://choisi')),
    'rapporter un noeud sans l interroger serait un mensonge poli: ' + JSON.stringify(vus));
});

/* ── 4. AUCUNE ÉCRITURE, JAMAIS ───────────────────────────────────────────────────────────────────── */

t('★ seules `trust` et `resolve` sont autorisees — ni register, ni init, ni identity', async () => {
  assert.deepStrictEqual([...LECTURES_AUTORISEES].sort(), ['resolve', 'trust']);
  const vus = [];
  const lire = makeLireStanding({ node: 'https://n', lancer: async (a) => { vus.push(a[1]); return 'Score:  0.5\n'; } });
  await lire('did:key:zA');
  /* `gl node register` MISE des fonds on-chain et `gl identity` CREE une paire de cles. Qu'aucune ne
   * puisse etre atteinte depuis ce chemin n'est pas une precaution decorative. */
  for (const s of vus) assert.ok(LECTURES_AUTORISEES.includes(s), 'sous-commande interdite invoquee: ' + s);
  assert.ok(!vus.includes('register') && !vus.includes('init'));
});

/* ── 5. UNE PANNE REMONTE ─────────────────────────────────────────────────────────────────────────── */

t('★ une panne du lanceur REMONTE — elle ne devient jamais un standing de zero', async () => {
  const lire = makeLireStanding({ node: 'https://n', lancer: async () => { throw new Error('gl introuvable'); } });
  await assert.rejects(() => lire('did:key:zA'), /introuvable/);
});

const ATTENDUS = 12;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
