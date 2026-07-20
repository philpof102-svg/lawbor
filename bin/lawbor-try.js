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
        const r = await sendWork(buildWork('confirm', { jobId: args[0], amountMicro: args[1] }), args[0]);
        const j = (await get('/jobs')).jobs.find((x) => x.jobId === args[0]);
        return out({ action: r.body.action, agreedPrice: (j && j.agreedPrice) || null, note: (j && j.agreedPrice && j.agreedPrice.accepted) ? 'LOCKED — the deal is sealed' : 'not locked yet (you must be the offer owner and the amount must match the agreed price)' });
      }
      default:
        console.log('lawbor-try — zero-config LAWBOR trial (throwaway identity, no funds).\n' +
          'Commands: whoami · bazaar · offer <item> [priceHint] · quote <jobId> <amountMicro> · confirm <jobId> <amountMicro> · jobs · thread <jobId> · peer <0xaddr>\n' +
          'Your address: ' + self + '   Node: ' + NODE);
    }
  } catch (e) { console.error('error: ' + (e && e.message)); process.exit(1); }
})();
