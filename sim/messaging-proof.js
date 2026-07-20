'use strict';
/**
 * LAWBOR — "does the MESSAGING side hold?"  (the twin of sim/reward-proof.js)
 * =========================================================================
 * The other half of LAWBOR is reputation-gated agent-to-agent + human messaging. This is one readable
 * run of the guarantees that make it safe at scale: a low-score stranger can't reach you, a block is
 * total and indistinguishable from silence, a newcomer may SPEAK but earns NO standing, spoofed
 * timestamps can't pin spam to the top, and a flood is bounded. Offline: preflight + transport are
 * injected (no network), each scenario gets an isolated store. Run: node sim/messaging-proof.js
 */
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
const assert = require('node:assert');
const { createNode: makeNode } = require('../lib/node');
const { createStore } = require('../lib/store');
const { buildEnvelope } = require('../lib/envelope');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lawbor-msg-'));
let n = 0;
const freshStore = () => createStore(path.join(TMP, 's' + (++n) + '.jsonl'), path.join(TMP, 'c' + n + '.control'));
const A = '0x' + 'aa'.repeat(20);   // us
const B = '0x' + 'bb'.repeat(20);   // a peer / sender
const send = async () => {};        // transport stub (we test admission, not delivery)
// these scenarios predate signing; exercise the admission path with allowUnauthenticated
const node = (cfg) => makeNode({ self: A, allowUnauthenticated: true, send, ...cfg });
// ts is passed INTO buildEnvelope so the envelope id stays consistent (mutating ts after seals a
// tampered id, which validateEnvelope correctly rejects — a spoofer must build a CONSISTENT envelope).
const env = (from, to, body, extra = {}) => buildEnvelope({ from, to, body, viaHuman: extra.viaHuman, ts: extra.ts }).envelope;

const GOOD = async () => ({ decision: 'PROCEED', score: 70 });   // reputable
const LOW  = async () => ({ decision: 'PROCEED', score: 5 });    // below the floor
const DOWN = async () => { throw new Error('oracle unreachable'); };

let ok = 0, bad = 0;
const check = (cond, label) => { if (cond) { ok++; console.log('  ' + label); } else { bad++; console.log('  ✗ FAILED: ' + label); } };

(async () => {
  console.log('\nLAWBOR — proof the messaging side HOLDS');
  console.log('=======================================');

  // 1 — reputation gate: a low-score stranger never reaches you, and is never even stored
  console.log('\n1 · reputation gate (a low-score stranger cannot reach you)');
  {
    const nGood = node({ preflight: GOOD, store: freshStore() });
    const r1 = await nGood.receive(env(B, A, 'gm, from a reputable peer', { viaHuman: 'bob' }));
    check(r1.action === 'deliver', `✅ score 70 (≥ floor) → ${r1.action} (a reputable peer gets through)`);

    const nLow = node({ preflight: LOW, store: freshStore() });
    const r2 = await nLow.receive(env(B, A, 'spam', { viaHuman: 'x' }));
    check(r2.action === 'drop' && nLow.store.all().length === 0, `❌ score 5 (< floor) → ${r2.action}, and 0 rows stored (never even written)`);
  }

  // 2 — block = total silence, indistinguishable from nothing
  console.log('\n2 · a block is TOTAL and looks like silence');
  {
    const nb = node({ preflight: GOOD, store: freshStore() });
    await nb.receive(env(B, A, 'first msg', { viaHuman: 'bob' }));
    const before = nb.store.all().length;
    nb.block(B);
    const human = await nb.receive(env(B, A, 'let me back in', { viaHuman: 'bob' }));   // human-authored
    const botspam = await nb.receive(env(B, A, 'or i sneak in as a bot job'));           // bot-origin, no viaHuman
    check(human.action === 'drop' && human.reason === 'blocked', `❌ blocked human msg → ${human.action} (${human.reason})`);
    check(botspam.action === 'drop', `❌ blocked sender switching to bot/job origin → ${botspam.action} (a block is TOTAL, every surface)`);
    check(nb.store.all().length === before, `✅ nothing new stored after the block, and no delivery receipt leaks — a block == silence`);
  }

  // 3 — probation: a newcomer may SPEAK, but is flagged and holds no standing (admitted != trusted)
  console.log('\n3 · a newcomer may speak, but earns NO standing (admitted != trusted)');
  {
    const np = node({ preflight: DOWN, admitProbation: true, store: freshStore() });
    const r = await np.receive(env(B, A, 'hello, i am brand new here', { viaHuman: 'newbie' }));
    const rowP = np.store.all()[0];
    check(r.action === 'deliver', `✅ oracle down + probation → ${r.action} (a stranger CAN speak, so the network is reachable)`);
    check(rowP && rowP.probation === true && (rowP.senderScore === 0 || rowP.senderScore == null), `✅ but the stored row is probation=true, score 0 — no read view can render them as vouched-for`);
  }

  // 4 — anti-spoof ordering: a sender-chosen timestamp cannot pin spam to the top
  console.log('\n4 · a spoofed timestamp cannot pin spam to the top');
  {
    const ns = node({ preflight: GOOD, store: freshStore() });
    await ns.receive(env(B, A, 'an honest, normal message', { viaHuman: 'bob' }));
    const future = 9999999999;   // sender claims year 2286
    await ns.receive(env(B, A, 'SPAM dated far in the future', { viaHuman: 'bob', ts: future }));
    const rows = ns.store.all();
    const spamRow = rows.find((m) => m.body.includes('SPAM'));
    check(spamRow && Number(spamRow.ts) === future, `✅ the spammer's claimed ts (${future}) is preserved for display…`);
    check(spamRow && spamRow.rxAt < future * 1000, `✅ …but ordering uses rxAt (OUR clock, ${spamRow.rxAt}) — the future ts buys no position`);
  }

  // 5 — rate-limit: a flood from one sender is bounded per window, even if reputable
  console.log('\n5 · a flood is bounded (rate-limit, even for a reputable sender)');
  {
    const CAP = 3;
    const nr = node({ preflight: GOOD, maxInbound: CAP, rateWindowMs: 60_000, store: freshStore() });
    let delivered = 0, dropped = 0;
    for (let i = 0; i < 8; i++) {
      const r = await nr.receive(env(B, A, 'flood #' + i, { viaHuman: 'bob' }));
      if (r.action === 'deliver') delivered++; else dropped++;
    }
    check(delivered === CAP && dropped === 8 - CAP, `✅ 8 messages, cap ${CAP}/window → ${delivered} stored, ${dropped} rate-limited (a flood cannot fill the store)`);
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`VERDICT: ${bad === 0 ? 'HOLDS' : 'BROKEN'} — a low-score stranger can't reach you, a block is total and silent,`);
  console.log('a newcomer speaks but earns nothing, spoofed time buys no position, and floods are bounded.');
  console.log(`\n${ok} checks passed · ${bad} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(bad ? 1 : 0);
})();
