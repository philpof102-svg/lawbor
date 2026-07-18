'use strict';
/**
 * LAWBOR — server.js  (the bot's HTTP surface: the human's two views + the decentralized peer transport)
 * ========================================================================================================
 * One bot node behind HTTP. A HUMAN app (Telegram-shaped) hits the read/write routes; PEER bots hit
 * /lawbor/accept to relay. Peers are discovered by /.well-known/lawbor.json (addr + url + min-score).
 *
 * Routes:
 *   GET  /health                      → ok + self addr + peer count
 *   GET  /.well-known/lawbor.json      → this bot's discovery card (addr, accept url, minScore)
 *   POST /say            {to, body}    → the HUMAN sends through their bot (built + relayed)
 *   POST /bot/say        {to, body}    → the bot speaks autonomously (shows in the watch feed)
 *   GET  /inbox                        → VIEW 1: the human's conversations
 *   GET  /bot-activity                 → VIEW 2: what the bot is autonomously discussing
 *   GET  /thread?id=…                  → the messages of one thread (either view)
 *   POST /lawbor/accept  {envelope}    → a PEER relays an envelope to us (reputation-gated inside)
 *   POST /peers          {addr, url}   → register a peer (addr→url routing for the transport)
 *
 * 🛑 No keys, no autonomous send of money. Envelopes carry a descriptor to sign; the operator signs.
 *   Reputation gate + fail-closed live in the relay. MainStreet preflight is the injectable oracle.
 */
const http = require('http');
const { createNode } = require('./lib/node');
const { createStore } = require('./lib/store');

const SELF = process.env.LAWBOR_ADDR || '0x0000000000000000000000000000000000000000';
const MAINSTREET_URL = (process.env.MAINSTREET_URL || 'https://avisradar-production.up.railway.app').replace(/\/$/, '');
const MIN_SCORE = Number(process.env.LAWBOR_MIN_SCORE || 40);

async function mainstreetPreflight(addr) {
  const r = await fetch(MAINSTREET_URL + '/api/agent/preflight/' + encodeURIComponent(addr), { headers: { 'x-ms-monitor': '1' } });
  if (!r.ok) throw new Error('preflight HTTP ' + r.status);
  return r.json();
}

/** Build the server. deps.preflight / deps.fetch injectable for tests (no network). */
function build(deps = {}) {
  const peers = new Map();                              // addr(lower) → url  (the transport routing table)
  const store = deps.store || createStore();
  const doFetch = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const send = async (toAddr, env) => {                 // transport: POST the envelope to the peer's accept url
    const url = peers.get(String(toAddr).toLowerCase());
    if (!url || !doFetch) return;                       // unknown peer → drop (dedup makes a later resend safe)
    await doFetch(url.replace(/\/$/, '') + '/lawbor/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: env }) });
  };
  // Signature verification is injected (node ships no ecrecover/keccak, and LAWBOR has zero deps).
  // With neither a verifier nor the explicit opt-in, the relay refuses inbound envelopes rather than
  // scoring an address the sender merely typed. See lib/relay.js::authenticate.
  const allowUnauthenticated = deps.allowUnauthenticated !== undefined
    ? deps.allowUnauthenticated : process.env.LAWBOR_ALLOW_UNAUTHENTICATED === '1';
  const node = createNode({ self: deps.self || SELF, human: deps.human || process.env.LAWBOR_HUMAN || null,
    preflight: deps.preflight || mainstreetPreflight, minScore: deps.minScore || MIN_SCORE, send, store,
    verifySig: deps.verifySig, allowUnauthenticated });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r(null); } }); });

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    try {
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, self: node.self, peers: node.peers().length, authenticatesSenders: node.relay.authenticates });
      if (req.method === 'GET' && url === '/.well-known/lawbor.json') return json(res, 200, { v: 1, addr: node.self, accept: '/lawbor/accept', minScore: MIN_SCORE, oracle: 'MainStreet', note: 'reputation-gated bot messaging' });

      if (req.method === 'POST' && url === '/peers') { const a = await body(req) || {}; if (!a.addr || !a.url) return json(res, 400, { error: 'addr + url required' }); peers.set(String(a.addr).toLowerCase(), a.url); node.addPeer(a.addr); return json(res, 200, { peers: node.peers() }); }

      if (req.method === 'POST' && url === '/say') { const a = await body(req) || {}; if (!a.to || !a.body) return json(res, 400, { error: 'to + body required' }); const r = await node.say(a.to, a.body, { thread: a.thread }); return json(res, 200, { id: r.envelope.id, thread: r.envelope.thread, delivered: r.delivered, sign: r.sign, reason: r.reason }); }
      if (req.method === 'POST' && url === '/bot/say') { const a = await body(req) || {}; if (!a.to || !a.body) return json(res, 400, { error: 'to + body required' }); const r = await node.botSay(a.to, a.body, { thread: a.thread }); return json(res, 200, { id: r.envelope.id, delivered: r.delivered }); }

      if (req.method === 'GET' && url === '/inbox') return json(res, 200, { view: 'inbox', threads: store.inbox(node.self, Number(q.get('limit')) || 50) });
      if (req.method === 'GET' && url === '/bot-activity') return json(res, 200, { view: 'bot-activity', threads: store.botActivity(node.self, Number(q.get('limit')) || 50) });
      if (req.method === 'GET' && url === '/thread') { const id = q.get('id'); if (!id) return json(res, 400, { error: 'id required' }); return json(res, 200, { thread: id, messages: store.thread(id) }); }

      if (req.method === 'POST' && url === '/lawbor/accept') { const a = await body(req) || {}; if (!a.envelope) return json(res, 400, { error: 'envelope required' }); const r = await node.receive(a.envelope); return json(res, r.action === 'drop' ? 202 : 200, { action: r.action, reason: r.reason || null }); }

      // MCP over streamable-http, for clients that prefer a URL to a local process. NOTE: LAWBOR is
      // decentralized — this serves YOUR node only. Sharing one hosted node with strangers would hand
      // them your inbox and identity; the intended distribution is the stdio package (npx @lawbor/bot).
      if (req.method === 'POST' && url === '/mcp') {
        const msg = await body(req);
        if (!msg) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        const out = await mcpDispatch(msg, { node });
        return out ? json(res, 200, out) : res.writeHead(204, CORS) || res.end();   // notification → 204
      }
      if (req.method === 'GET' && url === '/.well-known/mcp.json') {
        const b = 'http' + (req.headers['x-forwarded-proto'] === 'https' ? 's' : '') + '://' + (req.headers.host || 'localhost');
        return json(res, 200, {
          name: 'lawbor', version: '0.1.0',
          description: 'Decentralized, reputation-gated messaging: every participant is a bot, humans talk through their own.',
          mcp: { transport: 'streamable-http', endpoint: b + '/mcp', stdio: 'npx -y @lawbor/bot' },
          tools: mcpTools.map((t) => ({ name: t.name, description: t.description })),
          safety: { descriptorOnly: true, signs: false, movesFunds: false, gate: 'MainStreet reputation preflight, fail-closed' },
          note: 'Run your OWN node (stdio) — a shared hosted node would centralize the network and expose your inbox.',
        });
      }

      return json(res, 404, { error: 'GET /health,/inbox,/bot-activity,/thread · POST /say,/bot/say,/lawbor/accept,/peers' });
    } catch (e) { return json(res, 500, { error: e.message }); }
  });
  return { server, node, peers };
}

module.exports = { build };
if (require.main === module) {
  const { server } = build();
  const PORT = Number(process.env.PORT || 4830);
  server.listen(PORT, () => {
    console.log('LAWBOR bot on :' + PORT + ' — self ' + SELF + ' — reputation-gated, descriptor-only. Set LAWBOR_ADDR + a signer to go live.');
    if (process.env.LAWBOR_ALLOW_UNAUTHENTICATED === '1') {
      console.warn('⚠️  LAWBOR_ALLOW_UNAUTHENTICATED=1 — inbound `from` is NOT verified. Anyone can claim a reputable address and inherit its score. Development only.');
    }
  });
}
