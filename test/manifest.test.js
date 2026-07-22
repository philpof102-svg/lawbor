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


// SCRIPTS-VS-FILES — a shipped script must point at a shipped file.
// Found by reasoning about the tarball rather than the repo: package.json declared \n// while claims.cjs was not in , so the command documented as THE post-deploy check would have
// failed for everyone who installed. Same broken-promise class as the ERC-8004 card and the npx line.
t('every script that ships points at a file that ships (test/ exempt, by convention)', () => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const shipped = new Set(p.files);
  const dirs = p.files.filter((f) => f.endsWith('/'));
  const inPkg = (f) => shipped.has(f) || dirs.some((d) => f.startsWith(d));
  const missing = [];
  for (const [name, cmd] of Object.entries(p.scripts)) {
    if (name === 'test' || name === 'prepublishOnly') continue;   // tests are deliberately not shipped;
    // prepublishOnly runs from the REPO before packing, so it never needs to exist in the tarball.
    const m = String(cmd).match(/nodes+([w./-]+.c?js)/);
    if (m && !inPkg(m[1])) missing.push('npm run ' + name + ' -> ' + m[1]);
  }
  assert.deepEqual(missing, [], 'these scripts ship but their files do not: ' + missing.join('; '));
});

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
  // CROSS-PLATFORM: launch via `node`, never `npx`. `npx` on Windows is npx.cmd, a batch shim that
  // CreateProcess cannot spawn directly — MCP clients (openclaude/Claude Code/Desktop) time out and
  // demand a `cmd /c` wrapper, which then breaks mac/linux. `node` is node.exe everywhere: one command,
  // every OS. Confirmed 2026-07-20: `openclaude mcp doctor` shows `npx` → 0 healthy ("Windows requires
  // 'cmd /c' wrapper"), `node ${CLAUDE_PLUGIN_ROOT}/bin/lawbor-mcp.js` → 1 healthy, connected.
  assert.equal(s.command, 'node', 'must launch via node (a real .exe on every OS), never the Windows-broken npx.cmd shim');
  assert.ok(Array.isArray(s.args) && s.args.length === 1, 'a single arg: the entry path');
  assert.match(s.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/lawbor-mcp\.js$/,
    'entry is addressed relative to the installed plugin dir, so no npx download and no npm install is needed');
});
t('plugin.json: the entry the manifest launches is a real, shipped bin of this package', () => {
  assert.equal(pkg.name, 'lawbor-bot');
  assert.ok(pkg.bin && pkg.bin['lawbor-mcp'], 'the stdio entry point is declared as a bin');
  // The manifest arg, once ${CLAUDE_PLUGIN_ROOT} resolves, must land on that same bin file.
  const rel = plugin.mcpServers.lawbor.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
  assert.equal(rel, pkg.bin['lawbor-mcp'].replace(/^\.\//, ''), 'manifest entry === package bin[lawbor-mcp]');
});
t('DESCRIPTOR-ONLY STAYS FREE-STANDING: the launched entry pulls no REQUIRED external dependency', () => {
  // Why the `node ${CLAUDE_PLUGIN_ROOT}` launch works with NO `npm install` / no SessionStart hook:
  // the stdio entry's whole require-graph is Node built-ins. viem is the lone external, and it is
  // optional + lazily loaded (lib/verify.js try/catch → null). A hard top-level require of any
  // package would silently reintroduce the "works on my machine, empty on a fresh install" failure.
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    'lawbor-bot declares no hard dependencies — the MCP entry must boot from a bare clone');
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
