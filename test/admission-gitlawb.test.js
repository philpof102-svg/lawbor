#!/usr/bin/env node
'use strict';
/**
 * admission-gitlawb: ce qui se teste ici, c'est une PORTE D'ENTRÉE — donc les deux façons de la casser.
 *
 * Une porte d'admission échoue de deux manières opposées, et les deux sont graves:
 *   · elle s'ouvre à tout le monde (une prétention non signée passe pour une liaison prouvée) ;
 *   · elle se ferme sur tout le monde (une échelle mal convertie met chaque agent sous le plancher).
 * Les cas ci-dessous couvrent les deux sens, plus le troisième défaut qui n'est ni l'un ni l'autre:
 * une PANNE de lecture transformée en jugement.
 *
 * ⛔ LE CAS QUI PORTE LE PLUS: un `throw` de la lecture de réputation doit REMONTER. Le relais sait
 * gérer un preflight qui jette — il met en probation ou ferme, selon sa config. Il ne sait pas
 * distinguer « j'ai lu zéro » de « je n'ai pas pu lire ». Rendre un score neutre sur une panne
 * condamnerait un agent au lieu de le mettre en probation, et le nœud croirait avoir jugé.
 *
 * ⚠️ Et un TÉMOIN: des réputations différentes doivent produire des scores différents. Une sortie
 * constante passerait tous les tests de refus ci-dessus sans rien décider.
 */
const assert = require('node:assert');
const { planAdmission, makeGitlawbPreflight, ECHELLE } = require('../lib/admission-gitlawb');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('admission-gitlawb: une porte casse dans les DEUX sens');

const LIE = { bound: true, did: 'did:key:zTEST' };

/* ── 1. LA PORTE NE DOIT PAS S OUVRIR ─────────────────────────────────────────────────────────────── */

t('★ aucune liaison: REFUS, et ce n est pas une panne', () => {
  for (const b of [null, undefined, 0, '']) {
    const r = planAdmission({ binding: b, trust: 0.9, minScore: 40 });
    assert.strictEqual(r.decision, 'NO-BINDING', 'binding=' + String(b));
    assert.strictEqual(r.score, 0);
    assert.ok(/se GAGNE et se PROUVE/.test(r.reason), r.reason);
  }
});

t('★ une PRETENTION non verifiee ne passe pas pour une liaison — et se distingue de son absence', () => {
  const r = planAdmission({ binding: { bound: false, did: 'did:key:zX' }, trust: 0.99, minScore: 40 });
  assert.strictEqual(r.decision, 'UNVERIFIED-CLAIM');
  assert.strictEqual(r.score, 0, 'une reputation de 0,99 ne rachete pas une signature absente');
  /* La distinction compte: « pas d attestation » et « attestation non signee » n appellent pas la meme
   * action cote operateur, et les confondre efface un signal d abus. */
  assert.notStrictEqual(r.decision, 'NO-BINDING');
});

t('★ un agent NEUF reste dehors — c est le cas nominal, pas un bug', () => {
  const r = planAdmission({ binding: LIE, trust: 0.05, minScore: 40 });
  assert.strictEqual(r.decision, 'BELOW-FLOOR');
  assert.ok(r.score < 40);
  assert.ok(/0.40/.test(r.reason), 'la raison doit traduire le plancher en termes gitlawb: ' + r.reason);
});

/* ── 2. LA PORTE NE DOIT PAS SE FERMER SUR TOUT LE MONDE ──────────────────────────────────────────── */

t('★ ECHELLE — un standing suffisant PASSE; sans conversion, 0,5 < 40 fermerait sur tous', () => {
  const r = planAdmission({ binding: LIE, trust: 0.5, minScore: 40 });
  assert.strictEqual(r.decision, 'PROCEED', 'gitlawb 0,5 doit passer un plancher de 40 sur echelle '
    + ECHELLE + ' — sinon la conversion est le bug');
  assert.strictEqual(r.score, 50);
  assert.strictEqual(r.did, LIE.did);
});

t('★ la BORNE elle-meme: exactement au plancher, on passe (>=, pas >)', () => {
  const au = planAdmission({ binding: LIE, trust: 0.40, minScore: 40 });
  const sous = planAdmission({ binding: LIE, trust: 0.39, minScore: 40 });
  assert.strictEqual(au.decision, 'PROCEED', 'au plancher exact: ' + au.score);
  assert.strictEqual(sous.decision, 'BELOW-FLOOR');
});

t('★ TEMOIN — des reputations differentes donnent des scores differents', () => {
  const a = planAdmission({ binding: LIE, trust: 0.2, minScore: 40 });
  const b = planAdmission({ binding: LIE, trust: 0.8, minScore: 40 });
  assert.notStrictEqual(a.score, b.score, 'sortie constante: `trust` n est lu par personne');
  assert.ok(b.score > a.score);
});

/* ── 3. UNE VALEUR ILLISIBLE N EST PAS UN JUGEMENT ────────────────────────────────────────────────── */

t('★ un `trust` hors de [0,1] ou non numerique REFUSE en le disant, sans rien affirmer', () => {
  for (const v of [NaN, Infinity, -0.1, 1.5, null, undefined, 'haut', {}]) {
    const r = planAdmission({ binding: LIE, trust: v, minScore: 40 });
    assert.strictEqual(r.decision, 'TRUST-UNREADABLE', 'trust=' + String(v));
    assert.strictEqual(r.score, 0);
    assert.ok(/rien\s+n est affirme/.test(r.reason), r.reason);
  }
});

/* ── 4. LA SOURCE, SANS QUOI « DECENTRALISE » EST INVERIFIABLE ────────────────────────────────────── */

t('★ la SOURCE voyage dans toutes les formes, y compris les refus', () => {
  const s = 'gitlawb-node-de-quelqu-un-d-autre';
  for (const r of [
    planAdmission({ binding: LIE, trust: 0.9, minScore: 40, source: s }),
    planAdmission({ binding: LIE, trust: 0.01, minScore: 40, source: s }),
    planAdmission({ binding: LIE, trust: NaN, minScore: 40, source: s }),
  ]) {
    assert.strictEqual(r.source, s, 'sans savoir QUI a repondu, « decentralise » ne se verifie pas');
  }
});

/* ── 5. CE QUI PORTE LE PLUS: UNE PANNE DOIT LANCER ───────────────────────────────────────────────── */

t('★ une panne de REPUTATION remonte — elle ne devient jamais un score de zero', async () => {
  const pf = makeGitlawbPreflight({
    lireLiaison: async () => LIE,
    lireStanding: async () => { throw new Error('gitlawb injoignable'); },
  });
  await assert.rejects(() => pf('0x' + '1'.repeat(40)), /injoignable/,
    'un retour neutre condamnerait l agent au lieu de le mettre en probation');
});

t('★ une panne de LIAISON remonte aussi', async () => {
  const pf = makeGitlawbPreflight({
    lireLiaison: async () => { throw new Error('resolveur hors service'); },
    lireStanding: async () => ({ trust: 0.9, source: 'x' }),
  });
  await assert.rejects(() => pf('0x' + '1'.repeat(40)), /hors service/);
});

t('★ sans liaison, la reputation n est meme pas demandee', async () => {
  let demande = 0;
  const pf = makeGitlawbPreflight({
    lireLiaison: async () => null,
    lireStanding: async () => { demande++; return { trust: 0.9, source: 'x' }; },
  });
  const r = await pf('0x' + '1'.repeat(40));
  assert.strictEqual(r.decision, 'NO-BINDING');
  assert.strictEqual(demande, 0, 'interroger le reseau sans liaison serait un appel pour rien');
});

t('un preflight sans ses lecteurs REFUSE de se construire', () => {
  assert.throws(() => makeGitlawbPreflight({}), /requis/);
  assert.throws(() => makeGitlawbPreflight({ lireLiaison: () => {} }), /requis/);
});

/* ── 6. LE CONTRAT QUE LE RELAIS LIT VRAIMENT ─────────────────────────────────────────────────────── */

t('★ la forme rendue est celle que le relais consomme: decision === PROCEED ET score >= minScore', async () => {
  const pf = makeGitlawbPreflight({
    lireLiaison: async () => LIE,
    lireStanding: async () => ({ trust: 0.7, source: 'noeud-tiers' }),
    minScore: 40,
  });
  const v = await pf('0x' + '1'.repeat(40));
  /* La ligne exacte de lawbor/lib/relay.js: `v.decision === 'PROCEED' && Number(v.score) >= minScore`. */
  assert.strictEqual(v.decision === 'PROCEED' && Number(v.score) >= 40, true, JSON.stringify(v));
  assert.strictEqual(typeof v.score, 'number', 'un score non numerique rendrait Number(v.score) NaN, '
    + 'et NaN >= minScore est FAUX — la porte se fermerait en ayant l air de decider');
});

const ATTENDUS = 13;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
