'use strict';
/**
 * hosted-node-is-not-hidden — ce que le README promet aux HUMAINS, le manifeste le dit aux MACHINES.
 * ==================================================================================================
 * Mesure du 2026-08-14. Le README nomme deux fois un noeud public; l entree de ce serveur au MCP registry
 * n annonce AUCUN endpoint (`remotes` absent de server.json, et le registre le reflete fidelement). Sur un
 * projet dont l objet est la decouvrabilite par des agents, un endpoint documente pour les humains et
 * invisible aux machines n est pas un oubli de confort.
 *
 * Il pese, parce que les deux chemins MACHINE passent par le paquet npm — `runtimeHint: npx` dans
 * server.json, et le plugin.json publie — or lawbor-bot@0.2.1 date du 21/07 et lui manque le durcissement
 * du meme jour (loopback qui doit signer, plafond OOM, amplification CPU bornee) que le noeud heberge, lui,
 * PORTE. Donc une installation decouverte va chercher la version non corrigee pendant que la version
 * corrigee tourne, non annoncee.
 *
 * PROPRIETE, bidirectionnelle: si le README annonce un noeud public, alors server.json porte SOIT un
 * `remotes` non vide, SOIT une note ecrite disant pourquoi pas — et **pas les deux**. Le sens direct
 * interdit le silence; la reciproque empeche qu une note expliquant une absence survive a l absence, ce qui
 * en ferait une echappatoire permanente et viderait ce test de son sens.
 *
 * ⛔ CE TEST NE TRANCHE RIEN. Annoncer le remote est une decision de ROUTAGE avec un cout — chaque enveloppe
 * entrante admise par ce noeud appelle l oracle MainStreet. Le test exige que le choix soit ECRIT, jamais
 * qu il aille dans un sens. Le vrai correctif de fond reste de republier npm.
 *
 * ⛔ BORNE: il lit le README et server.json, jamais le REGISTRE. Une entree publiee avant ce fichier peut
 * rester perimee au registre meme quand ces deux-la sont d accord — seul `mcp-publisher` la rafraichit.
 *
 * Run: node test/hosted-node-is-not-hidden.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const RACINE = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(RACINE, 'README.md'), 'utf8');
const MANIFESTE = JSON.parse(fs.readFileSync(path.join(RACINE, 'server.json'), 'utf8'));

// Un hote de deploiement, pas une URL quelconque: un lien vers GitHub ou vers la doc n est pas un noeud.
const HOTES = /https:\/\/[a-z0-9-]+\.(?:up\.railway\.app|onrender\.com|fly\.dev|vercel\.app)/gi;

console.log('LAWBOR — le noeud heberge n est pas cache aux machines:');

t('CONTRE-BORNE — le README est lu et il est non trivial', () => {
  assert.ok(README.length > 500,
    'README de ' + README.length + ' octets: sous ce seuil la mesure porterait sur presque rien et ce test '
    + 'passerait vert en n ayant rien regarde.');
});

t('si le README annonce un noeud public, le manifeste le dit AUSSI — ou ecrit pourquoi pas', () => {
  const annonces = [...new Set(README.match(HOTES) || [])];
  const remotes = Array.isArray(MANIFESTE.remotes) ? MANIFESTE.remotes : [];
  const note = typeof MANIFESTE._remotes_note === 'string' ? MANIFESTE._remotes_note.trim() : '';

  if (!annonces.length) {
    // Pas de noeud annonce aux humains: rien a exiger du manifeste, et il faut le DIRE plutot que
    // de laisser un succes muet passer pour une verification.
    console.log('      (aucun hote de deploiement dans le README — rien a comparer)');
    return;
  }
  if (!remotes.length && !note) {
    assert.fail('le README annonce ' + annonces.length + ' noeud(s) public(s) et server.json n a ni '
      + '`remotes` ni `_remotes_note`. Les agents qui decouvrent ce serveur par le registre ne voient que '
      + 'le paquet npm — et les deux chemins machine passent par lui. Ecrire l un ou l autre; ce test ne '
      + 'demande PAS d annoncer le remote, il refuse que l omission reste muette.');
  }
  if (remotes.length && note) {
    assert.fail('server.json porte `remotes` ET `_remotes_note`. Une note qui explique une absence a '
      + 'survecu a l absence: elle satisferait ce test pour toujours et le vide de son sens. La retirer '
      + 'fait partie du fait d annoncer le remote.');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
