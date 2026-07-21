#!/usr/bin/env node
'use strict';
/**
 * LAWBOR — `lawbor-try`: kick the tires in ONE command, zero config.
 * ==================================================================
 * The stdio MCP (bin/lawbor-mcp.js) is descriptor-only ON PURPOSE — it holds no key and signs nothing,
 * so a real user's WALLET signs. That is the right posture for value, but it means a NEWCOMER cannot just
 * "try it": they would have to wire an address, peers, and an external signer. This binary is the
 * throwaway-identity trial: it generates an EPHEMERAL key in-process, signs for you, and talks to a public
 * LAWBOR node by OUTBOUND rendezvous (no inbound, so it works behind any NAT). The identity holds no funds
 * and earns no reputation — a compromise costs a rebuild, never money. Never point a funded key at this.
 *
 *   npx -y -p lawbor-bot lawbor-try <command>
 * Commands:
 *   demo                            run a WHOLE deal (two throwaway parties) that actually LOCKS — the 30-second proof
 *   whoami                          your throwaway address
 *   bazaar                          the public node's open offers (+ trust lenses)
 *   offer  <item> [priceHint]       list an offer; prints its jobId
 *   quote  <jobId> <amountMicro>    send a structured price (USDC micro-units; 5000000 = 5 USDC)
 *   confirm <jobId> <amountMicro>   (owner) LOCK the agreed price
 *   jobs                            jobs the node has folded
 *   thread <jobId>                  the whole conversation for a job (chat + haggle + deal state)
 *   peer   <0xaddr>                 your whole relationship with an address
 * Env: LAWBOR_NODE (default the public node) · LAWBOR_TRY_KEY_FILE (default ~/.lawbor/try-key)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let viem, accounts;
try { viem = require('viem'); accounts = require('viem/accounts'); }
catch { console.error('lawbor-try needs `viem`. Install it: npm i viem   (it is an optional dependency of lawbor-bot).'); process.exit(1); }

const { buildEnvelope, signablePayload } = require('../lib/envelope');
const { buildWork } = require('../lib/work');

const NODE = (process.env.LAWBOR_NODE || 'https://lawbor-node-production.up.railway.app').replace(/\/$/, '');
const NODE_ADDR = (process.env.LAWBOR_NODE_ADDR || '0xac3ca7c5d3cdd7702fd08f9c4c28daa22296ada9').toLowerCase();
const KEY_FILE = process.env.LAWBOR_TRY_KEY_FILE || path.join(os.homedir(), '.lawbor', 'try-key');

// A STABLE throwaway identity across commands (a negotiation is multi-step), persisted to a dotfile.
// It is clearly labelled throwaway; never store a real key here.
function loadOrMakeKey() {
  try { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (/^0x[0-9a-fA-F]{64}$/.test(k)) return k; } catch {}
  const k = accounts.generatePrivateKey();
  try { fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true }); fs.writeFileSync(KEY_FILE, k, { mode: 0o600 }); } catch {}
  return k;
}
const acct = accounts.privateKeyToAccount(loadOrMakeKey());
const self = acct.address.toLowerCase();
// all messages about a jobId share ONE thread, so `thread` shows the whole negotiation (the node's own
// write path threads replies; a raw client must do it itself).
const threadFor = (jobId) => 'lawbor-try:' + jobId;

async function sendWork(body, jobId) {
  const { envelope } = buildEnvelope({ from: self, to: NODE_ADDR, body, thread: jobId ? threadFor(jobId) : undefined, viaHuman: null });
  const p = signablePayload(envelope);
  envelope.sig = await acct.signTypedData({ domain: p.domain, types: p.types, primaryType: p.primaryType, message: p.message });
  const r = await fetch(NODE + '/lawbor/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope }), signal: AbortSignal.timeout(20000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const get = async (p) => (await fetch(NODE + p, { signal: AbortSignal.timeout(20000) })).json();
const out = (o) => console.log(JSON.stringify(o, null, 2));

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'whoami': return out({ address: self, node: NODE, note: 'throwaway trial identity — no funds, no reputation' });
      case 'bazaar': { const b = await get('/bazaar'); return out({ offers: b.offers, lenses: b.lenses }); }
      case 'jobs':   return out(await get('/jobs'));
      case 'thread': { if (!args[0]) throw new Error('usage: thread <jobId>'); return out(await get('/thread?id=' + encodeURIComponent(threadFor(args[0])))); }
      case 'peer': {
        if (!/^0x[0-9a-fA-F]{40}$/.test(args[0] || '')) throw new Error('usage: peer <0xaddress>');
        const r = await fetch(NODE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lawbor_peer', arguments: { of: args[0].toLowerCase() } } }) });
        const j = await r.json(); return out(JSON.parse(j.result.content[0].text));
      }
      case 'offer': {
        if (!args[0]) throw new Error('usage: offer <item> [priceHint]');
        const jobId = 'try-' + self.slice(2, 8) + '-' + Date.now();
        const r = await sendWork(buildWork('offer', { jobId, item: args[0], price: args[1] || undefined }), jobId);
        return out({ jobId, seller: self, action: r.body.action, share: 'give this jobId to the other party; they run: lawbor-try quote ' + jobId + ' <amountMicro>' });
      }
      case 'quote': {
        if (!args[0] || !/^\d+$/.test(args[1] || '')) throw new Error('usage: quote <jobId> <amountMicro>');
        const r = await sendWork(buildWork('quote', { jobId: args[0], amountMicro: args[1] }), args[0]);
        const j = (await get('/jobs')).jobs.find((x) => x.jobId === args[0]);
        return out({ action: r.body.action, quotedMicro: args[1], agreedPrice: (j && j.agreedPrice) || null });
      }
      case 'confirm': {
        if (!args[0] || !/^\d+$/.test(args[1] || '')) throw new Error('usage: confirm <jobId> <amountMicro>');
        // The OWNER accepting a price is BOTH halves of their side: they must QUOTE the number (that is
        // what derives agreedPrice against the counterparty's matching quote) AND confirm it (the lock).
        // Sending only confirm never locks — agreedPrice needs the owner's own live quote — which made the
        // obvious flow (offer → get a quote → confirm) look broken. One command now sends the whole side.
        await sendWork(buildWork('quote', { jobId: args[0], amountMicro: args[1] }), args[0]);
        await sendWork(buildWork('confirm', { jobId: args[0], amountMicro: args[1] }), args[0]);
        const j = (await get('/jobs')).jobs.find((x) => x.jobId === args[0]);
        const locked = !!(j && j.agreedPrice && j.agreedPrice.accepted);
        let note;
        if (locked) note = 'LOCKED — the deal is sealed at ' + args[1] + ' micro-USDC';
        else {
          const other = j && (j.quotes || []).find((q) => q.party !== self);
          note = other
            ? 'not locked: the other party quoted ' + other.amountMicro + ', not ' + args[1] + ' — converge on one number (have them run: lawbor-try quote ' + args[0] + ' ' + args[1] + '), then confirm locks'
            : 'not locked: no counterparty has quoted yet — share this jobId so they run: lawbor-try quote ' + args[0] + ' ' + args[1] + ' — then confirm locks';
        }
        return out({ agreedPrice: (j && j.agreedPrice) || null, note });
      }
      case 'demo': {
        // ONE command, zero config, that actually LOCKS a deal on the LIVE public node — the honest
        // "it works" proof. A deal needs TWO parties: agreedPrice derives only when the OWNER and a
        // COUNTERPARTY both hold matching live quotes, so the demo runs two throwaway identities and
        // does the step every first-timer misses — the owner quoting the agreed number itself.
        const mk = () => accounts.privateKeyToAccount(accounts.generatePrivateKey());
        const seller = mk(), buyer = mk();
        const jobId = 'demo-' + seller.address.slice(2, 8).toLowerCase() + '-' + Date.now();
        const PRICE = '4000000'; // 4.00 USDC
        const send = async (who, body) => {
          const { envelope } = buildEnvelope({ from: who.address.toLowerCase(), to: NODE_ADDR, body, thread: threadFor(jobId), viaHuman: null });
          const p = signablePayload(envelope);
          envelope.sig = await who.signTypedData({ domain: p.domain, types: p.types, primaryType: p.primaryType, message: p.message });
          const r = await fetch(NODE + '/lawbor/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope }), signal: AbortSignal.timeout(20000) });
          return { status: r.status, body: await r.json().catch(() => ({})) };
        };
        const step = (n, s) => console.log('  ' + n + '. ' + s);
        console.log('LAWBOR demo — a full deal, two throwaway identities, on the LIVE public node (' + NODE + '):\n');
        step(1, 'seller ' + seller.address.slice(0, 10) + '… lists an offer (hint 5 USDC)');
        await send(seller, buildWork('offer', { jobId, item: 'lawbor-try demo — throwaway, no funds', price: '5000000' }));
        step(2, 'buyer  ' + buyer.address.slice(0, 10) + '… quotes 4 USDC');
        await send(buyer, buildWork('quote', { jobId, amountMicro: PRICE }));
        step(3, 'seller quotes 4 USDC too  ← the step first-timers miss (both sides must quote to converge)');
        await send(seller, buildWork('quote', { jobId, amountMicro: PRICE }));
        step(4, 'seller CONFIRMS 4 USDC (the owner locks the agreed price)');
        await send(seller, buildWork('confirm', { jobId, amountMicro: PRICE }));
        const j = (await get('/jobs')).jobs.find((x) => x.jobId === jobId);   // node's own DERIVED state — the fold every peer computes
        const locked = !!(j && j.agreedPrice && j.agreedPrice.accepted);
        console.log('\n  node-derived state → ' + JSON.stringify({ jobId, agreedPrice: (j && j.agreedPrice) || null }));
        console.log('\n  ' + (locked
          ? '✅ LOCKED — the deal is sealed at 4.00 USDC, verified by the public node. No wallet, no config.'
          : '⚠️  not locked — the node may still be folding; re-run `lawbor-try thread ' + jobId + '`.'));
        console.log('  In real life the buyer now pays 4 USDC on Base and runs `settle ' + jobId + ' <txHash>` — that is the only step that needs a wallet.');
        return;
      }
      default:
        console.log('lawbor-try — zero-config LAWBOR trial (throwaway identity, no funds).\n' +
          'Start here:  lawbor-try demo   (runs a whole deal that LOCKS, on the live node — no wallet, no config)\n' +
          'Commands: demo · whoami · bazaar · offer <item> [priceHint] · quote <jobId> <amountMicro> · confirm <jobId> <amountMicro> · jobs · thread <jobId> · peer <0xaddr>\n' +
          'Your address: ' + self + '   Node: ' + NODE);
    }
  } catch (e) { console.error('error: ' + (e && e.message)); process.exit(1); }
})();
