'use strict';
/* CLAIMS AUDIT — probe everything this node tells the outside world.
 * =================================================================================================
 * Written after making the same mistake three times in one afternoon:
 *   1. the ERC-8004 card declared a `web` service at `/` while `/` returned 404 in production;
 *   2. the MCP refusal told strangers to run `npx lawbor-bot`, which 404s on npm (unpublished);
 *   3. and both were only found by poking the live node by hand, after publishing.
 * The pattern is always the same — a claim aimed at someone else, shipped without being checked. This
 * makes that check a command instead of a good intention.
 *
 * It is NOT in signoff.sh on purpose: it needs the network, and a test suite that fails when GitHub is
 * slow teaches people to ignore red. Run it after every deploy.
 *
 *   node claims.cjs                      → audit the live production node
 *   node claims.cjs http://localhost:4830 → audit a local one
 */
const BASE = (process.argv[2] || 'https://lawbor-node-production.up.railway.app').replace(/\/$/, '');
const TIMEOUT = 15000;

let pass = 0, fail = 0, warn = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const soft = (m) => { warn++; console.log('  ⚠ ' + m); };

const probe = async (url, init) => {
  try {
    const r = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(TIMEOUT) });
    return { status: r.status, ok: r.status < 400, body: r };
  } catch (e) { return { status: 0, ok: false, err: (e && e.message) || String(e) }; }
};

(async () => {
  console.log('LAWBOR claims audit — every promise this node makes to a stranger\n');
  console.log('  node: ' + BASE + '\n');

  // 1. the node is up at all
  const health = await probe(BASE + '/health');
  if (!health.ok) { bad('/health is unreachable (' + (health.err || health.status) + ') — nothing else can be trusted'); process.exit(1); }
  const h = await health.body.json();
  ok('/health answers · verifiesSettlements=' + h.verifiesSettlements + ' · admits=' + String(h.admits).split(' ')[0]);

  // 2. EVERY service the ERC-8004 card declares must answer. This is the promise that was broken.
  const cardRes = await probe(BASE + '/.well-known/agent-registration.json');
  if (!cardRes.ok) { bad('the ERC-8004 registration card itself is unreachable'); }
  else {
    const card = await cardRes.body.json();
    ok('ERC-8004 card served');
    for (const s of (card.services || [])) {
      const r = await probe(s.url, s.type === 'MCP'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
        : undefined);
      r.ok ? ok('declared service ' + s.type + ' → ' + s.url + ' answers ' + r.status)
           : bad('DECLARED service ' + s.type + ' → ' + s.url + ' answered ' + (r.err || r.status) + ' — this is a placeholder registration');
    }
    if (card.image) {
      const r = await probe(card.image);
      r.ok ? ok('card image answers') : bad('card `image` → ' + card.image + ' is broken (' + (r.err || r.status) + ')');
    }
    // the on-chain half must not be claimed unless it is real
    const ids = card.registrations || [];
    if (!ids.length) soft('no on-chain agentId yet — the card says so honestly (mint, then set LAWBOR_AGENT_ID)');
    else ok('on-chain agentId advertised: ' + JSON.stringify(ids));
  }

  // 3. the routes the node's own pages and messages point at
  for (const p of ['/', '/skill.md', '/wanted', '/credit', '/graph', '/jobs', '/agent.svg']) {
    const r = await probe(BASE + p);
    r.ok ? ok('linked route ' + p + ' answers') : bad('linked route ' + p + ' answered ' + (r.err || r.status));
  }

  // 4. the WRITE surface must be closed to a stranger — this audit runs from outside, like an attacker
  for (const [p, payload] of [['/say', { to: '0x' + '11'.repeat(20), body: 'audit' }],
                              ['/work', { to: '0x' + '11'.repeat(20), kind: 'help_wanted', jobId: 'audit', task: 'x' }],
                              ['/peers', { addr: '0x' + '11'.repeat(20), url: 'https://evil.example' }]]) {
    const r = await probe(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    r.status === 401 ? ok('write route ' + p + ' refuses a stranger (401)')
                     : bad('WRITE ROUTE ' + p + ' answered ' + r.status + ' to a stranger — it should be 401');
  }
  const mcpWrite = await probe(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lawbor_say', arguments: { to: '0x' + '11'.repeat(20), body: 'audit' } } }) });
  if (mcpWrite.ok) {
    const j = await mcpWrite.body.json();
    const text = ((j.result || {}).content || [{}])[0].text || '';
    /refused/.test(text) ? ok('MCP write tool refuses a stranger') : bad('MCP WRITE TOOL ACCEPTED A STRANGER: ' + text.slice(0, 80));
    /* Whatever the refusal tells them to do next must itself exist. Both extractions below were WRONG
     * on their first run, and the audit caught its own faults:
     *   - the url regex swallowed the sentence's trailing full stop, so a live repo probed as ".../lawbor." → 404;
     *   - `npx -y lawbor-bot` yielded "-y" as the package name, which of course is not published.
     * An audit that reports false failures gets ignored exactly as fast as one that reports none. */
    for (const raw of (text.match(/https?:\/\/[^\s)]+/g) || [])) {
      const url = raw.replace(/[.,;:!?)\]]+$/, '');          // trailing sentence punctuation is not part of the url
      const r = await probe(url);
      r.ok ? ok('refusal points at a URL that exists: ' + url) : bad('refusal points at a DEAD url: ' + url + ' (' + (r.err || r.status) + ')');
    }
    // skip npx flags (-y, --yes, …) to reach the actual package specifier
    const npx = text.match(/npx\s+(?:-{1,2}[a-z-]+\s+)*([@a-z0-9][a-z0-9@/._-]*)/i);
    if (npx) {
      const pkg = npx[1].replace(/[.,;:!?]+$/, '');
      /* PUBLISHED IS NOT RUNNABLE. This check used to stop at "does the registry know this name?" and
       * gave a green tick to `npx -y lawbor-bot`, which died with "could not determine executable to
       * run": npx can only resolve a bin whose NAME matches the package, and neither bin was called
       * lawbor-bot. The audit verified existence and never once asked whether the command WORKS —
       * which is the only thing the stranger following it cares about. */
      const r = await probe('https://registry.npmjs.org/' + pkg);
      if (!r.ok) bad('refusal suggests `npx ' + pkg + '` but it is NOT published (' + r.status + ') — a stranger following it gets a 404');
      else {
        const meta = await r.body.json();
        const latest = meta.versions[meta['dist-tags'].latest] || {};
        const bins = Object.keys(latest.bin || {});
        bins.includes(pkg)
          ? ok('`npx ' + pkg + '` resolves — the package declares a bin of that name')
          : bad('`npx ' + pkg + '` CANNOT RUN: published, but no bin is named "' + pkg + '" (bins: ' + (bins.join(', ') || 'none') + ') — npx answers "could not determine executable to run"');
      }
    }
  } else bad('/mcp unreachable');

  // 5. the README's own install claim, checked rather than assumed
  const pkg = require('./package.json');
  const npm = await probe('https://registry.npmjs.org/' + pkg.name);
  npm.ok ? ok('npm package ' + pkg.name + ' is published')
         : soft('npm package ' + pkg.name + ' is NOT published (' + npm.status + ') — README already discloses this; do not advertise npx anywhere else');

  console.log('\n' + (fail ? '❌ ' + pass + ' ok · ' + warn + ' disclosed · ' + fail + ' BROKEN PROMISES'
                            : '✅ ' + pass + ' ok · ' + warn + ' disclosed · 0 broken promises'));
  process.exitCode = fail ? 1 : 0;
})();
