'use strict';
/**
 * « REGISTER A ECHOUE » SE LISAIT « DEJA ENREGISTRE », ET LA DIFFERENCE EST LE COMPTEUR DE PUSHES.
 * ==================================================================================================
 * `tools/publish-gitlawb.sh` est un chemin de PUBLICATION: le standing gitlawb est un compteur de
 * pushes et le paiement en depend. Son etape 3 traitait tout echec non-captcha de `gl register`
 * comme « often = already registered — continuing ».
 *
 * MESURE DU 2026-08-16, gl STUBBE (aucun reseau, aucun vrai gl): un ECONNREFUSED sur register
 * traversait la branche, `gl mirror` etait appele, et le script finissait sur la MEME ligne
 * « ✅ … standing preserved » qu'une vraie republication. Un noeud en panne, un 500, un DNS casse,
 * un GITLAWB_NODE mal tape — tous se lisaient comme un succes, dans le script meme dont l'en-tete
 * precedent dit « refusing costs a re-run; guessing costs the account ».
 *
 * LE CONTRAT DESORMAIS TESTE: le noeud qui DIT « already » continue; l'inconnu STOPPE (exit 4) AVANT
 * le mirror en montrant la sortie; l'operateur qui sait passe GITLAWB_ASSUME_REGISTERED=1; le
 * captcha reste exit 2. Chaque cas s'observe sur DEUX canaux — le code de sortie ET le journal des
 * appels du stub (mirror appele ou pas) — parce qu'un exit code seul ne dit pas si la publication
 * est partie.
 *
 * ⚖️ BORNES: ce test ne prouve rien sur le VRAI gl (ses messages exacts peuvent differer — le choix
 * fail-closed est precisement la pour l'inconnu); il exige `bash` sur la machine de test (Git Bash
 * sous Windows, natif ailleurs) et ECHOUE FORT s'il manque — le chemin de publication est en bash,
 * une machine qui ne peut pas le tester ne peut pas pretendre a la suite verte.
 *
 * Run: node test/publish-gitlawb-register-gate.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const t = (nom, fn) => { try { fn(); pass++; console.log('  ✓ ' + nom); } catch (e) { fail++; console.log('  ✗ ' + nom + '\n      ' + (e && e.message)); } };

const SCRIPT = path.join(__dirname, '..', 'tools', 'publish-gitlawb.sh');
const ATELIER = fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-publish-gate-'));
const BIN = path.join(ATELIER, 'bin');
fs.mkdirSync(BIN);
const LOG = path.join(ATELIER, 'calls.log');

/* Le stub est ECRIT PAR LE TEST — auto-contenu, rien a installer. Il journalise chaque appel et joue
 * le scenario dicte par STUB_MODE. Les fins de ligne sont LF: bash refuse un shebang en CRLF. */
const poser = (nom, corps) => {
  const p = path.join(BIN, nom);
  fs.writeFileSync(p, corps.split('\r\n').join('\n'));
  fs.chmodSync(p, 0o755);
};
poser('gl', [
  '#!/usr/bin/env bash',
  'echo "gl $*" >> "$STUB_LOG"',
  'case "$1" in',
  '  --version) echo "gl 0.0-stub"; exit 0 ;;',
  '  identity) echo "did:gitlawb:stubkey123456"; exit 0 ;;',
  '  register)',
  '    case "$STUB_MODE" in',
  '      down) echo "error: connect ECONNREFUSED node.gitlawb.com:443" >&2; exit 1 ;;',
  '      already) echo "identity already registered with this node"; exit 1 ;;',
  '      captcha) echo "proof required: solve the iCaptcha at https://x" >&2; exit 1 ;;',
  '      *) exit 0 ;;',
  '    esac ;;',
  '  mirror) echo "MIRROR-CALLED" >> "$STUB_LOG"; exit 0 ;;',
  'esac',
  'exit 0',
].join('\n'));
poser('npm', '#!/usr/bin/env bash\nif [ "$1" = "config" ]; then echo "/nonexistent-npm-prefix"; exit 0; fi\nexit 0');
poser('git-remote-gitlawb', '#!/usr/bin/env bash\nexit 0');

/* ⛔ « bash EXISTE » N'EST PAS « bash VOIT CE CHEMIN », ET J'AI ECRIT LA MAUVAISE SONDE.
 * La version precedente faisait `spawnSync('bash', ['--version'])` et concluait. Mesure du
 * 2026-08-17: sur cette machine `bash` resout desormais vers `C:\Windows\system32\bash.exe`
 * — WSL — qui monte `D:` en `/mnt/d` et ne peut donc PAS lire `D:\...\publish-gitlawb.sh`.
 * Git Bash a quitte le PATH. La sonde de PRESENCE passait, et le lancement echouait ensuite sur
 * « /bin/bash: D:/...: No such file or directory » — un rouge qui accuse le code alors que la cause
 * est l'environnement. Un rouge qui ment entraine a ignorer le rouge.
 *
 * On sonde donc la CAPACITE, pas la presence: est-ce que CE bash voit CE fichier ? Sinon on traduit
 * vers la forme WSL et on re-sonde. Si aucune des deux ne marche, on echoue en NOMMANT la cause
 * mesuree — jamais un skip, qui serait un succes vide. */
/* ⛔ CE TEST A BESOIN DE DEUX CAPACITES, ET « bash --version REPOND » N'EN PROUVE AUCUNE.
 * Mesure du 2026-08-17: `bash` resolvait vers `C:\Windows\system32\bash.exe` — WSL — et le test
 * echouait sur « /bin/bash: D:/...: No such file or directory ». Un rouge qui accuse le code alors
 * que la cause est l'environnement, et un rouge qui ment entraine a ignorer le rouge.
 *
 * Les DEUX capacites requises, mesurees separement:
 *   1. VOIR le script (WSL monte D: en /mnt/d, donc il ne lit pas un chemin `D:\...`);
 *   2. PORTER l'environnement — WSL n'herite d'AUCUNE variable Windows sans WSLENV, donc
 *      STUB_MODE / STUB_LOG / le PATH des stubs n'arrivent jamais. Mesure: avec un bash WSL les
 *      CINQ cas tombaient identiquement en exit 4, le stub `gl` etant simplement introuvable.
 *
 * On choisit donc le bash par CAPACITE, pas par nom: celui du PATH s'il porte le contrat, sinon
 * celui livre avec git (deterministe — a cote de `git.exe`, present des que git l'est). Aucun des
 * deux ⇒ echec qui NOMME les deux mesures. Jamais un skip: un test qui se saute est un succes vide.
 *
 * ⚠️ Le piege de frontiere dans la sonde elle-meme: ecrite d'abord en POSITIONNEL
 * (`bash -c 'test -e "$1"' _ <chemin>`) elle rendait status 1 sur un fichier que WSL voit en 777 —
 * les arguments places APRES `-c` ne survivent pas au reassemblage de la ligne de commande. La forme
 * INLINE passe. ⚖️ Borne: guillemets simples, nos chemins n'en contiennent pas. */
const voitLeScript = (b) => spawnSync(b, ['-c', "test -e '" + SCRIPT + "'"], { encoding: 'utf8' }).status === 0;
const porteLEnv = (b) => {
  const r = spawnSync(b, ['-c', 'echo "$LAWBOR_SONDE_ENV"'],
    { encoding: 'utf8', env: { ...process.env, LAWBOR_SONDE_ENV: 'porte' } });
  return r.status === 0 && String(r.stdout).trim() === 'porte';
};

const candidats = ['bash'];
const ougit = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' });
if (ougit.status === 0) {
  const gitExe = String(ougit.stdout).split(/\r?\n/).filter(Boolean)[0];
  if (gitExe) {
    const racine = path.dirname(path.dirname(gitExe));            // <git>/cmd/git.exe -> <git>
    for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) candidats.push(path.join(racine, ...rel));
  }
}
const BASH = candidats.find((b) => voitLeScript(b) && porteLEnv(b));
assert.ok(BASH, 'aucun bash de cette machine ne porte le contrat de ce test. Candidats essayes: '
  + candidats.join(' · ') + '. Chacun doit (1) VOIR ' + SCRIPT + ' et (2) HERITER des variables '
  + 'passees par le lanceur. Un bash WSL echoue sur les deux. Ce n est PAS un defaut du code teste — '
  + 'installer/exposer Git Bash rend ce test executable.');

function lancer(mode, envSup = {}) {
  fs.writeFileSync(LOG, '');
  const r = spawnSync(BASH, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: BIN + path.delimiter + process.env.PATH, STUB_MODE: mode, STUB_LOG: LOG, ...envSup },
  });
  const appels = fs.readFileSync(LOG, 'utf8');
  return { code: r.status, sortie: String(r.stdout) + String(r.stderr),
    mirrorAppele: appels.split('\n').filter((l) => l === 'MIRROR-CALLED').length };
}

console.log('publish-gitlawb — un echec de register inconnu ne doit JAMAIS atteindre le mirror:');

t('★ noeud INJOIGNABLE: exit 4, ZERO mirror, et le refus montre le choix a faire', () => {
  const r = lancer('down');
  assert.strictEqual(r.code, 4, 'exit attendu 4, obtenu ' + r.code);
  assert.strictEqual(r.mirrorAppele, 0, 'le mirror ne doit PAS etre appele');
  assert.ok(/does not say "already registered"/.test(r.sortie), 'le refus nomme sa raison');
  assert.ok(/GITLAWB_ASSUME_REGISTERED=1/.test(r.sortie), 'et la porte de sortie operateur');
});

t('TEMOIN: le noeud qui DIT « already » continue jusqu au mirror', () => {
  const r = lancer('already');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.mirrorAppele, 1);
  assert.ok(/already registered — continuing/.test(r.sortie));
});

t('TEMOIN: un register qui REUSSIT continue aussi', () => {
  const r = lancer('ok');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.mirrorAppele, 1);
});

t('le captcha reste un arret PROPRE (exit 2), jamais un mirror', () => {
  const r = lancer('captcha');
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.mirrorAppele, 0);
});

t('l override operateur est HONORE et DIT — continuer malgre l inconnu est un choix, pas un defaut', () => {
  const r = lancer('down', { GITLAWB_ASSUME_REGISTERED: '1' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.mirrorAppele, 1);
  assert.ok(/operator override/.test(r.sortie), 'la sortie doit dire que c est un override');
});

try { fs.rmSync(ATELIER, { recursive: true, force: true }); } catch (e) { /* laisse le tmp */ }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
