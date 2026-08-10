#!/usr/bin/env node
'use strict';
/**
 * CARACTERISATION — la porte « pair adoube » est-elle atteignable contre l'oracle REEL ?
 * ================================================================================================
 * ⛔ CE FICHIER NE CORRIGE RIEN. Il epingle ce que le code fait AUJOURD'HUI face aux reponses que
 * l'oracle d'admission rend REELLEMENT, parce que la correction est une SEMANTIQUE PRODUIT — qui
 * merite d'etre adoube — et cette decision appartient a l'operateur, pas a ce test.
 *
 * ═══ CE QUI A ETE MESURE LE 2026-08-10, EN LECTURE SEULE, SUR LE SERVICE VIVANT ═══
 *
 * `GET https://avisradar-production.up.railway.app/api/agent/preflight/<addr>` a rendu, HTTP 200:
 *
 *   adresse jamais indexee  ->  { decision: 'CAUTION',            score: null }
 *   contrat tres connu      ->  { decision: 'PROCEED_LOW_VALUE',  score: null }
 *   adresse malformee       ->  HTTP 400 { error }        (refus correct)
 *
 * ⚠️ `score` etait `null` dans les DEUX reponses a 200. Ce n'est pas un zero: c'est « pas calcule ».
 *
 * ═══ DEUX RAISONS INDEPENDANTES POUR QUE `proceed` SOIT TOUJOURS FAUX ═══
 *
 * `lib/relay.js` : `const proceed = !!v && v.decision === 'PROCEED' && Number(v.score) >= minScore;`
 *
 *   1. LE VOCABULAIRE. La garde exige `'PROCEED'` EXACTEMENT. Le depot frere `biii` connait pourtant
 *      le vocabulaire complet et en accepte DEUX — `biii/lib/trust.js:21-24` porte le commentaire
 *      « MainStreet emits BLOCK/CAUTION/PROCEED/PROCEED_LOW_VALUE » et l'allowlist
 *      `REP_SAFE = new Set(['PROCEED', 'PROCEED_LOW_VALUE', 'SAFE', 'OK', 'PASS'])`.
 *      Deux consommateurs du MEME oracle, deux allowlists differentes.
 *
 *   2. LE SCORE. `Number(null)` vaut 0, donc `0 >= 40` est faux. Meme un `PROCEED` litteral echouerait
 *      tant que l'oracle ne rend pas de score.
 *
 * ⛔ CE N'EST PAS UN TROU DE SECURITE — la garde echoue en FERME. C'est une porte qui ne s'ouvre
 * jamais: personne ne peut etre admis comme pair ADOUBE, donc `minScore` ne borne rien et le palier
 * « adoube » n'existe pas en pratique. C'est la troisieme forme de ce motif trouvee en une nuit, et la
 * seule qu'aucun test de refus ne pouvait voir.
 *
 * ⚠️ CE QUE CE FICHIER NE PROUVE PAS: que l'oracle ne rendra JAMAIS `PROCEED` ni de score. Trois
 * reponses ne sont pas un contrat. Le producteur de `/api/agent/preflight` n'est dans AUCUNE branche
 * du depot `mainstreet` (verifie: `git log --all -S` sur les 18 branches ne trouve ni la route ni
 * `PROCEED_LOW_VALUE`), donc son vocabulaire n'a pas pu etre lu a la source.
 */
const assert = require('node:assert');
const { createRelay } = require('../lib/relay');
const { buildEnvelope } = require('../lib/envelope');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('oracle: la porte « pair adoube » est-elle atteignable ? (caracterisation, pas correctif)');

const MOI = '0x' + '11'.repeat(20);
const INCONNU = '0x' + '22'.repeat(20);
const enveloppe = () => buildEnvelope({ from: INCONNU, to: MOI, body: 'bonjour', viaHuman: null }).envelope;
/* `admitProbation: false` EXPRES: la probation masquerait la question en admettant tout le monde a 0. */
const relais = (preflight) => createRelay({ self: MOI, allowUnauthenticated: true,
  admitProbation: false, preflight });

/* ── 1. LE TEMOIN — sans lui, tout ce fichier passerait sur une garde qui refuse TOUT ─────────────── */

t('★ TEMOIN: `PROCEED` + un vrai score PASSE — la porte existe et sait s ouvrir', async () => {
  const r = await relais(async () => ({ decision: 'PROCEED', score: 60 })).accept(enveloppe());
  assert.notStrictEqual(r.action, 'drop',
    'sans ce cas, une garde qui refuse tout rendrait les assertions ci-dessous vides de sens');
  assert.strictEqual(r.senderScore, 60, 'et le score de l expediteur voyage jusqu au verdict');
  assert.strictEqual(r.probation, false, 'un pair adoube n est pas un probationnaire');
});

/* ── 2. RAISON 1: LE VOCABULAIRE ──────────────────────────────────────────────────────────────────── */

t('★ `PROCEED_LOW_VALUE` avec un BON score est REFUSE — le depot frere `biii` l accepte pourtant', async () => {
  const r = await relais(async () => ({ decision: 'PROCEED_LOW_VALUE', score: 60 })).accept(enveloppe());
  assert.strictEqual(r.action, 'drop');
  assert.match(r.reason, /not PROCEED/,
    'le refus doit nommer la decision, pas laisser croire a un probleme de score');
  /* ⛔ C'est LA divergence: `biii/lib/trust.js` met PROCEED_LOW_VALUE dans son allowlist REP_SAFE,
   * `lawbor/lib/relay.js` ne reconnait que PROCEED. Meme oracle, deux verdicts opposes. */
});

t('`CAUTION` est refuse aussi — attendu, et il borne le cas precedent', async () => {
  const r = await relais(async () => ({ decision: 'CAUTION', score: 60 })).accept(enveloppe());
  assert.strictEqual(r.action, 'drop', 'sinon le refus de PROCEED_LOW_VALUE ne dirait rien de special');
});

/* ── 3. RAISON 2: LE SCORE, INDEPENDANTE DE LA PREMIERE ───────────────────────────────────────────── */

t('★ `PROCEED` LITTERAL avec `score: null` est refuse — `Number(null)` vaut 0, pas « inconnu »', async () => {
  const r = await relais(async () => ({ decision: 'PROCEED', score: null })).accept(enveloppe());
  assert.strictEqual(r.action, 'drop');
  assert.match(r.reason, /too low to relay/,
    'le refus doit venir du SCORE ici, ce qui prouve que la raison est bien independante du vocabulaire');
  /* ⚠️ `null` n'est pas un zero: c'est « pas calcule ». Le traiter comme 0 fait echouer en ferme —
   * conservateur, mais le message annonce « score null < 40 » comme si la mesure avait eu lieu. */
});

/* ── 4. LA FORME REELLEMENT SERVIE, LES DEUX RAISONS A LA FOIS ────────────────────────────────────── */

t('★ la reponse REELLE de l oracle (`PROCEED_LOW_VALUE` + `score: null`) est refusee', async () => {
  const r = await relais(async () => ({ decision: 'PROCEED_LOW_VALUE', score: null })).accept(enveloppe());
  assert.strictEqual(r.action, 'drop',
    'c est la forme mesuree en prod le 2026-08-10 sur un contrat tres connu');
  /* Et le vocabulaire l emporte sur le score dans le message: l operateur qui debogue verra
   * « not PROCEED » et non « score trop bas », donc il regardera la BONNE moitie du probleme. */
  assert.match(r.reason, /not PROCEED/);
});

const ATTENDUS = 5;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
