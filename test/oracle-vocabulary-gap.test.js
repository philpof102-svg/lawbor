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
 * ═══ MISE A JOUR DU 2026-08-10: LE PRODUCTEUR A ETE LOCALISE, ET IL TRANCHE ═══
 *
 * ⚠️ La borne ecrite ici disait « trois reponses ne sont pas un contrat, et le producteur n'est dans
 * aucune branche de `mainstreet` ». La premiere moitie restait vraie, la seconde etait une limite de MA
 * RECHERCHE: le producteur vit dans un depot voisin, `avisradar/src/mainstreet/preflight-core.js`
 * (`avisradar-production.up.railway.app` appartient au projet Railway `avisradar`).
 *
 * SON CONTRAT, LU A LA SOURCE — et c'est une ALLOWLIST PAR EXCLUSION:
 *
 *     function isAllowed(decision, score, minScore = 30) {
 *       if (decision === 'BLOCK') return false;
 *       if (decision === 'CAUTION' && (score == null || Number(score) < minScore)) return false;
 *       return true;                       // TOUT LE RESTE EST AUTORISE
 *     }
 *
 * Et son propre test (`scripts/test-preflight-core.js`) epingle deux choses:
 *     « green + no score -> PROCEED_LOW_VALUE »   et   « PROCEED_LOW_VALUE always allowed »
 *
 * ⛔ DONC LES DEUX COTES SONT DE FORMES OPPOSEES. Le producteur refuse par EXCEPTION (deux cas nommes),
 * `lib/relay.js` autorise par EXCEPTION (un seul cas nomme, plus un plancher qu'un `null` ne franchit
 * jamais). Contre la reponse REELLE (`PROCEED_LOW_VALUE` + `score: null`), le producteur dit AUTORISE
 * et `lawbor` dit REFUSE. Les planchers par defaut different aussi: 30 la-bas, 40 ici.
 *
 * ⚠️ ETRE PLUS STRICT QUE SON ORACLE N'EST PAS UN BUG EN SOI — un consommateur a le droit d'exiger
 * davantage. Le defaut est que cette barre est INATTEIGNABLE: aucune reponse reelle ne peut la
 * satisfaire, donc ce n'est pas une politique plus stricte, c'est du code mort. Et le depot frere `biii`
 * (`lib/trust.js`), consommateur du MEME oracle, implemente lui la semantique du producteur.
 *
 * ⛔ CE QUI RESTE A L'OPERATEUR: choisir entre suivre le contrat de l'oracle, ou garder une barre plus
 * haute — mais alors une barre que quelque chose puisse franchir.
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

/* ── 5. LE PLANCHER, TROISIEME DIVERGENCE MESUREE ─────────────────────────────────────────────────── */

t('le plancher par defaut de `lawbor` est 40 — celui du producteur est 30', async () => {
  /* ⚠️ Epingle ici parce que c'est le genre d'ecart qui se decouvre au pire moment: un score de 35
   * passerait chez l'oracle et serait refuse ici, sans qu'aucun message ne mentionne deux planchers.
   * Ce cas ne dit PAS lequel est bon — il rend l'ecart visible et testable. */
  const passe = await relais(async () => ({ decision: 'PROCEED', score: 45 })).accept(enveloppe());
  assert.notStrictEqual(passe.action, 'drop', 'au-dessus des deux planchers: passe');

  const entre = await relais(async () => ({ decision: 'PROCEED', score: 35 })).accept(enveloppe());
  assert.strictEqual(entre.action, 'drop',
    'ENTRE les deux planchers (30 chez le producteur, 40 ici): autorise la-bas, refuse ici');
  assert.match(entre.reason, /too low to relay/);
});

const ATTENDUS = 6;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
