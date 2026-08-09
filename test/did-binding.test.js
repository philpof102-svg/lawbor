#!/usr/bin/env node
'use strict';
/**
 * did-binding: le maillon où une porte s'ouvre en grand si on se trompe.
 *
 * Le standing gitlawb est attaché à un DID. Si n'importe qui peut prétendre « mon adresse = ce DID »,
 * alors n'importe qui EMPRUNTE la réputation d'un agent établi — et l'admission le laisse entrer avec.
 * Les cas ci-dessous verrouillent donc surtout les REFUS, et un en particulier:
 *
 *   ⛔ SANS VÉRIFICATEUR DE SIGNATURE, `bound` DOIT VALOIR FAUX. Une attestation structurellement
 *   impeccable dont personne n'a validé les signatures est une PRÉTENTION. C'est le défaut le plus
 *   facile à introduire (« la structure est bonne, ça suffit ») et le plus coûteux.
 *
 * ⚠️ Et le TÉMOIN: avec un vrai vérificateur qui dit oui, `bound` doit valoir VRAI. Sans ce cas, un
 * module qui refuserait TOUT passerait tous les autres tests en étant inutile.
 */
const assert = require('node:assert');
const { messageDeLiaison, jugerLiaison, makeLireLiaison } = require('../lib/did-binding');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('did-binding: une pretention n est pas une liaison');

const DID = 'did:key:z6Mkicjkc95VcFx38Xg2SvFV2ENsu3dLDoWborjPGVodHXoH';
const ADR = '0x' + 'a'.repeat(40);
const OK = { did: DID, address: ADR, nonce: 'n-1', chainId: 8453, expiry: 0, sigDid: 'x', sigBase: 'y' };
const ouiVerif = () => true;

/* ── 1. LE REFUS QUI PROTÈGE TOUT LE RESTE ────────────────────────────────────────────────────────── */

t('★ SANS verificateur: structure parfaite, mais bound FAUX et la raison le dit', async () => {
  const r = await jugerLiaison(OK, { now: 1 });
  assert.strictEqual(r.bound, false, 'une structure conforme ne prouve RIEN');
  assert.ok(/pretention, pas une liaison/.test(r.raison), r.raison);
  /* Le DID et le message restent rendus: on refuse en INFORMANT, pas en effacant. */
  assert.strictEqual(r.did, DID);
  assert.ok(typeof r.message === 'string' && r.message.length > 40);
});

t('★ TEMOIN — avec un verificateur qui dit oui, bound vaut VRAI', async () => {
  const r = await jugerLiaison(OK, { now: 1, verifier: ouiVerif });
  assert.strictEqual(r.bound, true, 'sans ce cas, un module qui refuse TOUT passerait tous les autres');
  assert.strictEqual(r.did, DID);
});

t('★ signatures invalides et verificateur EN PANNE ne se lisent pas pareil', async () => {
  const invalide = await jugerLiaison(OK, { now: 1, verifier: () => false });
  const panne = await jugerLiaison(OK, { now: 1, verifier: () => { throw new Error('libsecp absente'); } });
  assert.strictEqual(invalide.bound, false);
  assert.strictEqual(panne.bound, false);
  assert.ok(/INVALIDES/.test(invalide.raison), invalide.raison);
  assert.ok(/on n a pas pu verifier/.test(panne.raison),
    'une panne de crypto lue comme « signature invalide » accuserait a tort: ' + panne.raison);
});

/* ── 2. LES STRUCTURES QUI NE PASSENT PAS ─────────────────────────────────────────────────────────── */

t('★ sans NONCE: refus — une attestation signee une fois se rejouerait indefiniment', async () => {
  const r = await jugerLiaison({ ...OK, nonce: '' }, { now: 1, verifier: ouiVerif });
  assert.strictEqual(r.bound, false);
  assert.ok(/rejouable/.test(r.raison), r.raison);
});

t('DID ou adresse mal formes: refus, meme avec un verificateur complaisant', async () => {
  for (const bad of [{ did: 'pas-un-did' }, { did: '' }, { address: '0xzz' }, { address: 'coucou' }]) {
    const r = await jugerLiaison({ ...OK, ...bad }, { now: 1, verifier: ouiVerif });
    assert.strictEqual(r.bound, false, JSON.stringify(bad));
  }
});

t('aucune attestation du tout: refus qui le DIT', async () => {
  for (const v of [null, undefined, 'texte', 42]) {
    const r = await jugerLiaison(v, { now: 1, verifier: ouiVerif });
    assert.strictEqual(r.bound, false);
    assert.ok(/aucune attestation/.test(r.raison));
  }
});

/* ── 3. L'EXPIRATION EST UNE VRAIE VÉRIFICATION ───────────────────────────────────────────────────── */

t('★ une attestation EXPIREE est refusee MEME signee', async () => {
  const r = await jugerLiaison({ ...OK, expiry: 1000 }, { now: 1001, verifier: ouiVerif });
  assert.strictEqual(r.bound, false, 'sinon une cle compromise un jour donne un acces permanent');
  assert.ok(/EXPIREE/.test(r.raison), r.raison);
});

t('★ le cas OPPOSE: la meme attestation AVANT son expiration passe', async () => {
  const r = await jugerLiaison({ ...OK, expiry: 1000 }, { now: 999, verifier: ouiVerif });
  assert.strictEqual(r.bound, true, 'temoin: sinon `expiry` refuserait tout le monde et le test ci-dessus');
});

t('★ « pas d expiration » est un cas DISTINCT, signale et non silencieux', async () => {
  const r = await jugerLiaison({ ...OK, expiry: 0 }, { now: 1, verifier: ouiVerif });
  assert.strictEqual(r.bound, true, 'on ne l interdit pas...');
  assert.ok(/SANS DATE D EXPIRATION/.test(r.raison), '...mais l operateur doit le VOIR: ' + r.raison);
});

/* ── 4. LE MESSAGE CANONIQUE EST UN CONTRAT ───────────────────────────────────────────────────────── */

t('★ le message est STABLE et discrimine — un tiers doit le reconstruire a l identique', async () => {
  const a = messageDeLiaison({ did: DID, address: ADR, nonce: 'n-1' });
  assert.strictEqual(a, messageDeLiaison({ did: DID, address: ADR, nonce: 'n-1' }), 'doit etre deterministe');
  /* Changer n IMPORTE QUEL champ doit changer le message, sinon deux liaisons distinctes partageraient
   * une signature — et l une se rejouerait sur l autre. */
  for (const diff of [{ did: 'did:key:zAUTRE' }, { address: '0x' + 'b'.repeat(40) }, { nonce: 'n-2' },
    { chainId: 1 }, { expiry: 99 }]) {
    assert.notStrictEqual(messageDeLiaison({ did: DID, address: ADR, nonce: 'n-1', ...diff }), a,
      'champ non discriminant: ' + JSON.stringify(diff));
  }
});

t("l adresse est normalisee en minuscules — sinon la casse changerait le message a signer", async () => {
  const bas = messageDeLiaison({ did: DID, address: ADR, nonce: 'n' });
  const haut = messageDeLiaison({ did: DID, address: ADR.toUpperCase().replace('0X', '0x'), nonce: 'n' });
  assert.strictEqual(bas, haut, 'deux ecritures de la MEME adresse doivent donner le MEME message');
});

/* ── 5. LE CÂBLAGE ────────────────────────────────────────────────────────────────────────────────── */

t('★ makeLireLiaison rend la forme que le preflight consomme', async () => {
  const lire = makeLireLiaison({ magasin: async () => OK, verifier: ouiVerif, horloge: () => 1 });
  const r = await lire(ADR);
  /* La ligne exacte de admission-gitlawb.js: `binding.bound !== true` refuse. */
  assert.strictEqual(r.bound, true);
  assert.strictEqual(r.did, DID);
});

/* ⛔ CE CAS EXISTE PARCE QUE LA COMPOSITION L'A REVELE, pas la relecture du code.
 * `admission-gitlawb.js` distingue NO-BINDING (rien de depose) de UNVERIFIED-CLAIM (quelque chose de
 * depose, non prouve) — et les deux n'appellent pas la meme reaction: le second peut etre une
 * tentative. La premiere version de `makeLireLiaison` rendait l'objet raisonne de `jugerLiaison(null)`
 * dans les deux cas, ce qui les ECRASAIT en UNVERIFIED-CLAIM et effacait le signal d'abus. */
t('★ magasin VIDE rend null — sinon « rien depose » et « pretention » se confondent en aval', async () => {
  const { planAdmission } = require('../lib/admission-gitlawb');
  const vide = makeLireLiaison({ magasin: async () => null, verifier: ouiVerif });
  assert.strictEqual(await vide(ADR), null, 'null est ce que le module d admission attend pour NO-BINDING');
  assert.strictEqual(planAdmission({ binding: await vide(ADR), trust: 0.9, minScore: 40 }).decision, 'NO-BINDING');

  const present = makeLireLiaison({ magasin: async () => OK, verifier: () => false, horloge: () => 1 });
  const b = await present(ADR);
  assert.notStrictEqual(b, null, 'une attestation PRESENTE mais fausse doit rester visible');
  assert.strictEqual(planAdmission({ binding: b, trust: 0.9, minScore: 40 }).decision, 'UNVERIFIED-CLAIM');
});

t('★ une panne du MAGASIN remonte — elle ne devient jamais « pas de liaison »', async () => {
  const lire = makeLireLiaison({ magasin: async () => { throw new Error('magasin hors service'); } });
  await assert.rejects(() => lire(ADR), /hors service/,
    'rendre bound:false sur une panne condamnerait un agent legitime en silence');
});

t('sans magasin, le module REFUSE de se construire', async () => {
  assert.throws(() => makeLireLiaison({}), /magasin.*requis/i);
});

const ATTENDUS = 15;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
