'use strict';
/**
 * gitlawb-identity-is-not-minted-by-accident — "no identity HERE" is not "no identity".
 * ==================================================================================================
 * tools/publish-gitlawb.sh is the only file in tools/, and until 2026-08-15 nothing tested it.
 * It decides, on its own, which DID this project publishes under. Its guard was:
 *
 *     if gl identity show >/dev/null 2>&1; then reuse; else gl identity new; fi
 *
 * MEASURED against the real gl CLI (WSL, 2026-08-15) — this is the contract the stub below copies:
 *   · identity present            -> exit 0, prints a did:key:… (56 chars)
 *   · GITLAWB_NODE unreachable    -> STILL exit 0. It reads the disk; the network never decides.
 *   · $HOME/.gitlawb/identity.pem out of reach -> exit 1, "no identity found at <path>"
 * So the guard is sound about what it READS. The defect was what the script DID with the "no":
 * it minted a fresh DID and ran all the way to the mirror, and BOTH paths ended on the identical
 * line "✅ LAWBOR mirrored to gitlawb". The success message could not tell "republished under our
 * account" from "published as somebody else" — and gitlawb standing is a PUSH COUNTER, so a fresh
 * DID restarts it at zero while the old profile keeps the history.
 *
 * PROPERTY, in three OPPOSITE cases — a guard that only ever refuses is not a guard:
 *   1. identity present            -> proceeds, and SAYS it reused one
 *   2. no identity, no opt-in      -> refuses, mints NOTHING, mirrors NOTHING
 *   3. no identity, GITLAWB_NEW_IDENTITY=1 -> proceeds, and SAYS the DID is brand new
 *
 * HOW IT RUNS THE REAL SCRIPT WITHOUT TOUCHING ANYTHING REAL: a driver defines `gl` and `npm` as
 * bash FUNCTIONS and `export -f`s them, so the script inherits them instead of the real binaries.
 * No PATH doctoring, no chmod, no ':' vs ';' — the two things that make such a harness rot. The
 * stub npm REFUSES to install, so a regression that reintroduces `npm i -g` shows up as a failure
 * rather than as a silent global install on whoever runs the suite.
 *
 * ⛔ BORNE: this proves the script's DECISION, never gitlawb itself. No network, no registration,
 * no publish, and the real ~/.gitlawb/identity.pem is never read or written — every run gets its
 * own throwaway HOME.
 *
 * Run: node test/gitlawb-identity-is-not-minted-by-accident.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const posix = (p) => p.split(path.sep).join('/');
const SCRIPT = posix(path.join(__dirname, '..', 'tools', 'publish-gitlawb.sh'));
const temporaires = [];
const jetable = (suffixe) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-gitlawb-' + suffixe + '-'));
  temporaires.push(d);
  return d;
};

/* Le driver: il n'ajoute AUCUNE politique, il remplace seulement les deux binaires que le script
 * appelle. Un stub qui violerait le contrat mesure plus haut fabriquerait la conclusion. */
const DRIVER = [
  '#!/usr/bin/env bash',
  'export HOME="$1"; export STUB_JOURNAL="$2"; STUB_SCRIPT="$4"',
  'if [ "$3" = "1" ]; then export GITLAWB_NEW_IDENTITY=1; fi',
  'gl() {',
  '  PEM="$HOME/.gitlawb/identity.pem"',
  '  case "$1" in',
  '    --version) echo "9.9.9-stub"; return 0;;',
  '    identity)',
  '      case "$2" in',
  '        show)',
  '          if [ -e "$PEM" ]; then cat "$PEM"; return 0; fi',
  '          echo "Error: no identity found at $PEM" >&2; return 1;;',
  '        new)',
  '          mkdir -p "$(dirname "$PEM")"',
  '          echo "did:key:zSTUBBRANDNEWIDENTITY0000000000000000000000" > "$PEM"',
  '          echo "IDENTITY_MINTED" >> "$STUB_JOURNAL"; return 0;;',
  '      esac;;',
  '    register) echo "registered (stub)"; return 0;;',
  '    mirror) echo "MIRROR_RAN did=$(cat "$HOME/.gitlawb/identity.pem")" >> "$STUB_JOURNAL";',
  '            echo "mirrored (stub)"; return 0;;',
  '  esac',
  '  echo "stub gl: unexpected subcommand: $*" >&2; return 1',
  '}',
  'npm() {',
  '  if [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "prefix" ]; then echo "/stub-prefix-does-not-exist"; return 0; fi',
  '  echo "stub npm: REFUSES to install anything ($*)" >&2; return 1',
  '}',
  'export -f gl npm',
  'exec bash "$STUB_SCRIPT"',
  '',
].join('\n');

function lancer({ avecIdentite, optIn }) {
  const atelier = jetable('run');
  const home = path.join(atelier, 'home');
  const journal = path.join(atelier, 'journal.txt');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(journal, '');
  if (avecIdentite) {
    fs.mkdirSync(path.join(home, '.gitlawb'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gitlawb', 'identity.pem'),
      'did:key:zEXISTINGIDENTITYTHATALREADYPUBLISHEDTOSHI0\n');
  }
  const driver = path.join(atelier, 'driver.sh');
  fs.writeFileSync(driver, DRIVER);

  const r = spawnSync('bash', [posix(driver), posix(home), posix(journal), optIn ? '1' : '0', SCRIPT],
    { encoding: 'utf8', timeout: 60000 });
  if (r.error) {
    // ⛔ Jamais "skip": une garde qui n a pas tourne n est pas une garde qui a dit oui.
    throw new Error('impossible de lancer bash (' + r.error.message + '). Ce gate exige un bash '
      + '(WSL, Git Bash ou Linux); sans lui il ne mesure RIEN et doit rougir plutot que passer.');
  }
  return {
    code: r.status,
    sortie: String(r.stdout || '') + String(r.stderr || ''),
    journal: fs.readFileSync(journal, 'utf8'),
  };
}

console.log('LAWBOR — publier ne mint pas une identite par accident:');

const temoin = lancer({ avecIdentite: true, optIn: false });

t('CONTRE-BORNE — le VRAI script tourne vraiment (sinon tout le reste est vide)', () => {
  assert.ok(temoin.journal.includes('MIRROR_RAN'),
    'le temoin n a pas atteint `gl mirror`. Sans cette preuve, un harness casse ferait passer les cas '
    + 'suivants pour des refus corrects alors que rien ne se serait execute. Sortie:\n' + temoin.sortie);
});

t('1) identite PRESENTE — publie, et DIT qu il a reutilise', () => {
  assert.equal(temoin.code, 0, 'le cas nominal doit rester possible; sortie:\n' + temoin.sortie);
  assert.ok(!temoin.journal.includes('IDENTITY_MINTED'), 'une identite existait et le script en a mint une autre');
  assert.ok(/EXISTING DID|reused/.test(temoin.sortie),
    'la ligne de succes ne dit pas QUELLE identite a servi. Identique dans les deux mondes, elle ne '
    + 'rapporte rien:\n' + temoin.sortie);
});

t('2) AUCUNE identite a portee — refuse, ne mint RIEN, ne publie RIEN', () => {
  const r = lancer({ avecIdentite: false, optIn: false });
  assert.notEqual(r.code, 0,
    'le script s est termine en succes sans identite a portee. Un autre $HOME (sudo, autre distro, '
    + 'conteneur, second poste) suffit a produire ce cas, et le standing gitlawb est un COMPTEUR DE '
    + 'PUSHES: publier sous un DID neuf le repart a zero.\n' + r.sortie);
  assert.ok(!r.journal.includes('IDENTITY_MINTED'), 'une identite a ete mint sans opt-in:\n' + r.journal);
  assert.ok(!r.journal.includes('MIRROR_RAN'), 'le mirror a tourne malgre le refus:\n' + r.journal);
  assert.ok(r.sortie.includes('GITLAWB_NEW_IDENTITY'),
    'le refus ne nomme pas la porte de sortie explicite; un refus sans issue ecrite se contourne au '
    + 'jugé:\n' + r.sortie);
});

t('3) opt-in EXPLICITE — laisse passer, et DIT que le DID est neuf', () => {
  const r = lancer({ avecIdentite: false, optIn: true });
  assert.equal(r.code, 0, 'GITLAWB_NEW_IDENTITY=1 doit rester un chemin praticable; sortie:\n' + r.sortie);
  assert.ok(r.journal.includes('IDENTITY_MINTED'), 'opt-in donne mais aucune identite creee:\n' + r.journal);
  assert.ok(r.journal.includes('MIRROR_RAN'), 'opt-in donne mais le mirror n a pas tourne:\n' + r.journal);
  assert.ok(/BRAND-NEW|standing starts at ZERO/.test(r.sortie),
    'le succes ne signale pas que le compteur de standing repart de zero:\n' + r.sortie);
});

for (const d of temporaires) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* laisse le tmp */ } }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
