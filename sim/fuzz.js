'use strict';
/**
 * LAWBOR property-based fuzzer — random histories, invariants that must ALWAYS hold.
 * ==================================================================================
 * Drives real nodes in-process (direct node.receive transport, no HTTP) so it is deterministic and
 * fast: thousands of random scenarios per minute. Each scenario is a fresh cast with random
 * reputation scores (some below the floor) running a random sequence of actions — message, bot
 * chatter, post/bid/award a job, block, unblock, accept. After EVERY action it checks a set of
 * invariants that must hold for any history. A break prints the seed + round so it reproduces.
 *
 *   node sim/fuzz.js --minutes 5        # run for ~5 minutes (the "5-min agent")
 *   node sim/fuzz.js --scenarios 2000   # run a fixed number
 *   node sim/fuzz.js --seed 12345       # replay one exact scenario, step by step
 *   node sim/fuzz.js --trace out.json   # dump one scenario's timeline (for the visual report)
 *
 * The invariants (why each matters):
 *   I1 reputation floor is absolute — no message from a sub-floor sender is ever stored
 *   I2 a block is total — a blocked address appears in NONE of the blocker's views (inbox/requests/jobs)
 *   I3 inbox ∩ requests = ∅ — a thread is never in two buckets at once
 *   I4 no self-bid — a job never carries a bid from its own requester
 *   I5 descriptor-only — every send returns sign.signed === false; nothing ever signs
 *   I6 the jobs fold is order-independent — shuffling the log yields the same jobs (two nodes agree)
 *   I7 reputation ≠ consent — accepting a sub-floor address still does not let their message in
 *   I8 dependency readiness is sound — a job is ready IFF every dep exists and is awarded, and
 *      blockedBy is EXACTLY the set of deps that are not awarded (no premature-ready, no phantom-block)
 *   I9 delete is sticky — a tombstoned message id never reappears in the store, even after redelivery
 *   I10 compaction is fold-preserving — jobsFrom is identical before and after compact() (it only drops
 *       tombstones + superseded rows, which never fed the fold, so not one job may change)
 */
const os = require('os'), path = require('path'), fs = require('fs');
/* unique par CONSTRUCTION: un pid n est pas un id de run (Windows les recycle), et un nom
 * reutilise fait heriter le store du run precedent. Voir test/consent.test.js pour l enquete. */
const LAWBOR_TMP = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lawbor-t-"));
const { createNode } = require('../lib/node');
const { createStore } = require('../lib/store');
const { buildWork, jobsFrom, foldThread } = require('../lib/work');

const lower = (s) => String(s).toLowerCase();
const FLOOR = 40;

// deterministic RNG (mulberry32) so every failure reproduces from its seed
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const addrOf = (i) => '0x' + (100 + i).toString(16).padStart(2, '0').repeat(20);

function shuffle(r, arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---- one scenario: fresh cast, random scores, random actions, invariants after each -------------
async function scenario(seed, actions) {
  const r = rng(seed);
  const N = 4 + Math.floor(r() * 4);                       // 4..7 agents
  const agents = Array.from({ length: N }, (_, i) => addrOf(i));
  const score = {};
  for (const a of agents) score[lower(a)] = Math.floor(r() * 100);   // 0..99; some below FLOOR
  const preflight = async (a) => ({ decision: 'PROCEED', score: score[lower(a)] ?? 0 });

  const registry = {};
  const files = [];
  const nodes = {};
  for (const self of agents) {
    const base = path.join(LAWBOR_TMP, 'fuzz-' + '-' + seed + '-' + self.slice(2, 6));
    files.push(base + '.jsonl', base + '.control');
    const store = createStore(base + '.jsonl', base + '.control');
    const send = async (to, env) => { const t = registry[lower(to)]; if (t) await t.receive(env); };
    nodes[lower(self)] = createNode({ self, human: 'h', preflight, allowUnauthenticated: true, send, store });
  }
  for (const a of agents) registry[lower(a)] = nodes[lower(a)];
  const cleanup = () => { for (const f of files) { try { fs.unlinkSync(f); } catch {} } };

  const jobIds = ['j0', 'j1', 'j2', 'j3'];
  const deleted = {};                                        // self → Set of ids this node has tombstoned
  for (const a of agents) deleted[lower(a)] = new Set();
  const trace = [];
  const fail = (round, action, detail) => { cleanup(); return { failed: true, seed, round, action, detail, scores: score }; };

  for (let round = 0; round < actions; round++) {
    const A = pick(r, agents), B = pick(r, agents.filter((x) => x !== A));
    const na = nodes[lower(A)];
    const act = pick(r, ['say', 'say', 'say', 'bot', 'job', 'job', 'job-dep', 'bid', 'award', 'block', 'block', 'unblock', 'accept', 'delete', 'compact']);
    let label = act + ' ' + A.slice(2, 6) + '->' + B.slice(2, 6);
    try {
      if (act === 'say') { const s = await na.say(B, 'm' + round); if (s.sign.signed !== false) return fail(round, label, 'I5: a say returned signed:true'); }
      else if (act === 'bot') { const s = await na.botSay(B, 'b' + round); if (s.sign.signed !== false) return fail(round, label, 'I5: a botSay returned signed:true'); }
      else if (act === 'job') { const jid = pick(r, jobIds); await na.say(B, buildWork('help_wanted', { jobId: jid, task: 't' })); label += ' ' + jid; }
      else if (act === 'job-dep') { const jid = pick(r, jobIds); const deps = jobIds.filter((d) => d !== jid && r() < 0.5); await na.say(B, buildWork('help_wanted', { jobId: jid, task: 't', dependsOn: deps })); label += ' ' + jid + '[' + deps.join(',') + ']'; }
      else if (act === 'bid') { const jid = pick(r, jobIds); await na.say(B, buildWork('bid', { jobId: jid, price: '1' })); label += ' ' + jid; }
      else if (act === 'award') { const jid = pick(r, jobIds); await na.say(B, buildWork('award', { jobId: jid, worker: B, price: '1' })); label += ' ' + jid; }
      else if (act === 'block') na.block(B);
      else if (act === 'unblock') na.unblock(B);
      else if (act === 'accept') na.accept(B);
      else if (act === 'delete') { const mine = na.store.all(); if (mine.length) { const v = pick(r, mine); if (na.deleteMsg(v.id).ok) deleted[lower(A)].add(v.id); label += ' ' + v.id.slice(0, 6); } }
      else if (act === 'compact') {
        // I10 fold-preservation, checked inline: compaction may not change a single job
        const before = JSON.stringify(jobsFrom(na.store.all()));
        na.compact();
        if (JSON.stringify(jobsFrom(na.store.all())) !== before) return fail(round, label, 'I10: compact() changed the jobs fold on ' + A.slice(2, 6));
      }
    } catch (e) {
      return fail(round, label, 'threw: ' + e.message);
    }
    trace.push({ round, action: label });

    // ---- invariants over EVERY node, after every action -------------------------------------
    for (const self of agents) {
      const n = nodes[lower(self)];
      const s = self;
      const all = n.store.all();
      const allIds = new Set(all.map((m) => m.id));
      // I1 reputation floor: no stored INBOUND message from a sub-floor sender
      for (const m of all) if (m.dir === 'in' && (score[lower(m.from)] ?? 0) < FLOOR) return fail(round, label, 'I1: node ' + s.slice(2, 6) + ' stored inbound from sub-floor ' + m.from.slice(2, 6) + ' (score ' + score[lower(m.from)] + ')');
      const { blocked } = n.store.control();
      // I2 block is total: a blocked addr appears in NO view
      const inbox = n.store.inbox(s), reqs = n.store.requests(s);
      const peersIn = (th) => th.flatMap((t) => t.peers.map(lower));
      for (const x of blocked) {
        if (peersIn(inbox).includes(x)) return fail(round, label, 'I2: blocked ' + x.slice(2, 6) + ' in inbox of ' + s.slice(2, 6));
        if (peersIn(reqs).includes(x)) return fail(round, label, 'I2: blocked ' + x.slice(2, 6) + ' in requests of ' + s.slice(2, 6));
      }
      const jobs = jobsFrom(all.filter((m) => !blocked.has(lower(m.from))));
      for (const j of jobs) {
        if (blocked.has(lower(j.requester))) return fail(round, label, 'I2: blocked requester in jobs of ' + s.slice(2, 6));
        for (const b of j.bids) if (blocked.has(lower(b.worker))) return fail(round, label, 'I2: blocked bidder in jobs of ' + s.slice(2, 6));
        // I4 no self-bid
        if (j.bids.some((b) => lower(b.worker) === lower(j.requester))) return fail(round, label, 'I4: a job carries a bid from its own requester');
      }
      // I3 inbox ∩ requests = ∅
      const inboxT = new Set(inbox.map((t) => t.thread));
      for (const t of reqs) if (inboxT.has(t.thread)) return fail(round, label, 'I3: thread ' + t.thread.slice(0, 8) + ' in BOTH inbox and requests of ' + s.slice(2, 6));
      // I8 dependency readiness soundness: ready IFF every dep is awarded; blockedBy is EXACTLY the unmet set
      const fold = foldThread(all);
      for (const j of fold.values()) {
        const unmet = j.dependsOn.filter((d) => { const up = fold.get(d); return !up || up.state !== 'awarded'; });
        if (j.ready !== (unmet.length === 0)) return fail(round, label, 'I8: ready flag disagrees with deps on ' + j.jobId + ' @' + s.slice(2, 6));
        if (JSON.stringify([...j.blockedBy].sort()) !== JSON.stringify(unmet.sort())) return fail(round, label, 'I8: blockedBy != unmet deps on ' + j.jobId + ' @' + s.slice(2, 6));
      }
      // I9 delete stickiness: a tombstoned id never reappears in the store (even after redelivery/compact)
      for (const id of deleted[lower(s)]) if (allIds.has(id)) return fail(round, label, 'I9: deleted id ' + id.slice(0, 6) + ' reappeared on ' + s.slice(2, 6));
    }

    // I6 jobs fold is order-independent — check occasionally (a shuffle + re-fold is the cost)
    if (round % 7 === 0) {
      for (const self of agents) {
        const all = nodes[lower(self)].store.all();
        const a = JSON.stringify(jobsFrom(all));
        const b = JSON.stringify(jobsFrom(shuffle(r, all)));
        if (a !== b) return fail(round, label, 'I6: jobs fold not order-independent on ' + self.slice(2, 6));
      }
    }
  }

  // I7 reputation ≠ consent: pick a sub-floor addr, accept it, it still cannot be stored
  const subFloor = agents.find((a) => (score[lower(a)] ?? 0) < FLOOR);
  if (subFloor) {
    const victim = agents.find((a) => a !== subFloor);
    const nv = nodes[lower(victim)];
    nv.accept(subFloor);
    const before = nv.store.all().length;
    await nodes[lower(subFloor)].say(victim, 'accepted but sub-floor');
    if (nv.store.all().length !== before) { cleanup(); return { failed: true, seed, round: actions, action: 'I7 probe', detail: 'I7: accepting a sub-floor address let their message in — reputation must beat consent', scores: score }; }
  }

  cleanup();
  return { failed: false, seed, agents: N, trace };
}

// ---- the runner: budget by time or count, report + reproduce ------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const minutes = Number(val('--minutes', 0));
  const scenarios = Number(val('--scenarios', minutes ? 1e9 : 300));
  const perScenario = Number(val('--actions', 25));
  const fixedSeed = args.includes('--seed') ? Number(val('--seed')) : null;
  const traceOut = val('--trace', null);
  const deadline = minutes ? Date.now() + minutes * 60000 : Infinity;

  console.log('LAWBOR fuzzer — random histories, invariants that must always hold');
  console.log((minutes ? 'budget ' + minutes + ' min' : scenarios + ' scenarios') + ' · ' + perScenario + ' actions each · floor ' + FLOOR + '\n');

  if (fixedSeed !== null) { const res = await scenario(fixedSeed, perScenario); console.log(res.failed ? 'FAILED @round ' + res.round + ' [' + res.action + ']: ' + res.detail : 'seed ' + fixedSeed + ' OK (' + res.agents + ' agents, ' + res.trace.length + ' actions)'); process.exit(res.failed ? 1 : 0); }

  let ran = 0, actionsTotal = 0; const t0 = Date.now();
  let lastTraceOk = null;
  for (let i = 0; i < scenarios && Date.now() < deadline; i++) {
    const seed = 1000 + i;
    const res = await scenario(seed, perScenario);
    ran++; actionsTotal += perScenario;
    if (res.failed) {
      console.log('\n❌ INVARIANT BROKEN — reproduce with:  node sim/fuzz.js --seed ' + res.seed);
      console.log('   scenario ' + ran + ', round ' + res.round + ', action [' + res.action + ']');
      console.log('   ' + res.detail);
      console.log('   scores: ' + Object.entries(res.scores).map(([a, s]) => a.slice(2, 6) + ':' + s).join(' '));
      process.exit(1);
    }
    lastTraceOk = res;
    if (ran % 200 === 0) console.log('   ' + ran + ' scenarios · ' + actionsTotal + ' actions · ' + Math.round((Date.now() - t0) / 1000) + 's · 0 breaks');
  }
  if (traceOut && lastTraceOk) fs.writeFileSync(traceOut, JSON.stringify({ seed: lastTraceOk.seed, agents: lastTraceOk.agents, trace: lastTraceOk.trace }, null, 2));
  console.log('\n✅ ' + ran + ' scenarios · ' + actionsTotal + ' random actions · ' + Math.round((Date.now() - t0) / 1000) + 's · ZERO invariant breaks');
  console.log('   invariants held: reputation-floor · block-is-total · inbox∩requests=∅ · no-self-bid · descriptor-only · fold-order-independent · reputation≠consent · graph-readiness-sound · delete-sticky · compaction-fold-preserving');
  process.exit(0);
}

main().catch((e) => { console.error('fuzzer crashed:', e); process.exit(1); });
