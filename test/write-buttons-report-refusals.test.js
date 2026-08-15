'use strict';
/**
 * UNE ECRITURE REFUSEE NE DOIT PAS S'ANNONCER COMME UN SUCCES.
 * ==================================================================================================
 * `fetch()` ne rejette QUE sur une panne reseau. Un 401 ou un 500 rend une promesse RESOLUE, donc un
 * `await fetch(...)` sans lecture de la reponse ne distingue pas « fait » de « refuse ».
 *
 * Les deux boutons du consent gate de `apps/messenger.js` — /accept et /block — faisaient exactement
 * ca, puis affichaient leur toast de succes inconditionnellement.
 *
 * MESURE DU 2026-08-15, en executant le texte livre du fichier, sur /block:
 *     HTTP 200  -> « blocked … dropped before storage, indistinguishable from silence »
 *     HTTP 401  -> « blocked … dropped before storage, indistinguishable from silence »
 *     HTTP 500  -> « blocked … dropped before storage, indistinguishable from silence »
 * Les trois mondes, une seule phrase — et cette phrase est une promesse de PROTECTION affichee alors
 * que rien n'a ete bloque. Le 401 n'a rien d'hypothetique: le noeud repond
 * `401 {error:'operator-only: …'}` hors localhost (server.js), et `claims.cjs` l'asserte deja.
 *
 * ⚖️ CE QUI REND CE DEFAUT INTERESSANT: le fichier SAVAIT lire un refus. `work()` et `send()` testent
 * tous les deux `if(r.error)` avant leur toast. La regle etait ecrite, comprise, appliquee deux fois —
 * et elle n'avait pas traverse jusqu'aux deux ecritures les plus sensibles de la page.
 *
 * ⛔ BORNES. Ce test n'ouvre aucune connexion et ne monte aucun navigateur. Il fait deux choses:
 *   1. il EXECUTE le helper `poste`, extrait VERBATIM du fichier livre, contre chaque forme d'echec;
 *   2. il verifie le CABLAGE des deux boutons par lecture du source — meme convention que
 *      `test/desktop.test.js`, qui verifie de la meme facon que `decideNavigation` est branche sur
 *      ses deux portes. Un cablage vit dans un handler DOM: aucun test hors navigateur ne peut le
 *      lancer, donc on le lit, et on le dit.
 * Il ne juge PAS la formulation des toasts de succes — c'est de la copie produit.
 *
 * Run: node test/write-buttons-report-refusals.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); },
  (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps', 'messenger.js'), 'utf8');

/** Le helper `poste`, extrait VERBATIM. Le stuber reviendrait a tester notre idee du correctif. */
function chargePoste() {
  const i = SRC.indexOf('async function poste(path, payload){');
  assert.ok(i >= 0, 'apps/messenger.js ne porte plus de helper `poste`: les ecritures de la page ne '
    + 'passent plus par un point unique qui sache lire un refus.');
  const j = SRC.indexOf('\n}', i);
  assert.ok(j > i, 'fin de `poste` introuvable — extraction impossible, donc rien n est mesure');
  // eslint-disable-next-line no-new-func
  return new Function('fetch', SRC.slice(i, j + 2) + '\nreturn poste;');
}

/** Une reponse fetch minimale, comme le navigateur la rend: resolue meme sur 401/500. */
const reponse = (statut, corps, jsonCasse) => ({
  ok: statut >= 200 && statut < 300,
  status: statut,
  json: async () => { if (jsonCasse) throw new SyntaxError('Unexpected token < in JSON'); return corps; },
});

/** La ligne du handler d'un bouton, telle qu'elle est livree. */
const handler = (cle) => {
  const i = SRC.indexOf("$('" + cle + "').onclick=");
  assert.ok(i >= 0, 'bouton `' + cle + '` introuvable dans apps/messenger.js — ce test ne mesure plus '
    + 'rien et doit rougir plutot que passer');
  return SRC.slice(i, SRC.indexOf('\n', i));
};

(async () => {
  console.log('LAWBOR — les boutons d ecriture rapportent leurs refus:');

  await t('CONTRE-BORNE — le fichier livre porte bien les deux boutons du consent gate', () => {
    assert.ok(handler('acc').length > 40, 'le handler /accept doit etre lisible');
    assert.ok(handler('blk').length > 40, 'le handler /block doit etre lisible');
  });

  await t('★ `poste` rend une ERREUR sur chaque forme d echec, et le corps sur un succes', async () => {
    const fait = chargePoste();

    const ok = await fait(async () => reponse(200, { ok: true }))('/x', {});
    assert.ok(!ok.error, 'un 200 ne doit pas fabriquer d erreur: ' + JSON.stringify(ok));

    const refus = await fait(async () => reponse(401, { error: 'operator-only: nope' }))('/x', {});
    assert.match(String(refus.error), /operator-only/, 'un 401 doit remonter la raison du noeud');

    const panne = await fait(async () => reponse(500, { error: 'boom' }))('/x', {});
    assert.match(String(panne.error), /boom/, 'un 500 doit remonter une erreur');

    /* Un 500 rend souvent une page HTML: `res.json()` JETTE. Sans ce cas, le helper laisserait
     * echapper une exception depuis un handler DOM — c'est-a-dire un silence complet. */
    const casse = await fait(async () => reponse(500, null, true))('/x', {});
    assert.match(String(casse.error), /HTTP 500/, 'un corps non-JSON doit quand meme donner une erreur, '
      + 'pas une exception: ' + JSON.stringify(casse));

    const coupure = await fait(async () => { throw new TypeError('Failed to fetch'); })('/x', {});
    assert.match(String(coupure.error), /unreachable/, 'une panne reseau doit se dire, pas se taire');
  });

  for (const [cle, route] of [['acc', '/accept'], ['blk', '/block']]) {
    await t('★ le bouton ' + route + ' passe par `poste` ET branche sur une erreur AVANT son succes', () => {
      const h = handler(cle);
      assert.ok(h.indexOf("poste('" + route + "'") >= 0,
        route + ' n est pas poste par le point unique qui sait lire un refus. Un `await fetch(...)` nu '
        + 'ne distingue pas 200 de 401: le toast de succes sortirait dans les deux cas.\n      ' + h);
      const iErr = h.indexOf('r.error');
      const iToast = h.indexOf('toast(');
      assert.ok(iErr >= 0, route + ': aucun test de `r.error` — le refus du noeud est lu puis jete');
      assert.ok(iErr < iToast || h.indexOf('return toast') < h.lastIndexOf('toast('),
        route + ': le succes est annonce sans que l erreur ait ete branchee avant');
    });
  }

  await t('★ le refus de /block DIT que la protection n a PAS eu lieu', () => {
    /* La formulation du succes est de la copie produit et ce test n y touche pas. Mais le message
     * d ECHEC porte une information de securite: sans elle, l utilisateur repart en croyant que le
     * pair est bloque. C est la seule phrase de cette page dont la faussete a une consequence. */
    const h = handler('blk');
    assert.match(h, /NOT blocked/, 'le refus doit nier explicitement le blocage:\n      ' + h);
    assert.match(h, /NOT protected/, 'le refus doit dire que l utilisateur n est PAS protege — sinon '
      + 'il lit une erreur technique et garde la conclusion inverse:\n      ' + h);
  });

  await t('⚖️ TEMOIN — work() et send() gardent leur propre lecture du refus', () => {
    /* Ces deux-la etaient DEJA corrects: ils lisent des champs de la reponse (delivered, sign,
     * reason), donc ils ne passent pas par `poste`. Le correctif ne devait pas les toucher, et ce
     * temoin le pinne — sinon une refactorisation future les alignerait en leur faisant perdre ces
     * champs, et le toast de /say cesserait de distinguer relaye de NON delivre. */
    assert.match(SRC, /if\(r\.error\) return toast\('refused: '/, 'send() garde sa lecture du refus');
    assert.match(SRC, /if\(r\.error\) return toast\('refused by the actor rules: '/, 'work() garde la sienne');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
