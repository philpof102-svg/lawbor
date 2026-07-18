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
 *   POST /peers          {addr, url}   → operator peer admission — url policy, discovery-card match,
 *                                        reputation gate, first-write-wins, cap (via lib/mesh.js)
 *   POST /lawbor/offer   {from, peers} → a peer offers us PEERS (bounded per source, gated per candidate)
 *   GET  /lawbor/peers                 → a BOUNDED sample of ours in return (never the full table)
 *   POST /work           {to,kind,…}   → the three work verbs: help_wanted · bid · award · cancel
 *   GET  /jobs                         → jobs DERIVED from the message log (no separate job table)
 *
 * 🛑 No keys, no autonomous send of money. Envelopes carry a descriptor to sign; the operator signs.
 *   Reputation gate + fail-closed live in the relay. MainStreet preflight is the injectable oracle.
 */
const http = require('http');
const dns = require('dns').promises;
const { createNode } = require('./lib/node');
const { createStore } = require('./lib/store');
const { createMesh, isPrivateAddress, isLoopback } = require('./lib/mesh');
const beat = require('./lib/beat');
const work = require('./lib/work');
// The MCP surface. server.js advertised /mcp and /.well-known/mcp.json for weeks while BOTH returned
// 500 'mcpDispatch is not defined' — this module was never required. The suite missed it because
// test/mcp.test.js imports ../mcp directly and never went through the HTTP server. A machine-readable
// discovery card promising tools that 500 is the worst kind of false claim: it is aimed at agents.
const { dispatch: mcpDispatch, TOOLS: mcpTools } = require('./mcp');
const CORS = { 'access-control-allow-origin': '*' };

const SELF = process.env.LAWBOR_ADDR || '0x0000000000000000000000000000000000000000';
const MAINSTREET_URL = (process.env.MAINSTREET_URL || 'https://avisradar-production.up.railway.app').replace(/\/$/, '');
const MIN_SCORE = Number(process.env.LAWBOR_MIN_SCORE || 40);

/** LAWBOR_ANCHORS="0xabc…=https://a.example,0xdef…=https://b.example" → the operator's seed peers.
 *  No default seed ships: a hardcoded bootstrap node would quietly centralize the mesh. */
function parseAnchors(spec) {
  return String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return i === -1 ? null : { addr: pair.slice(0, i).trim(), url: pair.slice(i + 1).trim() };
  }).filter(Boolean);
}

async function mainstreetPreflight(addr) {
  const r = await fetch(MAINSTREET_URL + '/api/agent/preflight/' + encodeURIComponent(addr), { headers: { 'x-ms-monitor': '1' } });
  if (!r.ok) throw new Error('preflight HTTP ' + r.status);
  return r.json();
}

/**
 * Fetch a peer's discovery card — the network half of mesh admission.
 * ====================================================================
 * mesh.classifyUrl() is a STATIC parse: it cannot stop DNS rebinding and it cannot stop a redirect
 * chain, because one hop after the check the socket can land anywhere. Those are transport
 * properties, so they are enforced HERE:
 *   - resolve the hostname ourselves and re-apply isPrivateAddress() to every address it returns
 *   - redirect:'error' — a 302 must never be followed to an unchecked host
 *   - an abort timeout, so one hostile peer cannot hang admission forever
 *   - a response-size cap, so a peer cannot stream us out of memory
 * Honest limit: resolving then fetching is still two lookups. A determined rebinding attacker can
 * change the answer in between; closing that needs a connect-time lookup hook (undici Agent), which
 * would cost a dependency. This narrows the window, it does not eliminate it.
 */
const MAX_CARD_BYTES = 64 * 1024;
async function fetchDiscoveryCard(url, doFetch, opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // The loopback escape must reach here too: classifyUrl may have admitted 127.0.0.1 in development,
  // and re-refusing it at the socket would leave the mesh unusable locally for no security gain.
  const localOk = opts.allowLoopback === true && isLoopback(host);
  if (!localOk) {
    if (isPrivateAddress(host)) throw new Error('private address refused');
    const resolved = await dns.lookup(host, { all: true });
    for (const r of resolved) {
      if (isPrivateAddress(r.address)) throw new Error('host resolves inward (' + r.address + ') — refused');
    }
  }
  const res = await doFetch(u.origin + '/.well-known/lawbor.json', {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error('discovery card HTTP ' + res.status);
  const text = await res.text();
  if (text.length > MAX_CARD_BYTES) throw new Error('discovery card too large');
  return JSON.parse(text);
}

/** Build the server. deps.preflight / deps.fetch / deps.verify injectable for tests (no network). */
function build(deps = {}) {
  const store = deps.store || createStore();
  const doFetch = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const self = deps.self || SELF;
  // Development escape: loopback ONLY (never the rest of the private space — see lib/mesh.js).
  const allowLoopback = deps.allowLoopback !== undefined ? deps.allowLoopback : process.env.LAWBOR_ALLOW_LOOPBACK === '1';
  const allowInsecure = deps.allowInsecure !== undefined ? deps.allowInsecure : process.env.LAWBOR_ALLOW_INSECURE === '1';

  /* ONE peerbook. This used to be a bare `new Map()` here PLUS a Set inside relay.js, and the two
   * could disagree: relay said "forward", the transport had no url, the envelope silently vanished,
   * and the human was still told delivered:true. mesh.js now owns addr→url, the relay reads it
   * through peers(), and the transport resolves through urlFor() — they cannot drift. */
  const mesh = deps.mesh || createMesh({
    self,
    preflight: deps.preflight || mainstreetPreflight,
    verify: deps.verify || ((url) => fetchDiscoveryCard(url, doFetch, { allowLoopback })),
    minScore: deps.minScore || MIN_SCORE,
    anchors: parseAnchors(process.env.LAWBOR_ANCHORS),
    allowInsecure, allowLoopback,
  });

  const send = async (toAddr, env) => {                 // transport: POST the envelope to the peer's accept url
    const url = mesh.urlFor(String(toAddr).toLowerCase());
    if (!url || !doFetch) return;                       // unknown peer → drop (dedup makes a later resend safe)
    try {
      await doFetch(url.replace(/\/$/, '') + '/lawbor/accept', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope: env }),
        redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      mesh.noteContact(toAddr, true);
    } catch (e) {
      mesh.noteContact(toAddr, false);                  // FIRST-HAND liveness only — prune() acts on this
      throw e;
    }
  };
  // Signature verification is injected (node ships no ecrecover/keccak, and LAWBOR has zero deps).
  // With neither a verifier nor the explicit opt-in, the relay refuses inbound envelopes rather than
  // scoring an address the sender merely typed. See lib/relay.js::authenticate.
  const allowUnauthenticated = deps.allowUnauthenticated !== undefined
    ? deps.allowUnauthenticated : process.env.LAWBOR_ALLOW_UNAUTHENTICATED === '1';
  const node = createNode({ self, human: deps.human || process.env.LAWBOR_HUMAN || null,
    preflight: deps.preflight || mainstreetPreflight, minScore: deps.minScore || MIN_SCORE, send, store,
    verifySig: deps.verifySig, allowUnauthenticated,
    // the relay READS the mesh's book and delegates fan-out to it — it no longer keeps its own
    peers: () => mesh.addrs(),
    selectTargets: (to, opts) => mesh.selectTargets(to, opts) });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r(null); } }); });

  /**
   * The heartbeat — the loop that makes liveness and pruning actually happen.
   * ==========================================================================
   * mesh.js schedules nothing by design, so without this prune() was never called and dead peers
   * stayed in the book forever. Decisions come from lib/beat.js (pure, tested offline); this
   * function only owns the timer and the sockets.
   *
   * NOT started automatically: a library that silently opens sockets on require is a bad neighbour,
   * and the test suite would inherit a background timer. `lawbor-node` starts it; embedders opt in.
   */
  let beatTimer = null, tick = 0;
  function startHeartbeat(o = {}) {
    const intervalMs = Number(o.intervalMs || process.env.LAWBOR_BEAT_MS || 60_000);
    if (beatTimer) return;
    const run = async () => {
      tick++;
      try {
        const peers = mesh.addrs().map((a) => ({ addr: a, lastSeen: (mesh.record(a) || {}).lastSeen }));
        for (const addr of beat.dueFor(peers, Date.now(), { intervalMs, batch: o.batch || 4 })) {
          const url = mesh.urlFor(addr);
          if (!url) continue;
          try {
            const r = await doFetch(url.replace(/\/$/, '') + '/health',
              { redirect: 'error', signal: AbortSignal.timeout(5000) });
            mesh.noteContact(addr, r.ok);                 // FIRST-HAND only — a peer cannot mark another dead
          } catch { mesh.noteContact(addr, false); }
        }
        const gone = mesh.prune();
        if (gone.length) console.log('[lawbor] pruned ' + gone.length + ' unreachable peer(s)');

        // Peer exchange, deliberately stingy: one peer, every few ticks (it leaks the graph).
        const target = beat.offerTarget(mesh.addrs(), tick, { everyNTicks: o.everyNTicks || 5 });
        if (target) {
          const url = mesh.urlFor(target);
          const sample = mesh.sample(3);
          if (url && sample.length) {
            try {
              await doFetch(url.replace(/\/$/, '') + '/lawbor/offer', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ from: mesh.self, peers: sample }),
                redirect: 'error', signal: AbortSignal.timeout(5000),
              });
            } catch { /* a refused offer is normal — the peer may not know us yet */ }
          }
        }
      } catch (e) { console.error('[lawbor] heartbeat:', e.message); }
      beatTimer = setTimeout(run, beat.nextDelay({ intervalMs }));   // jittered — no thundering herd
      if (beatTimer.unref) beatTimer.unref();                        // never hold the process open
    };
    beatTimer = setTimeout(run, beat.nextDelay({ intervalMs }));
    if (beatTimer.unref) beatTimer.unref();
  }
  const stopHeartbeat = () => { if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; } };

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    try {
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, self: node.self, peers: node.peers().length, authenticatesSenders: node.relay.authenticates });
      if (req.method === 'GET' && url === '/.well-known/lawbor.json') return json(res, 200, { v: 1, addr: node.self, accept: '/lawbor/accept', minScore: MIN_SCORE, oracle: 'MainStreet', note: 'reputation-gated bot messaging' });

      // Peer admission. This used to write straight into a bare Map with no checks at all — the
      // ungated side-door that made every defence in mesh.js decorative. It now goes through
      // mesh.addPeer: url policy, discovery-card match, reputation gate, first-write-wins, cap.
      if (req.method === 'POST' && url === '/peers') {
        const a = await body(req) || {};
        if (!a.addr || !a.url) return json(res, 400, { error: 'addr + url required' });
        const r = await mesh.addPeer(a.addr, a.url, { source: 'operator', confirm: a.confirm === true });
        return json(res, r.ok ? 200 : 400, { ok: r.ok, reason: r.reason || null, peers: node.peers() });
      }

      // Peer EXCHANGE: a peer offers us peers it knows. Bounded per source, gated per candidate,
      // and gossip can only ADD unknown addrs — never rebind or evict an established one.
      if (req.method === 'POST' && url === '/lawbor/offer') {
        const a = await body(req) || {};
        if (!a.from || !Array.isArray(a.peers)) return json(res, 400, { error: 'from + peers[] required' });
        const r = await mesh.offer(a.from, a.peers);
        return json(res, 200, r);
      }
      // What WE will disclose in return: a bounded, non-transitive sample. Never the full table.
      if (req.method === 'GET' && url === '/lawbor/peers') return json(res, 200, { peers: mesh.sample(3) });

      if (req.method === 'POST' && url === '/say') { const a = await body(req) || {}; if (!a.to || !a.body) return json(res, 400, { error: 'to + body required' }); const r = await node.say(a.to, a.body, { thread: a.thread }); return json(res, 200, { id: r.envelope.id, thread: r.envelope.thread, delivered: r.delivered, sign: r.sign, reason: r.reason }); }
      if (req.method === 'POST' && url === '/bot/say') { const a = await body(req) || {}; if (!a.to || !a.body) return json(res, 400, { error: 'to + body required' }); const r = await node.botSay(a.to, a.body, { thread: a.thread }); return json(res, 200, { id: r.envelope.id, delivered: r.delivered }); }

      /* WORK — the three verbs. State is DERIVED from the message log by folding it, so there is no
       * job table to drift out of sync with what was actually said. The actor rules are checked HERE,
       * before the envelope is built: a rule enforced only when rendering is decorative. */
      if (req.method === 'POST' && url === '/work') {
        const a = await body(req) || {};
        if (!a.to || !a.kind) return json(res, 400, { error: 'to + kind required' });
        const job = work.foldThread(store.all()).get(a.jobId);
        const may = work.mayApply(job, a.kind, node.self);
        if (!may.ok) return json(res, 409, { error: may.reason });
        let wbody; try { wbody = work.buildWork(a.kind, a); } catch (e) { return json(res, 400, { error: e.message }); }
        // `as` decides which of the two views this lands in: a person posting a job is 'human',
        // a bot quoting autonomously is 'bot'. It is not cosmetic — it is the store view.
        const r = a.as === 'human' ? await node.say(a.to, wbody, { thread: a.thread })
                                   : await node.botSay(a.to, wbody, { thread: a.thread });
        return json(res, 200, { id: r.envelope.id, thread: r.envelope.thread, delivered: r.delivered, sign: r.sign, reason: r.reason || null });
      }
      if (req.method === 'GET' && url === '/jobs') {
        const jobs = work.jobsFrom(store.all());
        const state = q.get('state');
        return json(res, 200, {
          jobs: state ? jobs.filter((j) => j.state === state) : jobs,
          note: 'negotiation only — settlementRef is opaque and never created, resolved or checked here',
        });
      }

      if (req.method === 'GET' && url === '/inbox') return json(res, 200, { view: 'inbox', threads: store.inbox(node.self, Number(q.get('limit')) || 50) });
      if (req.method === 'GET' && url === '/bot-activity') return json(res, 200, { view: 'bot-activity', threads: store.botActivity(node.self, Number(q.get('limit')) || 50) });
      if (req.method === 'GET' && url === '/thread') { const id = q.get('id'); if (!id) return json(res, 400, { error: 'id required' }); return json(res, 200, { thread: id, messages: store.thread(id) }); }

      if (req.method === 'POST' && url === '/lawbor/accept') { const a = await body(req) || {}; if (!a.envelope) return json(res, 400, { error: 'envelope required' }); const r = await node.receive(a.envelope); return json(res, r.action === 'drop' ? 202 : 200, { action: r.action, reason: r.reason || null }); }

      // MCP over streamable-http, for clients that prefer a URL to a local process. NOTE: LAWBOR is
      // decentralized — this serves YOUR node only. Sharing one hosted node with strangers would hand
      // them your inbox and identity; the intended distribution is the stdio package (npx lawbor-bot).
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
          mcp: { transport: 'streamable-http', endpoint: b + '/mcp', stdio: 'npx -y lawbor-bot' },
          tools: mcpTools.map((t) => ({ name: t.name, description: t.description })),
          safety: { descriptorOnly: true, signs: false, movesFunds: false, gate: 'MainStreet reputation preflight, fail-closed' },
          note: 'Run your OWN node (stdio) — a shared hosted node would centralize the network and expose your inbox.',
        });
      }

      return json(res, 404, { error: 'GET /health,/inbox,/bot-activity,/thread,/lawbor/peers · POST /say,/bot/say,/lawbor/accept,/lawbor/offer,/peers' });
    } catch (e) { return json(res, 500, { error: e.message }); }
  });
  return { server, node, mesh, startHeartbeat, stopHeartbeat };
}

module.exports = { build };
if (require.main === module) {
  const { server, startHeartbeat } = build();
  const PORT = Number(process.env.PORT || 4830);
  server.listen(PORT, () => {
    console.log('LAWBOR bot on :' + PORT + ' — self ' + SELF + ' — reputation-gated, descriptor-only. Set LAWBOR_ADDR + a signer to go live.');
    // Liveness + pruning only happen because something drives them; mesh.js schedules nothing.
    if (process.env.LAWBOR_BEAT !== '0') startHeartbeat();
    if (process.env.LAWBOR_ALLOW_UNAUTHENTICATED === '1') {
      console.warn('⚠️  LAWBOR_ALLOW_UNAUTHENTICATED=1 — inbound `from` is NOT verified. Anyone can claim a reputable address and inherit its score. Development only.');
    }
  });
}
