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

/* SIMULATED chain, OFF unless LAWBOR_DEMO_CHAIN=1 — and loudly labelled when on.
 * Faking a chain in a demo is a real anti-hype hazard: someone runs it, sees "✓ verified on Base", and
 * believes a payment happened. So the DEFAULT is no reader at all, which is honest — settle claims stay
 * unverified and the messenger says in plain words that this node cannot verify payments. Turning it on
 * is a deliberate act that prints a warning. It exists so the full lifecycle can be SEEN end to end
 * without spending real USDC; it is not evidence of anything. */
const demoChain = process.env.LAWBOR_DEMO_CHAIN === '1' ? (() => {
  const { createChainReader, USDC_BASE, TRANSFER_TOPIC } = require('./lib/chain');
  const txs = new Map(); let head = 1000;
  const reader = createChainReader({ rpcUrl: 'http://demo-not-a-real-chain', fetch: async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    const R = (r) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', result: r }) });
    const hx = (x) => '0x' + x.toString(16);
    if (method === 'eth_chainId') return R(hx(8453));
    if (method === 'eth_blockNumber') return R(hx(head));
    if (method === 'eth_getBlockByNumber') return R({ timestamp: hx(1700000000) });
    if (method === 'eth_getTransactionReceipt') {
      const t = txs.get(params[0]); if (!t) return R(null);
      const tp = (a) => '0x' + '0'.repeat(24) + a.slice(2);
      return R({ status: '0x1', blockNumber: hx(t.block), logs: [{ address: USDC_BASE, topics: [TRANSFER_TOPIC, tp(t.from), tp(t.to)], data: hx(BigInt(t.micro)) }] });
    }
    return R(null);
  } });
  reader.demoPay = (from, to, micro) => { const h = '0x' + String(txs.size + 1).padStart(64, '0'); head += 20; txs.set(h, { from: from.toLowerCase(), to: to.toLowerCase(), micro: String(micro), block: head - 15 }); return h; };
  return reader;
})() : undefined;

function node(self, human, port) {
  const base = path.join(__dirname, 'data', 'demo-msg-' + human);
  for (const f of [base + '.jsonl', base + '.control', base + '.subs', base + '.txfacts']) { try { fs.unlinkSync(f); } catch {} }
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const store = createStore(base + '.jsonl', base + '.control');
  const b = build({ self, human, preflight, store, apps: APPS, chain: demoChain, txFactsFile: base + '.txfacts',
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
    const { creditFor } = require('./lib/credit');
    const policy = { maxOpenBids: 3, minBidsBeforeAward: 1, maxPrice: 100, maxActionsPerTick: 2,
      // a stranger is served, just dearer — never refused, or a cold-start node could never begin
      unknownRequesterPremium: 1.4, provenWorkerTolerance: 0.15 };
    setInterval(async () => {
      for (const n of [a, b]) {
        try {
          // THE LOOP, actually running: settled payments -> this bot's own credit view -> the price it
          // quotes and the worker it picks. Fetched through the real route, not a shortcut.
          const cr = await fetch('http://localhost:' + n.port + '/credit').then((r) => r.json()).catch(() => null);
          const credit = new Map((cr && cr.direct || []).map((x) => [x.addr, Number(x.usdcMicro)]));   // whom WE paid (award side)
          const inbound = new Map((cr && cr.inbound || []).map((x) => [x.addr, Number(x.usdcMicro)])); // who paid US (bid side)
          const did = await tick(n.b.node, { ...policy, credit, inbound, bidPrice: n.human === 'Bob' ? 18 : 25 });
          for (const d of did) console.log(`  🤖 ${n.human}'s bot ${d.kind} ${d.jobId}${d.price ? ' @ ' + d.price : ''}${d.basis ? '  [' + d.basis + ']' : ''}`);

          /* PAYING IS NOT THE BOT'S DECISION — which is why this lives outside tick() and outside
           * lib/autopilot.js entirely. In reality a human sends the USDC from their own wallet and
           * then attaches the tx ("I paid this" in the messenger). Here, and ONLY on the simulated
           * chain, the demo performs that human step so the loop can be watched end to end. */
          if (demoChain) {
            const jobs = await fetch('http://localhost:' + n.port + '/jobs').then((r) => r.json()).catch(() => ({ jobs: [] }));
            for (const j of (jobs.jobs || []).filter((x) => x.state === 'awarded' && x.requester === n.self.toLowerCase())) {
              const micro = String(Math.round(parseFloat(String(j.award.price).replace(/[^\d.]/g, '')) * 1e6));
              if (!/^\d+$/.test(micro) || micro === '0') continue;
              const txHash = demoChain.demoPay(n.self, j.award.worker, micro);
              const r = await fetch('http://localhost:' + n.port + '/work', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ to: j.award.worker, kind: 'settle', jobId: j.jobId, txHash, amountMicro: micro, thread: j.thread }) }).then((x) => x.json());
              console.log(`  💵 ${n.human} (the HUMAN step, simulated) paid ${j.jobId} — verified:${r.settled && r.settled.verified}`);
            }
          }
        } catch {}
      }
    }, 3000).unref();
  }

  console.log('\n  TWO LAWBOR NODES UP — no server in the middle\n');
  if (demoChain) {
    console.log('  ⚠️  LAWBOR_DEMO_CHAIN=1 — settlements are verified against a SIMULATED chain.');
    console.log('      Nothing here touched Base and no USDC moved. Any "✓ verified" you see is theatre,');
    console.log('      shown so the full job→pay→rating loop can be watched without spending money.\n');
  } else {
    console.log('  This demo has NO chain reader, so a settlement cannot verify and nobody shows standing.');
    console.log('  That is the honest default. Run with LAWBOR_DEMO_CHAIN=1 to watch the loop on a fake chain,');
    console.log('  or set LAWBOR_RPC_URL to a real Base RPC to verify real payments.\n');
  }
  console.log('  Phil  http://localhost:4830/app/messenger/   (his address ' + PHIL + ')');
  console.log('  Bob   http://localhost:4831/app/messenger/   (his address ' + BOB + ')');
  console.log('\n  From Phil\'s messenger, paste BOB\'s address above and send.');
  console.log('  It lands in Bob\'s REQUESTS tab (first contact is quarantined) — accept it there.\n');
})().catch((e) => { console.error('demo failed:', e); process.exit(1); });
