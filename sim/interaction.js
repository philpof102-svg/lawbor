'use strict';
/**
 * LAWBOR interaction simulation — the whole app, as a system, playing out a realistic scenario.
 * ==============================================================================================
 * Five REAL nodes on loopback (real HTTP, real relay/mesh/consent/jobs), one shared reputation
 * oracle, and a story that exercises every layer at once:
 *   reputation gate · first-contact consent quarantine · accept · job negotiation · block (total) ·
 *   block's network effect on gossip.
 * It prints a narrative and asserts the invariants at the end. Run: npm run sim
 *
 * The cast (score from the shared oracle in parentheses; the relay floor is 40):
 *   Alice  (90) — hiring for a job
 *   Bob    (85) — a worker Alice already knows
 *   Carol  (80) — a reputable worker Alice does NOT know yet (first contact)
 *   Mallory(10) — a low-reputation spammer: the relay drops her before consent even runs
 *   Sybil  (70) — reputable enough to pass, but a nuisance Alice will block
 */
const { build } = require('../server');
/* unique par CONSTRUCTION: un pid n est pas un id de run (Windows les recycle), et un nom
 * reutilise fait heriter le store du run precedent. Voir test/consent.test.js pour l enquete. */
const LAWBOR_TMP = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lawbor-t-"));
const { createStore } = require('../lib/store');
const os = require('os'), path = require('path');

const lower = (s) => String(s).toLowerCase();
const A = (h) => '0x' + h.repeat(20);
const ALICE = A('a1'), BOB = A('b1'), CAROL = A('c1'), MALLORY = A('e1'), SYBIL = A('f1');
const NAME = { [lower(ALICE)]: 'Alice', [lower(BOB)]: 'Bob', [lower(CAROL)]: 'Carol', [lower(MALLORY)]: 'Mallory', [lower(SYBIL)]: 'Sybil' };
const SCORE = { [lower(ALICE)]: 90, [lower(BOB)]: 85, [lower(CAROL)]: 80, [lower(MALLORY)]: 10, [lower(SYBIL)]: 70 };
const preflight = async (a) => ({ decision: 'PROCEED', score: SCORE[lower(a)] ?? 0 });   // score < 40 ⇒ relay drops

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('   ✓ ' + label); } else { fail++; console.log('   ✗ ' + label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(220);                          // let a fire-and-forget HTTP relay land
const say = (s) => console.log('\n▸ ' + s);

function makeNode(self) {
  const base = path.join(LAWBOR_TMP, 'sim-' + '-' + NAME[lower(self)]);
  const store = createStore(base + '.jsonl', base + '.control');
  return build({ self, human: NAME[lower(self)], preflight, store,
    allowLoopback: true, allowInsecure: true, allowUnauthenticated: true });
}

async function main() {
  const nodes = {};
  for (const s of [ALICE, BOB, CAROL, MALLORY, SYBIL]) nodes[lower(s)] = makeNode(s);
  const url = {};
  for (const s of Object.keys(nodes)) { await new Promise((r) => nodes[s].server.listen(0, r)); url[s] = 'http://127.0.0.1:' + nodes[s].server.address().port; }

  const post = (who, p, body) => fetch(url[lower(who)] + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const get = (who, p) => fetch(url[lower(who)] + p).then((r) => r.json());
  const peer = async (from, to) => post(from, '/peers', { addr: to, url: url[lower(to)] });

  console.log('LAWBOR interaction simulation — 5 real nodes, reputation × consent × jobs × block × mesh\n');
  console.log('cast: ' + Object.entries(SCORE).map(([a, s]) => NAME[a] + '(' + s + ')').join(' · ') + '   [relay floor 40]');

  // ---- everyone reputable peers up; the low-rep spammer can only reach OUT ----------------------
  say('Peering. Mesh admission is reputation-gated, so Mallory (10) cannot be ADDED by anyone — she can only reach out.');
  for (const a of [ALICE, BOB, CAROL, SYBIL]) for (const b of [ALICE, BOB, CAROL, SYBIL]) if (a !== b) await peer(a, b);
  await peer(MALLORY, ALICE);                              // Mallory adds Alice (Alice is reputable) so she can try to spam
  const aliceAddsMallory = await peer(ALICE, MALLORY);     // ...but Alice adding Mallory is refused by the reputation gate
  check('mesh admission reputation-gates: Alice cannot add low-rep Mallory as a peer', aliceAddsMallory.ok === false);
  check('Alice peered with the reputable three', (await get(ALICE, '/health')).peers === 3);

  // ---- the reputation gate: a low-rep spammer never reaches the human --------------------------
  say('Mallory (10) blasts Alice. The relay gates the SENDER by reputation — she is dropped before consent even runs.');
  await post(MALLORY, '/say', { to: ALICE, body: 'BUY CHEAP FOLLOWERS!!!' });
  await settle();
  check('Mallory reached nothing — reputation floor stopped her (not consent)', (await get(ALICE, '/inbox')).threads.length === 0 && (await get(ALICE, '/requests')).threads.length === 0);

  // ---- consent: a reputable STRANGER is quarantined, not dropped -------------------------------
  say('Carol (80) messages Alice. She passes reputation — but Alice does not know her, so she waits in Requests, not the inbox.');
  await post(CAROL, '/say', { to: ALICE, body: 'gm Alice — I saw your indexer bounty, keen to help' });
  await settle();
  check('Carol passed reputation but landed in Requests (consent quarantine), NOT the inbox',
    (await get(ALICE, '/requests')).threads.length === 1 && (await get(ALICE, '/inbox')).threads.length === 0);

  say('Alice reviews Requests and accepts Carol → promoted to her inbox.');
  await post(ALICE, '/accept', { addr: CAROL });
  check('after accept, Carol is in Alice\'s inbox and gone from Requests',
    (await get(ALICE, '/inbox')).threads.length === 1 && (await get(ALICE, '/requests')).threads.length === 0);

  // ---- the job market: negotiate to an agreed price + worker ----------------------------------
  say('Alice posts a job to Bob and Carol; both bid; Alice awards Carol. (Negotiation only — no funds move anywhere.)');
  const JOB = 'indexer-bounty-1';
  await post(ALICE, '/work', { to: BOB, kind: 'help_wanted', jobId: JOB, task: 'index a Base contract', tags: ['base', 'index'] });
  await post(ALICE, '/work', { to: CAROL, kind: 'help_wanted', jobId: JOB, task: 'index a Base contract', tags: ['base', 'index'] });
  await settle();
  await post(BOB, '/work', { to: ALICE, kind: 'bid', jobId: JOB, price: '25 USDC', eta: '3h' });
  await post(CAROL, '/work', { to: ALICE, kind: 'bid', jobId: JOB, price: '18 USDC', eta: '2h' });
  await settle();
  const aliceJob = (await get(ALICE, '/jobs')).jobs.find((j) => j.jobId === JOB);
  check('Alice sees both bids on her job', aliceJob && aliceJob.bids.length === 2);
  await post(ALICE, '/work', { to: CAROL, kind: 'award', jobId: JOB, worker: CAROL, price: '18 USDC' });
  await settle();
  const carolJob = (await get(CAROL, '/jobs')).jobs.find((j) => j.jobId === JOB);
  check('Carol sees the job awarded to her at the agreed price', carolJob && carolJob.state === 'awarded' && carolJob.award.price === '18 USDC');

  // ---- the block: total, and it has a network effect ------------------------------------------
  say('Sybil (70) passes reputation but spams Alice with junk JOBS (as a bot). Alice blocks her.');
  await post(SYBIL, '/work', { to: ALICE, kind: 'help_wanted', jobId: 'spam-1', task: '🚀 100x GEM presale, DM now' });
  await settle();
  check('Sybil\'s spam job reached Alice\'s /jobs before the block (she passed reputation)',
    (await get(ALICE, '/jobs')).jobs.some((j) => j.jobId === 'spam-1'));
  const gossipBefore = (await get(ALICE, '/lawbor/peers')).peers.some((p) => lower(p.addr) === lower(SYBIL));
  await post(ALICE, '/block', { addr: SYBIL });
  say('Blocked. A block is TOTAL — Sybil\'s spam vanishes from /jobs, she reaches no surface, and Alice stops recommending her to others.');
  await post(SYBIL, '/work', { to: ALICE, kind: 'help_wanted', jobId: 'spam-2', task: 'more spam' });
  await settle();
  check('Sybil\'s already-stored spam job is gone from Alice\'s /jobs', !(await get(ALICE, '/jobs')).jobs.some((j) => j.jobId === 'spam-1'));
  check('Sybil\'s new spam never lands (blocked on every surface)', !(await get(ALICE, '/jobs')).jobs.some((j) => j.jobId === 'spam-2'));
  check('block has a NETWORK effect: Alice gossiped Sybil before, and stops after blocking',
    gossipBefore === true && !(await get(ALICE, '/lawbor/peers')).peers.some((p) => lower(p.addr) === lower(SYBIL)));

  // ---- the final state Alice actually sees ----------------------------------------------------
  say('Final state of Alice\'s node:');
  const inbox = (await get(ALICE, '/inbox')).threads;
  const jobs = (await get(ALICE, '/jobs')).jobs;
  console.log('   inbox:   ' + inbox.map((t) => t.peers.map((p) => NAME[lower(p)] || p.slice(0, 6)).filter((n) => n !== 'Alice').join('')).join(', '));
  console.log('   jobs:    ' + jobs.map((j) => j.jobId + '(' + j.state + (j.award ? '→' + (NAME[lower(j.award.worker)] || '') : '') + ')').join(', '));
  check('Alice\'s inbox holds only people she consented to (Carol), never Mallory or Sybil',
    inbox.length === 1 && inbox[0].peers.some((p) => lower(p) === lower(CAROL)));
  check('Alice\'s jobs hold only the real bounty (awarded to Carol), no spam',
    jobs.length === 1 && jobs[0].jobId === JOB);

  for (const s of Object.keys(nodes)) { try { nodes[s].server.close(); nodes[s].stopHeartbeat && nodes[s].stopHeartbeat(); } catch {} }
  console.log('\n' + pass + ' checks passed · ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('sim crashed:', e); process.exit(1); });
