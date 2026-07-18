'use strict';
// Plugin manifests validated against the FIELDS openclaude's own zod schemas require
// (src/utils/plugins/schemas.ts, read 2026-07-18). Catches a dead manifest before anyone installs it.
// Run: node test/manifest.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + e.message); } };

const read = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const plugin = read('.claude-plugin/plugin.json');
const market = read('.claude-plugin/marketplace.json');
const pkg = read('package.json');

console.log('openclaude plugin manifests:');

t('plugin.json: name is non-empty and contains NO space (kebab-case rule in the schema)', () => {
  assert.ok(typeof plugin.name === 'string' && plugin.name.length > 0);
  assert.ok(!plugin.name.includes(' '), 'schema rejects spaces in the plugin name');
});
t('plugin.json: version is semver-shaped, homepage is a valid URL (schema uses z.string().url())', () => {
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.doesNotThrow(() => new URL(plugin.homepage));
});
t('plugin.json: author is an OBJECT with a name (PluginAuthorSchema), not a bare string', () => {
  assert.equal(typeof plugin.author, 'object');
  assert.ok(plugin.author.name);
});
t('plugin.json: mcpServers is a record of server-name → config with command+args', () => {
  assert.equal(typeof plugin.mcpServers, 'object');
  const s = plugin.mcpServers.lawbor;
  assert.ok(s, 'the lawbor server entry exists');
  assert.equal(s.command, 'npx');
  assert.ok(Array.isArray(s.args) && s.args.includes('lawbor-bot'));
});
t('plugin.json: the npx package matches what package.json actually publishes', () => {
  assert.equal(pkg.name, 'lawbor-bot');
  assert.ok(pkg.bin && pkg.bin['lawbor-mcp'], 'the stdio entry point is declared as a bin');
});
t('marketplace.json: source is {source:"github", repo}, name matches the plugin name', () => {
  const e = market.plugins[0];
  assert.equal(e.name, plugin.name, 'marketplace entry name must match the plugin name');
  assert.equal(e.source.source, 'github');
  assert.match(e.source.repo, /^[\w-]+\/[\w-]+$/);
});
t('marketplace.json: has plugins[] and optional metadata.description', () => {
  assert.ok(Array.isArray(market.plugins) && market.plugins.length >= 1);
  assert.ok(typeof market.metadata.description === 'string');
});
t('HONESTY: neither manifest claims signing, custody or funds movement', () => {
  const blob = JSON.stringify(plugin) + JSON.stringify(market);
  assert.ok(/[Dd]escriptor-only/.test(blob), 'the descriptor-only promise is stated to installers');
  assert.ok(!/\b(auto-?sign|custody|holds? (your )?keys?|sends? funds)\b/i.test(blob));
});
t('the bin referenced by the manifest EXISTS on disk', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'bin', 'lawbor-mcp.js')));
  assert.ok(pkg.files.includes('bin/'), 'bin/ is shipped in the npm package');
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
