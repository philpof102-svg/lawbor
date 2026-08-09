#!/usr/bin/env node
'use strict';
/**
 * admission-wiring: ce qui se teste ici, c'est qu'un nœud REFUSE de démarrer plutôt que de démarrer
 * en n'admettant plus personne.
 *
 * ⛔ LE DÉFAUT D'ORIGINE ÉTAIT DANS MON PROPRE TRAVAIL. `build(deps)` accepte `deps.preflight` depuis
 * toujours, mais `server.js` lancé directement — et `lawbor-node` EST `server.js` — appelle
 * `build({ apps: [...] })` sans jamais en passer un. Les trois modules d'admission écrits aujourd'hui
 * étaient donc INATTEIGNABLES pour quiconque lance le binaire livré.
 *
 * ⛔ ET L'ACTIVER NAÏVEMENT SERAIT PIRE QUE DE NE RIEN FAIRE. Sans magasin d'attestations, le preflight
 * gitlawb rend `NO-BINDING` pour TOUT LE MONDE: plus personne n'entre. C'est « la porte se ferme sur
 * tous », l'une des deux façons dont une admission casse. Un nœud qui démarre dans cet état A L'AIR
 * VIVANT, ce qui est exactement ce qui le rend dangereux.
 *
 * ⚠️ Et un TÉMOIN: des environnements différents doivent produire des plans différents. Un plan
 * constant passerait tous les refus ci-dessous sans rien décider.
 */
const assert = require('node:assert');
const { planAdmissionWiring, messageDeRefus } = require('../lib/admission-wiring');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('admission-wiring: inerte par defaut, bruyant si incomplet');

/* ── 1. INERTE PAR DÉFAUT, ET IL LE DIT ───────────────────────────────────────────────────────────── */

t('★ sans LAWBOR_ORACLE: rien ne change, et la raison annonce que operatedByUs restera true', () => {
  for (const env of [{}, { LAWBOR_ORACLE: '' }, { LAWBOR_ORACLE: '   ' }]) {
    const p = planAdmissionWiring(env);
    assert.strictEqual(p.mode, 'defaut', JSON.stringify(env));
    assert.strictEqual(p.ok, true, 'ne rien demander n est pas une faute');
    assert.ok(/operatedByUs.*true/.test(p.raison),
      'un retour neutre MUET laisserait croire que le noeud est decentralise: ' + p.raison);
  }
});

/* ── 2. LE REFUS QUI PROTÈGE — la porte qui se ferme sur tous ─────────────────────────────────────── */

t('★ gitlawb SANS magasin d attestations: REFUS, et la raison dit que personne n entrerait', () => {
  const p = planAdmissionWiring({ LAWBOR_ORACLE: 'gitlawb', GITLAWB_NODE: 'https://n' });
  assert.strictEqual(p.ok, false);
  assert.ok(p.manque.some((m) => /LAWBOR_BINDINGS/.test(m)), JSON.stringify(p.manque));
  assert.ok(/PERSONNE n entre/.test(p.manque.join(' ')),
    'le message doit dire la CONSEQUENCE, pas seulement nommer la variable');
  assert.ok(/a l air vivant/.test(p.raison), p.raison);
});

t('★ gitlawb SANS noeud: REFUS — aucun defaut, parce que le choix du noeud EST la decision', () => {
  const p = planAdmissionWiring({ LAWBOR_ORACLE: 'gitlawb', LAWBOR_BINDINGS: '/tmp/b.jsonl' });
  assert.strictEqual(p.ok, false);
  assert.ok(p.manque.some((m) => /GITLAWB_NODE/.test(m)), JSON.stringify(p.manque));
  assert.ok(/aucun defaut, c est une decision/.test(p.manque.join(' ')),
    'retomber sur le noeud par defaut de `gl` deplacerait la centralisation au lieu de la retirer');
});

t('★ gitlawb SANS verificateur de signatures: REFUS — la MEME porte fermee, par un autre chemin', () => {
  /* ⛔ Cas trouve EN CABLANT, pas en concevant. Sans verificateur, `did-binding` rend `bound: false`
   * pour toute attestation, donc `UNVERIFIED-CLAIM` pour tout le monde: la porte se referme aussi
   * surement que sans magasin, mais par un chemin different. Deux exigences ne suffisaient pas. */
  const p = planAdmissionWiring({ LAWBOR_ORACLE: 'gitlawb', GITLAWB_NODE: 'https://n',
    LAWBOR_BINDINGS: '/tmp/b.jsonl' });
  assert.strictEqual(p.ok, false, 'deux variables sur trois ne suffisent pas');
  assert.ok(p.manque.some((m) => /LAWBOR_BINDING_VERIFIER/.test(m)), JSON.stringify(p.manque));
  assert.ok(/PRETENTION/.test(p.manque.join(' ')),
    'le message doit dire POURQUOI: sans signature, une attestation est une pretention');
});

t('une valeur INCONNUE est refusee, jamais ignoree en silence', () => {
  const p = planAdmissionWiring({ LAWBOR_ORACLE: 'quelquechose' });
  assert.strictEqual(p.ok, false);
  assert.ok(/inconnu/.test(p.raison), p.raison);
  /* ⛔ Ignorer une valeur non reconnue ferait demarrer avec l oracle par defaut alors que l operateur
   * a EXPLICITEMENT demande autre chose — il croirait avoir change de porte. */
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LA CONFUSION DE VARIABLES — trouvee en LISANT l'environnement de production, pas en concevant.
 *
 * `LAWBOR_ADMIT` existe deja et vaut `probation` en prod. Elle gouverne la conduite quand l'oracle est
 * EN PANNE — `server.js:261` teste `=== 'probation'`, donc toute autre valeur la coupe. Ma variable
 * s'appelait `LAWBOR_ADMISSION`: quatre caracteres d'ecart, et toutes deux « d'admission ».
 *
 * ⛔ Quelqu'un qui tape `LAWBOR_ADMIT=gitlawb` en croyant choisir un oracle obtient DEUX effets faux et
 * MUETS: l'oracle ne change pas, et la probation vient d'etre desactivee. Renommer ne protege pas de
 * ca — seule une detection le fait.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

t('★ LAWBOR_ADMIT contenant un nom d ORACLE est une confusion — refus, avec la correction nommee', () => {
  const p = planAdmissionWiring({ LAWBOR_ADMIT: 'gitlawb' });
  assert.strictEqual(p.ok, false, 'demarrer ici couperait la probation en silence');
  assert.ok(/ne CHOISIT PAS d oracle/.test(p.raison), p.raison);
  assert.ok(/DESACTIVER la probation/.test(p.raison), 'le message doit dire les DEUX effets: ' + p.raison);
  assert.ok(/LAWBOR_ORACLE="gitlawb"/.test(p.raison),
    'et proposer la correction exacte, sinon la garde bloque sans aider: ' + p.raison);
});

t('★ le cas OPPOSE — LAWBOR_ADMIT=probation est LEGITIME et ne declenche rien', () => {
  /* C est la valeur POSEE en production. Une garde qui la refuserait casserait le noeud vivant au
   * prochain deploiement — une garde qui crie au loup se fait desactiver, et celle-ci tuerait. */
  for (const v of ['probation', 'PROBATION', ' probation ', '', undefined, 'off']) {
    const p = planAdmissionWiring({ LAWBOR_ADMIT: v });
    assert.strictEqual(p.ok, true, 'LAWBOR_ADMIT=' + JSON.stringify(v) + ' doit rester accepte');
    assert.strictEqual(p.mode, 'defaut');
  }
});

/* ── 3. LE CAS QUI MARCHE, SANS QUOI LES REFUS NE PROUVENT RIEN ───────────────────────────────────── */

t('★ TEMOIN — les deux variables posees: le plan passe en mode gitlawb', () => {
  const p = planAdmissionWiring({ LAWBOR_ORACLE: 'gitlawb',
    GITLAWB_NODE: 'https://node.gitlawb.com', LAWBOR_BINDINGS: '/data/bindings.jsonl',
    LAWBOR_BINDING_VERIFIER: '/data/verifier.js' });
  assert.strictEqual(p.ok, true, 'sans ce cas, un plan qui refuse TOUT passerait les trois precedents');
  assert.strictEqual(p.mode, 'gitlawb');
  assert.strictEqual(p.node, 'https://node.gitlawb.com');
  assert.ok(/bindings.jsonl/.test(p.raison), 'la raison doit nommer les deux sources: ' + p.raison);
});

t('★ TEMOIN 2 — des environnements differents donnent des plans differents', () => {
  const a = planAdmissionWiring({});
  const b = planAdmissionWiring({ LAWBOR_ORACLE: 'gitlawb', GITLAWB_NODE: 'https://n',
    LAWBOR_BINDINGS: '/b.jsonl' });
  assert.notStrictEqual(a.mode, b.mode, 'sortie constante: l environnement n est lu par personne');
});

/* ── 4. LE MESSAGE D'ARRÊT DOIT ÊTRE ACTIONNABLE ──────────────────────────────────────────────────── */

t('★ le message de refus nomme CE QUI MANQUE et comment revenir en arriere', () => {
  const p = planAdmissionWiring({ LAWBOR_ORACLE: 'gitlawb' });
  const m = messageDeRefus(p);
  assert.ok(/GITLAWB_NODE/.test(m) && /LAWBOR_BINDINGS/.test(m), 'les DEUX manques doivent apparaitre');
  assert.ok(/retirer LAWBOR_ORACLE/.test(m),
    'un message qui bloque sans dire comment repartir transforme une garde en impasse');
  assert.ok(m.split('\n').length >= 3, 'une ligne unique ne suffit pas a etre actionnable');
});

const ATTENDUS = 10;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
