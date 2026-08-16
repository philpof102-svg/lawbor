'use strict';
/**
 * UN APPEND FAIT PENDANT UNE COMPACTION ETAIT SILENCIEUSEMENT ECRASE PAR LE RENAME.
 * ==================================================================================================
 * `compact()` fait: readLog(file) -> fold/retention -> writeFileSync(tmp) -> renameSync(tmp, file).
 * Tout ce qu'un AUTRE processus appende entre la LECTURE et le RENAME atterrit dans le fichier que le
 * rename remplace. `record()` a rendu sa ligne, sans erreur: l'appelant croit son message stocke.
 *
 * MESURE DU 2026-08-16, deux PROCESSUS sur le meme store (un ecrivain a une ligne toutes les 2 ms):
 *     log de     60 lignes (compaction < 1 ms)  ->   0 perdu sur 60
 *     log de 40 000 lignes (compaction 269 ms)  ->  49 PERDUS sur 60   (82 %)
 *
 * ⚠️ LE PREMIER CHIFFRE EST LA LECON, ET IL EST DANS CE TEST. Un zero obtenu sur un log minuscule ne
 * dit pas que la course n'existe pas: il dit qu'on ne l'a pas ATTEINTE. La fenetre est proportionnelle
 * a la TAILLE du log, donc elle s'ouvre exactement quand le noeud devient occupe. Ce fichier
 * PRE-REMPLIT donc le log, et il VERIFIE d'abord que la compaction y dure assez longtemps pour que la
 * course soit atteignable — sans ce controle, un « 0 perdu » ne prouverait rien.
 *
 * ⚖️ QUAND C'EST VIVANT: pas par defaut (retention a 0), mais des qu'un operateur active
 * LAWBOR_MAX_MESSAGES / LAWBOR_MAX_AGE_DAYS, et a CHAQUE scrub (node.js compacte apres suppression).
 * Le second processus est celui que desktop/lib/config.cjs decrit explicitement.
 *
 * ⚖️ CE QUI EST TESTE ICI est la PROPRIETE, pas le mecanisme: aucun message accepte par record() ne
 * doit manquer du disque. Le correctif choisi (detecter la course et RENONCER) la tient; un verrou la
 * tiendrait aussi. Le test ne fige donc pas la solution, seulement ce qui ne doit jamais arriver.
 *
 * Run: node test/store-concurrent-compaction.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createStore } = require('../lib/store');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); },
  (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const LIGNES = 12000;          // assez pour que la compaction dure bien plus qu'un intervalle d'ecriture
const N = 40;                  // messages appendus pendant la course
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const atelier = fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-conc-'));

/* Les deux enfants sont ecrits ici: le test reste auto-contenu et ne depend d'aucun fichier externe. */
const STORE = JSON.stringify(path.join(__dirname, '..', 'lib', 'store.js'));
fs.writeFileSync(path.join(atelier, 'ecrivain.js'),
  "const { createStore } = require(" + STORE + ");\n"
  + "const s = createStore(process.argv[2], process.argv[2] + '.control', {});\n"
  + "(async () => { for (let i = 0; i < " + N + "; i++) {\n"
  + "  s.record({ id: 'W-' + i, thread: 'TW', from: '" + A + "', to: '" + B + "', body: 'm', ts: Date.now() },\n"
  + "    { origin: 'human', dir: 'in' });\n"
  + "  await new Promise((r) => setTimeout(r, 2)); } })();\n");
fs.writeFileSync(path.join(atelier, 'compacteur.js'),
  "const { createStore } = require(" + STORE + ");\n"
  + "const s = createStore(process.argv[2], process.argv[2] + '.control', {});\n"
  + "(async () => { for (let i = 0; i < 8; i++) { s.compact(); await new Promise((r) => setTimeout(r, 5)); } })();\n");

const lance = (script, f) => new Promise((res) => {
  const p = spawn(process.execPath, [path.join(atelier, script), f]);
  p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
  p.on('close', res);
});
const presents = (f) => {
  if (!fs.existsSync(f)) return 0;
  let n = 0;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue;
    try { if (String(JSON.parse(l).id || '').startsWith('W-')) n++; } catch (e) { /* ligne dechiree */ }
  }
  return n;
};
const remplir = (f) => {
  let bloc = '';
  for (let i = 0; i < LIGNES; i++) {
    bloc += JSON.stringify({ id: 'SEED-' + i, thread: 'T' + (i % 200), from: A, to: B,
      body: 'x'.repeat(40), ts: 1, origin: 'human', dir: 'in', rxAt: 1 }) + '\n';
    if (bloc.length > 500000) { fs.appendFileSync(f, bloc); bloc = ''; }
  }
  fs.appendFileSync(f, bloc);
};

(async () => {
  console.log('LAWBOR store — un append pendant une compaction ne disparait pas:');

  let dureeCompaction = 0;
  await t('CONTRE-BORNE — la compaction dure assez pour que la course soit ATTEIGNABLE', () => {
    const f = path.join(atelier, 'mesure.jsonl');
    remplir(f);
    const s = createStore(f, f + '.control', {});
    const t0 = Date.now(); s.compact(); dureeCompaction = Date.now() - t0;
    assert.ok(dureeCompaction >= 20,
      'une compaction ne dure que ' + dureeCompaction + ' ms sur ' + LIGNES + ' lignes: la fenetre '
      + 'readLog->rename est trop etroite pour qu un ecrivain a 2 ms la touche, et un « 0 perdu » ne '
      + 'prouverait alors RIEN. Augmenter LIGNES.');
  });

  await t('⚖️ TEMOIN — un ecrivain SEUL conserve tout (une perte viendrait alors de lui, pas de la course)', async () => {
    const f = path.join(atelier, 'temoin.jsonl');
    await lance('ecrivain.js', f);
    assert.strictEqual(presents(f), N, 'l ecrivain seul doit conserver ses ' + N + ' messages');
  });

  await t('★ AUCUN message accepte par record() ne disparait pendant une compaction concurrente', async () => {
    const f = path.join(atelier, 'course.jsonl');
    remplir(f);
    await Promise.all([lance('ecrivain.js', f), lance('compacteur.js', f)]);
    const restants = presents(f);
    assert.strictEqual(restants, N,
      (N - restants) + ' message(s) sur ' + N + ' ont disparu du disque alors que record() les avait '
      + 'ACCEPTES sans erreur (compaction mesuree a ' + dureeCompaction + ' ms sur ' + LIGNES + ' lignes). '
      + 'Un append tombe entre readLog et renameSync est ecrase par le rename.');
  });

  await t('★ une compaction qui renonce le DIT, et laisse le log intact', async () => {
    /* La valeur de retour est la seule chose qui sache que l incident a eu lieu — ce module ecrit
     * lui-meme « A caller that discards that value discards the incident ». */
    const f = path.join(atelier, 'dit.jsonl');
    remplir(f);
    const avant = fs.statSync(f).size;
    const enfant = lance('ecrivain.js', f);
    const s = createStore(f, f + '.control', {});
    let vus = [];
    for (let i = 0; i < 8; i++) { vus.push(s.compact()); await new Promise((r) => setTimeout(r, 5)); }
    await enfant;
    const races = vus.filter((r) => r && r.state === 'raced');
    assert.ok(races.length > 0,
      'aucune des 8 compactions n a signale de course alors qu un ecrivain tournait en parallele — '
      + 'soit la course n a pas eu lieu (fenetre trop etroite), soit elle est passee inapercue');
    assert.match(String(races[0].detail), /ANOTHER PROCESS|another process|Compaction ABORTED/,
      'le refus doit nommer la cause: ' + races[0].detail);
    assert.ok(fs.statSync(f).size >= avant, 'un refus ne doit RIEN retirer du log');
  });

  try { fs.rmSync(atelier, { recursive: true, force: true }); } catch (e) { /* laisse le tmp */ }
  console.log('\n' + pass + ' passed · ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
