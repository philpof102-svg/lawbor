#!/usr/bin/env node
'use strict';
/**
 * `/who` — la page qui ne doit JAMAIS rendre une quantite gratuite.
 *
 * POURQUOI CE FICHIER EXISTE. `apps/who.js` porte, en tete, la regle la plus load-bearing du produit:
 *
 *   🛑 « nothing free is ever rendered as a quantity. Not a message count, not a conversation count,
 *      not a job count, not "member since", not a bid total. Every one of those is inflatable at zero
 *      cost, and A FREE NUMBER PLACED NEXT TO VERIFIED ONES IS READ AS VERIFIED — by a human skimming,
 *      and much more reliably by the LLM that is the actual consumer of this page. »
 *
 * C'est l'anti-farming, c'est-a-dire ce que ce depot vend. Mesure du 2026-08-15: `renderWho` est
 * EXPORTE, appele par `server.js` sur une route servie — et AUCUN fichier de `test/` ne le mentionne.
 * Une regle nommee, falsifiable, sur une fonction pure, sans une seule assertion.
 *
 * ⛔ LE CONTROLE QUI PORTE LE PLUS n'est pas « la page ne contient pas de compteur aujourd hui »: c'est
 * qu'on LUI EN DONNE et qu'elle les IGNORE. Un appelant qui passe `messageCount` un jour ne doit pas
 * pouvoir les faire apparaitre. Verifier la sortie sur une entree qui n'en contient pas ne prouverait
 * que la pauvrete de l'entree.
 *
 * Les trois autres choses que l'en-tete exige « in words, not left to inference » sont assertees aussi:
 *   1. la vue vient d'UN nœud, et deux nœuds differeront ;
 *   2. un 0 est une ABSENCE, jamais une mauvaise note — sinon le demarrage a froid se lit comme un verdict ;
 *   3. `settled` veut dire PAYE — jamais livre, jamais « le travail etait bon ».
 *
 * ⛔ BORNES. Il teste la fonction PURE, pas la route: ce que `server.js` lui passe n'est pas verifie ici.
 * Et il lit le HTML rendu — il etablit ce qui est ECRIT dans la page, pas ce qu'un navigateur en fait.
 */
const assert = require('node:assert');
const { renderWho } = require('../apps/who');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const ADR = '0x' + '1'.repeat(40);
const base = { viewer: '0x' + '2'.repeat(40), of: ADR, directMicro: 0, inboundMicro: 0, circleMicro: 0 };

/* ── TEMOIN: la fonction rend bien une page, sinon tout ce qui suit est vide de sens. ───────────── */
const froid = renderWho(base);
ok(typeof froid === 'string' && froid.length > 800, 'TEMOIN: renderWho rend une page (' + froid.length + ' octets)');
ok(froid.includes(ADR), 'TEMOIN: l adresse demandee apparait bien dans la page');

/* ── 1. LE CONTROLE CENTRAL: on DONNE des quantites gratuites, elles ne doivent pas ressortir. ─── */
const avecGratuit = renderWho({
  ...base,
  messageCount: 4242, conversations: 777, jobs: 555, memberSince: '2019',
  bidTotal: 8888, followers: 6161, reputationScore: 93,
});
for (const [nom, valeur] of [['messageCount', '4242'], ['conversations', '777'], ['jobs', '555'],
  ['memberSince', '2019'], ['bidTotal', '8888'], ['followers', '6161'], ['reputationScore', '93']]) {
  ok(!avecGratuit.includes(valeur),
    'Une quantite GRATUITE passee en entree (' + nom + '=' + valeur + ') ne doit pas atteindre la page.'
    + ' Verifier la sortie sur une entree qui n en contient pas ne prouverait que la pauvrete de l entree.');
}
ok(avecGratuit.length === froid.length,
  'CAS OPPOSE STRICT: la page est OCTET POUR OCTET la meme avec et sans ces champs — la fonction ne les'
  + ' lit pas du tout, elle ne se contente pas de ne pas les afficher');

/* ── 2. LA PREUVE DE CLE EST UN BOOLEEN, JAMAIS UN SCORE. ──────────────────────────────────────── */
const prouve = renderWho({ ...base, keyProven: true });
const nonProuve = renderWho({ ...base, keyProven: false });
ok(prouve !== nonProuve, 'TEMOIN: les deux etats de keyProven donnent des pages DIFFERENTES');
ok(/>proven</.test(prouve) && /not proven here/.test(nonProuve),
  'keyProven se rend en MOTS (« proven » / « not proven here »), pas en chiffre');
ok(/never<\/strong> worth reputation|never.{0,20}worth reputation/.test(prouve),
  'Et la page DIT que la preuve, etant gratuite, ne vaut jamais de reputation — la regle, ecrite la ou'
  + ' un lecteur la rencontre');
ok(/absence, not a red flag/.test(nonProuve),
  'CAS OPPOSE: une preuve absente est une ABSENCE, pas un drapeau rouge');

/* ── 3. UN 0 EST UNE ABSENCE — le demarrage a froid ne doit pas se lire comme un verdict. ──────── */
ok(/NO HISTORY WITH US/.test(froid) && /not a bad mark/.test(froid),
  'Tout a zero: la page dit que c est une ABSENCE d historique, pas une mauvaise note');
const avecHistoire = renderWho({ ...base, directMicro: 5_000_000 });
ok(!/NO HISTORY WITH US/.test(avecHistoire),
  'CAS OPPOSE: des qu il y a de l historique, la note de demarrage a froid DISPARAIT — sinon elle serait'
  + ' un decor plutot qu une mesure');

/* ── 4. `settled` VEUT DIRE PAYE, et la page le dit dans les DEUX cas. ─────────────────────────── */
for (const [nom, page] of [['froid', froid], ['avec historique', avecHistoire]]) {
  ok(/settled means PAID/.test(page),
    nom + ': la page dit que « settled » veut dire PAYE — jamais livre, jamais que le travail etait bon');
}

/* ── 5. LA VUE VIENT D UN SEUL NŒUD, dit en mots. ──────────────────────────────────────────────── */
ok(/this node only/.test(froid) && /different numbers for the same address/.test(froid),
  'La page dit qu elle est la vue d UN nœud et que deux nœuds differeront — par conception');

/* ── 6. UN POINTEUR OPAQUE EST LABELLISE NON VERIFIE. ──────────────────────────────────────────── */
const avecPointeur = renderWho({ ...base, directMicro: 1_000_000,
  evidence: [{ txHash: '0x' + 'a'.repeat(64), amountMicro: 1_000_000, deliverable: 'ipfs://quelquechose' }] });
ok(/unchecked pointer/.test(avecPointeur),
  'Un `deliverable` qui RIDE ON un paiement verifie est montre, mais etiquete « unchecked pointer »');
ok(/basescan\.org\/tx\//.test(avecPointeur),
  'Et le reglement reste re-verifiable sans nous faire confiance (lien vers l explorateur)');

/* ── 7. L ADRESSE VIENT DE L URL: elle doit etre ECHAPPEE. ─────────────────────────────────────── */
const hostile = renderWho({ ...base, of: '<script>alert(1)</script>', viewer: '"><img src=x onerror=1>' });
ok(!/<script>alert/.test(hostile) && !/onerror=1/.test(hostile),
  'L adresse et le viewer viennent d un parametre d URL: ils sont echappes, jamais injectes tels quels');
ok(/&lt;script&gt;/.test(hostile), 'TEMOIN: l echappement a bien eu lieu (et non: la chaine a disparu)');

/* ── DETECTION POWER: une page qui afficherait un compteur serait-elle vue ? ───────────────────── */
const FAUX = froid.replace('<h2>Key control</h2>', '<h2>Key control</h2><div class="n">4242 messages</div>');
ok(FAUX.includes('4242'), 'DETECTION POWER: le controle 1 verrait bien un compteur injecte dans la page');

console.log('  ' + n + ' passed, 0 failed');
console.log('  ⛔ Teste la fonction PURE, pas la route: ce que server.js lui passe n est pas verifie ici.');
