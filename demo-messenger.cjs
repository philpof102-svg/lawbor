'use strict';
/* TWO-NODE MESSENGER DEMO — the actual product, running.
 * ============================================================================================
 * Starts two independent LAWBOR nodes on loopback, each with its own store, its own human, and its own
 * messenger UI. They peer with each other, and that is the whole point: there is no server in the
 * middle. Phil's node relays to Bob's node; Bob's bot reputation-gates the sender before his human
 * ever sees the message.
 *
 *   node demo-messenger.cjs
 *     Phil → http://localhost:4830/app/messenger/
 *     Bob  → http://localhost:4831/app/messenger/
 *
 * Try it: from Phil's node, write to Bob's address (printed below). It lands in Bob's REQUESTS tab
 * (first contact is quarantined), not his inbox. Accept it there and the thread moves to the Inbox.
 * Everything is testnet-shaped play: no key is held, /say returns a descriptor with signed:false.
 */
const path = require('path');
const fs = require('fs');
const { build } = require('./server');
const { createStore } = require('./lib/store');

const PHIL = '0x' + '11'.repeat(20);
const BOB  = '0x' + '22'.repeat(20);
const SCORE = { [PHIL.toLowerCase()]: 90, [BOB.toLowerCase()]: 85 };
const preflight = async (a) => ({ decision: 'PROCEED', score: SCORE[String(a).toLowerCase()] ?? 0 });

const APPS = [require('./apps/messenger'), require('./apps/orggraph'), require('./apps/standup')];

function node(self, human, port) {
  const base = path.join(__dirname, 'data', 'demo-msg-' + human);
  for (const f of [base + '.jsonl', base + '.control', base + '.subs']) { try { fs.unlinkSync(f); } catch {} }
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const store = createStore(base + '.jsonl', base + '.control');
  const b = build({ self, human, preflight, store, apps: APPS,
    allowLoopback: true, allowInsecure: true, allowUnauthenticated: true });
  return { b, port, self, human };
}

(async () => {
  const a = node(PHIL, 'Phil', 4830);
  const b = node(BOB, 'Bob', 4831);
  for (const n of [a, b]) await new Promise((r) => n.b.server.listen(n.port, r));

  // peer them to each other — reputation-gated admission, no central server
  const peer = (from, to) => fetch('http://localhost:' + from.port + '/peers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ addr: to.self, url: 'http://localhost:' + to.port }),
  }).then((r) => r.json());
  console.log('peering:', JSON.stringify(await peer(a, b)).slice(0, 60));
  await peer(b, a);

  // AUTOPILOT — each node's bot works the job graph on its own (lib/autopilot.js). Post a job from the
  // messenger and the OTHER bot bids for itself; the requester's bot then awards the cheapest bid. Both
  // speak as the BOT, so the negotiation shows up in "Watch my bot" — nothing signs, nothing settles.
  if (process.env.LAWBOR_AUTOPILOT !== '0') {
    const { tick } = require('./lib/autopilot');
    const policy = { maxOpenBids: 3, minBidsBeforeAward: 1, maxPrice: 100, maxActionsPerTick: 2 };
    setInterval(async () => {
      for (const n of [a, b]) {
        try {
          const did = await tick(n.b.node, { ...policy, bidPrice: n.human === 'Bob' ? 18 : 25 });
          for (const d of did) console.log(`  🤖 ${n.human}'s bot ${d.kind} ${d.jobId}${d.price ? ' @ ' + d.price : ''} (signed:${d.signed})`);
        } catch {}
      }
    }, 3000).unref();
  }

  console.log('\n  TWO LAWBOR NODES UP — no server in the middle\n');
  console.log('  Phil  http://localhost:4830/app/messenger/   (his address ' + PHIL + ')');
  console.log('  Bob   http://localhost:4831/app/messenger/   (his address ' + BOB + ')');
  console.log('\n  From Phil\'s messenger, paste BOB\'s address above and send.');
  console.log('  It lands in Bob\'s REQUESTS tab (first contact is quarantined) — accept it there.\n');
})().catch((e) => { console.error('demo failed:', e); process.exit(1); });
