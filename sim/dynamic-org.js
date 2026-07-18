'use strict';
/**
 * LAWBOR dynamic agent-org simulation — the dependency GRAPH rewriting itself while work happens.
 * ==============================================================================================
 * Four REAL nodes on loopback (real relay/mesh/consent/work), one shared reputation oracle. It plays
 * out an agent ORG delivering a feature through a dependency graph, and shows the two things that make
 * LAWBOR's graph different from a plain task queue:
 *
 *   1. TWO GATES COMPOSE. A job in the `ready` frontier still only accepts a bid from a REPUTABLE
 *      worker — the relay drops a low-rep bidder before the graph gate even runs. And a job whose
 *      upstreams are not yet awarded is `blocked`: even a reputable worker's bid is refused. This is
 *      the wedge over farmtable / agent-swarms, which have a graph but no trust layer:
 *      "graphs make agent orgs programmable; reputation makes them safe to run with strangers' agents."
 *
 *   2. THE GRAPH REWRITES ITSELF. A checker agent finds a problem mid-flight; the org's planner
 *      restructures the LIVE graph in response — cancels the queued deploy, inserts a hotfix node ahead
 *      of a new deploy. No schema change: a "dynamic agent org" is just more append-only envelopes, and
 *      the ready frontier shifts on its own. That is Phil's "the graph rewrites itself while the work
 *      is happening", made to actually run.
 *
 * Honesty (same as lib/work.js): a dependency is satisfied when the upstream is AWARDED (a worker was
 * chosen), NOT delivered — LAWBOR models no execution. This orders NEGOTIATIONS. The checker's "fail"
 * is a real-world outcome it reports to the planner; the graph reacts to that report.
 *
 * Run: npm run sim:org
 *
 * The cast (oracle score in parentheses; the relay floor is 40):
 *   Orin  (90) — the orchestrator: owns the goal, posts the graph, awards, and REPLANS on a failure
 *   Bea   (85) — a builder
 *   Cy    (80) — a checker: verifies, and its finding drives the graph rewrite
 *   Dex   (75) — a deployer
 *   Rando (15) — a low-reputation stranger whose bid the relay drops before the graph is even consulted
 */
const { build } = require('../server');
const { createStore } = require('../lib/store');
const os = require('os'), path = require('path');

const lower = (s) => String(s).toLowerCase();
const A = (h) => '0x' + h.repeat(20);
const ORIN = A('01'), BEA = A('02'), CY = A('03'), DEX = A('04'), RANDO = A('05');
const NAME = { [lower(ORIN)]: 'Orin', [lower(BEA)]: 'Bea', [lower(CY)]: 'Cy', [lower(DEX)]: 'Dex', [lower(RANDO)]: 'Rando' };
const SCORE = { [lower(ORIN)]: 90, [lower(BEA)]: 85, [lower(CY)]: 80, [lower(DEX)]: 75, [lower(RANDO)]: 15 };
const preflight = async (a) => ({ decision: 'PROCEED', score: SCORE[lower(a)] ?? 0 });   // score < 40 ⇒ relay drops

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('   ✓ ' + label); } else { fail++; console.log('   ✗ ' + label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(220);
const say = (s) => console.log('\n▸ ' + s);

function makeNode(self) {
  const base = path.join(os.tmpdir(), 'lawbor-org-' + process.pid + '-' + NAME[lower(self)]);
  const store = createStore(base + '.jsonl', base + '.control');
  return build({ self, human: NAME[lower(self)], preflight, store,
    allowLoopback: true, allowInsecure: true, allowUnauthenticated: true });
}

async function main() {
  const nodes = {};
  for (const s of [ORIN, BEA, CY, DEX, RANDO]) nodes[lower(s)] = makeNode(s);
  const url = {};
  for (const s of Object.keys(nodes)) { await new Promise((r) => nodes[s].server.listen(0, r)); url[s] = 'http://127.0.0.1:' + nodes[s].server.address().port; }

  const post = (who, p, body) => fetch(url[lower(who)] + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const get = (who, p) => fetch(url[lower(who)] + p).then((r) => r.json());
  const peer = (from, to) => post(from, '/peers', { addr: to, url: url[lower(to)] });
  // the org's view is the orchestrator's authoritative graph (Orin owns every structural job)
  const graph = () => get(ORIN, '/graph');
  const readySet = (g) => [...g.ready].sort();
  const blockedOf = (g, id) => (g.blocked.find((b) => b.jobId === id) || {}).blockedBy;
  const nodeState = (g, id) => (g.nodes.find((n) => n.jobId === id) || {}).state;
  const bidsOn = (g, id) => (g.nodes.find((n) => n.jobId === id) || {}).bids;

  console.log('LAWBOR dynamic agent-org — a dependency graph that rewrites itself while work happens\n');
  console.log('cast: ' + Object.entries(SCORE).map(([a, s]) => NAME[a] + '(' + s + ')').join(' · ') + '   [relay floor 40]');

  // everyone reputable peers with everyone; Rando (15) can only reach OUT (nobody may add him)
  for (const a of [ORIN, BEA, CY, DEX]) for (const b of [ORIN, BEA, CY, DEX]) if (a !== b) await peer(a, b);
  await peer(RANDO, ORIN);

  // ---- 1. Orin posts the initial pipeline as a graph -------------------------------------------
  say('Orin posts the delivery pipeline as a GRAPH: build → verify(needs build) → deploy(needs verify).');
  await post(ORIN, '/work', { to: BEA, kind: 'help_wanted', jobId: 'build', task: 'build the feature', tags: ['org'] });
  await post(ORIN, '/work', { to: CY, kind: 'help_wanted', jobId: 'verify', task: 'verify the build', dependsOn: ['build'] });
  await post(ORIN, '/work', { to: DEX, kind: 'help_wanted', jobId: 'deploy', task: 'ship it', dependsOn: ['verify'] });
  let g = await graph();
  console.log('   ready frontier: [' + readySet(g).join(', ') + ']   edges: ' + g.edges.map((e) => e.from + '→' + e.dependsOn).join(', '));
  check('only the root is ready; verify and deploy are blocked by their upstreams',
    readySet(g).join() === 'build' && blockedOf(g, 'verify') && blockedOf(g, 'verify').join() === 'build' && blockedOf(g, 'deploy').join() === 'verify');
  check('the graph knows its shape: 2 dependency edges, root = build', g.edges.length === 2 && g.roots.join() === 'build');

  // ---- 2. the GRAPH gate: a reputable worker cannot bid a blocked job --------------------------
  say('Dex tries to bid on deploy now — but deploy is blocked (verify not awarded). The graph gate refuses it.');
  const earlyDeployBid = await post(DEX, '/work', { to: ORIN, kind: 'bid', jobId: 'deploy', price: '5' });
  check('bid on a blocked job is refused by the graph gate (409, names the blocker)',
    /blocked by/.test(earlyDeployBid.error || '') && (bidsOn(await graph(), 'deploy') || 0) === 0);

  // ---- 3. the REPUTATION gate composes with the graph gate -------------------------------------
  say('Rando (15) bids on build — which IS ready. But he is below the floor, so the RELAY drops him before the graph is even consulted.');
  await post(RANDO, '/work', { to: ORIN, kind: 'bid', jobId: 'build', price: '1' });
  await settle();
  check('a ready job still rejects a low-reputation bidder — reputation gates the graph', (bidsOn(await graph(), 'build') || 0) === 0);

  // ---- 4. reputable work flows: build gets bid + awarded, verify unblocks ----------------------
  say('Bea (reputable) bids build; Orin awards her. Awarding the upstream shifts the frontier: verify is now ready.');
  await post(BEA, '/work', { to: ORIN, kind: 'bid', jobId: 'build', price: '10', eta: '2h' });
  await settle();
  await post(ORIN, '/work', { to: BEA, kind: 'award', jobId: 'build', worker: BEA, price: '10' });
  g = await graph();
  console.log('   ready frontier: [' + readySet(g).join(', ') + ']');
  check('build awarded → verify enters the ready frontier; deploy still waits on verify',
    nodeState(g, 'build') === 'awarded' && readySet(g).join() === 'verify' && blockedOf(g, 'deploy').join() === 'verify');

  // ---- 5. the checker takes verify ------------------------------------------------------------
  say('Cy bids verify; Orin awards Cy. deploy becomes negotiable (its upstream is awarded) — but the check has not RUN yet.');
  await post(CY, '/work', { to: ORIN, kind: 'bid', jobId: 'verify', price: '8' });
  await settle();
  await post(ORIN, '/work', { to: DEX, kind: 'award', jobId: 'verify', worker: CY, price: '8' });
  g = await graph();
  check('verify awarded → deploy is now ready (negotiation-wise; awarded ≠ delivered, per the honesty rule)',
    nodeState(g, 'verify') === 'awarded' && readySet(g).includes('deploy'));

  // ---- 6. THE GRAPH REWRITES ITSELF -----------------------------------------------------------
  say('Cy runs the check and it FAILS. Cy reports it to Orin. The org\'s planner restructures the LIVE graph:');
  await post(CY, '/bot/say', { to: ORIN, body: 'verify FAILED: null deref in module X — do not ship' });
  await settle();
  console.log('     · cancel deploy (its upstream verify did not pass)');
  console.log('     · insert hotfix (needs build) and a new deploy2 (needs hotfix)');
  await post(ORIN, '/work', { to: DEX, kind: 'cancel', jobId: 'deploy', reason: 'verify failed' });
  await post(ORIN, '/work', { to: BEA, kind: 'help_wanted', jobId: 'hotfix', task: 'fix the null deref', dependsOn: ['build'] });
  await post(ORIN, '/work', { to: DEX, kind: 'help_wanted', jobId: 'deploy2', task: 'ship the fixed build', dependsOn: ['hotfix'] });
  g = await graph();
  console.log('   ready frontier: [' + readySet(g).join(', ') + ']   nodes: ' + g.nodes.map((n) => n.jobId + '(' + n.state + (n.ready ? '' : ':blocked') + ')').join(', '));
  check('the graph rewrote itself mid-flight: deploy cancelled, hotfix + deploy2 are NEW live nodes',
    nodeState(g, 'deploy') === 'cancelled' && nodeState(g, 'hotfix') === 'open' && nodeState(g, 'deploy2') === 'open');
  check('the ready frontier moved on its own: hotfix is claimable (build awarded), deploy2 waits on hotfix',
    readySet(g).join() === 'hotfix' && blockedOf(g, 'deploy2').join() === 'hotfix');

  // ---- 7. the rewritten path completes --------------------------------------------------------
  say('Bea takes the hotfix; Orin awards it → deploy2 unblocks. Dex takes deploy2; Orin awards it → the goal is reached.');
  await post(BEA, '/work', { to: ORIN, kind: 'bid', jobId: 'hotfix', price: '6' });
  await settle();
  await post(ORIN, '/work', { to: BEA, kind: 'award', jobId: 'hotfix', worker: BEA, price: '6' });
  g = await graph();
  check('hotfix awarded → deploy2 is the last ready node', nodeState(g, 'hotfix') === 'awarded' && readySet(g).join() === 'deploy2');
  await post(DEX, '/work', { to: ORIN, kind: 'bid', jobId: 'deploy2', price: '12' });
  await settle();
  await post(ORIN, '/work', { to: DEX, kind: 'award', jobId: 'deploy2', worker: DEX, price: '12' });
  g = await graph();
  check('deploy2 awarded — the org delivered through the rewritten graph; nothing is ready left',
    nodeState(g, 'deploy2') === 'awarded' && g.ready.length === 0);

  // ---- final picture --------------------------------------------------------------------------
  say('Final graph (the org\'s authoritative view on Orin):');
  console.log('   ' + g.nodes.map((n) => n.jobId + '=' + n.state).join('  '));
  console.log('   edges: ' + g.edges.map((e) => e.from + '→' + e.dependsOn).join(', '));
  check('exactly one job was cancelled (deploy) and the fix path (hotfix, deploy2) carried the delivery',
    g.nodes.filter((n) => n.state === 'cancelled').length === 1 &&
    ['build', 'verify', 'hotfix', 'deploy2'].every((id) => nodeState(g, id) === 'awarded'));

  for (const s of Object.keys(nodes)) { try { nodes[s].server.close(); nodes[s].stopHeartbeat && nodes[s].stopHeartbeat(); } catch {} }
  console.log('\n' + pass + ' checks passed · ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('sim crashed:', e); process.exit(1); });
