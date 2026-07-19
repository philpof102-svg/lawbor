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
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { createNode } = require('./lib/node');
const { createStore } = require('./lib/store');
const { createMesh, isPrivateAddress, isLoopback, isLan } = require('./lib/mesh');
const { createApps } = require('./lib/apps');
const { createPaywall } = require('./lib/paywall');
const beat = require('./lib/beat');
const work = require('./lib/work');
const { createChainReader } = require('./lib/chain');
const { creditFor } = require('./lib/credit');
// The MCP surface. server.js advertised /mcp and /.well-known/mcp.json for weeks while BOTH returned
// 500 'mcpDispatch is not defined' — this module was never required. The suite missed it because
// test/mcp.test.js imports ../mcp directly and never went through the HTTP server. A machine-readable
// discovery card promising tools that 500 is the worst kind of false claim: it is aimed at agents.
const { dispatch: mcpDispatch, TOOLS: mcpTools } = require('./mcp');
const CORS = { 'access-control-allow-origin': '*' };

const SELF = process.env.LAWBOR_ADDR || '0x0000000000000000000000000000000000000000';
const MAINSTREET_URL = (process.env.MAINSTREET_URL || 'https://avisradar-production.up.railway.app').replace(/\/$/, '');
const MIN_SCORE = Number(process.env.LAWBOR_MIN_SCORE || 40);

/* The rating's limits, returned WITH every /credit response rather than buried in a doc. They are the
 * price of the property that made it survive adversarial farming, and a caller who does not see them
 * will misread the numbers (RATING-DESIGN.md §5). */
const RATING_LIMITS = [
  'this is the view from THIS node only — there is no global score, and two nodes will disagree by design',
  'cold start is total: a node that has paid nobody sees 0 for everyone, including honest workers',
  'settled means PAID, never delivered and never that the work was any good — no escrow, no dispute path',
  'standing earned from you is history, not a forecast: it does not predict future delivery',
];

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
  const lanOk = (a) => (opts.allowLoopback === true && isLoopback(a)) || (opts.allowPrivate === true && isLan(a));
  if (!lanOk(host)) {
    if (isPrivateAddress(host)) throw new Error('private address refused');
    const resolved = await dns.lookup(host, { all: true });
    for (const r of resolved) {
      if (isPrivateAddress(r.address) && !lanOk(r.address)) throw new Error('host resolves inward (' + r.address + ') — refused');
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
  // Retention (opt-in, unbounded by default): LAWBOR_MAX_MESSAGES caps live rows, LAWBOR_MAX_AGE_DAYS
  // caps age, LAWBOR_COMPACT_EVERY auto-compacts every N stored messages. Bounds disk AND RAM (the index).
  const retention = {
    maxMessages: Number(process.env.LAWBOR_MAX_MESSAGES) || 0,
    maxAgeMs: (Number(process.env.LAWBOR_MAX_AGE_DAYS) || 0) * 86_400_000,
    compactEvery: Number(process.env.LAWBOR_COMPACT_EVERY) || 0,
  };
  const store = deps.store || createStore(undefined, undefined, retention);
  // Compact once at boot so a node that has been down keeps its restart bounded, not just steady-state.
  if ((retention.maxMessages || retention.maxAgeMs) && typeof store.compact === 'function') {
    try { const r = store.compact(); if (r.removed) console.log(`[lawbor] compacted store: dropped ${r.removed}, kept ${r.kept}`); } catch {}
  }
  const doFetch = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const self = deps.self || SELF;
  // Development escape: loopback ONLY (never the rest of the private space — see lib/mesh.js).
  const allowLoopback = deps.allowLoopback !== undefined ? deps.allowLoopback : process.env.LAWBOR_ALLOW_LOOPBACK === '1';
  // LAN testing across two machines: RFC1918 addresses (192.168.x, 10.x). Cloud metadata (169.254)
  // stays refused even here — see isLan. Dev/test only, never production.
  const allowPrivate = deps.allowPrivate !== undefined ? deps.allowPrivate : process.env.LAWBOR_ALLOW_PRIVATE === '1';
  const allowInsecure = deps.allowInsecure !== undefined ? deps.allowInsecure : process.env.LAWBOR_ALLOW_INSECURE === '1';

  /* ONE peerbook. This used to be a bare `new Map()` here PLUS a Set inside relay.js, and the two
   * could disagree: relay said "forward", the transport had no url, the envelope silently vanished,
   * and the human was still told delivered:true. mesh.js now owns addr→url, the relay reads it
   * through peers(), and the transport resolves through urlFor() — they cannot drift. */
  const mesh = deps.mesh || createMesh({
    self,
    preflight: deps.preflight || mainstreetPreflight,
    verify: deps.verify || ((url) => fetchDiscoveryCard(url, doFetch, { allowLoopback, allowPrivate })),
    minScore: deps.minScore || MIN_SCORE,
    anchors: parseAnchors(process.env.LAWBOR_ANCHORS),
    allowInsecure, allowLoopback, allowPrivate,
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
  /* Peer gossip must not vouch for someone you've blocked. sharePeers() suppresses blocked addresses
   * from what this node RECOMMENDS to others (GET /lawbor/peers + the heartbeat offer). This gives a
   * block a network effect: a widely-blocked address falls out of the discovery graph, no central
   * moderator needed. It is the ONLY block effect on the mesh — a block is CONTACT, not censorship:
   * relaying a blocked sender's traffic to third parties is deliberately UNAFFECTED (see relay.accept
   * forward path), because filtering that would let a personal block list censor the whole network.
   * mesh.js stays pure (no consent knowledge); the filter lives here, at the boundary gossip exits. */
  const sharePeers = (n) => { const { blocked } = store.control(); return mesh.sample(n).filter((p) => !blocked.has(String(p.addr).toLowerCase())); };

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

  const json = (res, code, obj, extra) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...(extra || {}) }); res.end(JSON.stringify(obj)); };
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
          const sample = sharePeers(3);
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

  /* PREMIUM tier + APPS (optional). The premium tier is a HOSTED node's content, not the software —
   * see PLATFORM.md. A paywall exists only when LAWBOR_PAY_TO (the operator's wallet) is set; payments
   * go STRAIGHT to that wallet via x402 (the node never holds a key), and verification is injected
   * (deps.x402verify → an x402 facilitator; without it, premium fails closed). Apps register routes +
   * tools; premium apps are gated by the paywall. */
  const payTo = deps.payTo || process.env.LAWBOR_PAY_TO || null;
  const paywall = payTo ? createPaywall({
    payTo, price: process.env.LAWBOR_PRICE || '5', network: process.env.LAWBOR_NETWORK || 'base',
    verify: deps.x402verify,
    subs: { record: (p, u) => store.appendSub(p, u), until: (p) => store.subUntil(p) },
  }) : null;
  const apps = createApps(deps.apps || [], { paywall });

  /* SETTLEMENT VERIFICATION + the txFacts cache (see RATING-DESIGN.md).
   * A `settle` message only claims a txHash; it becomes a rating edge only when an immutable chain
   * fact confirms it. The reader is injectable (deps.chain) and otherwise built from LAWBOR_RPC_URL —
   * with NEITHER, we verify nothing and every settle stays unverified. That is fail-closed on the credit
   * side and it is reported at /health, so a node can never look like it is rating on-chain evidence
   * while silently rating nothing.
   * The cache is legitimate under the "no drifting side table" rule because it stores IMMUTABLE facts
   * about a chain we do not own: deleting it only reduces what we can verify, re-fetching reproduces it,
   * and it can never change a job's history (which stays derived from the log + the chain). We only ever
   * cache a fact that is ALREADY final (>= MIN_CONF), since confirmations grow and a young one would
   * otherwise be frozen at its birth value forever. */
  /* LIVE BY DEFAULT (Phil, 2026-07-19: "tu as besoin d'une chaîne, use Base"). The default RPC is the
   * public Base endpoint — READ-ONLY JSON-RPC, no key, no account, no sends, so defaulting it on adds
   * zero custody risk and removes the silent failure mode where every node ships blind and every zero
   * standing is really "nobody configured an RPC". Opt out explicitly with LAWBOR_RPC_URL=off (air-gapped
   * or test rigs); point LAWBOR_RPC_URL at your own endpoint if the public one rate-limits you. The
   * reader still self-checks eth_chainId==8453 and refuses everything on a mis-pointed URL. */
  const rpcUrl = process.env.LAWBOR_RPC_URL === 'off' ? null
    : (process.env.LAWBOR_RPC_URL || 'https://mainnet.base.org');
  const chain = deps.chain !== undefined ? deps.chain
    : createChainReader({ rpcUrl, fetch: doFetch });
  const MIN_CONF_CACHE = 12;
  const txFacts = new Map();
  const factsFile = deps.txFactsFile !== undefined ? deps.txFactsFile
    : path.join(process.env.LAWBOR_DATA_DIR || path.join(__dirname, 'data'), 'txfacts.jsonl');
  if (factsFile) {
    try {
      for (const line of fs.readFileSync(factsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const f = JSON.parse(line); if (f && f.txHash) txFacts.set(String(f.txHash).toLowerCase(), f); } catch {}
      }
    } catch { /* no cache yet is normal */ }
  }
  const rememberFact = (txHash, f) => {
    txFacts.set(txHash, f);
    if (!factsFile || !f || Number(f.confirmations) < MIN_CONF_CACHE) return;   // only cache the final
    try { fs.mkdirSync(path.dirname(factsFile), { recursive: true }); fs.appendFileSync(factsFile, JSON.stringify({ txHash, ...f }) + '\n'); } catch {}
  };
  /** Fetch the chain facts for any settle claims we have not resolved yet. Bounded per call so a large
   *  log can never turn one HTTP request into hundreds of RPC calls. Best-effort: a miss just stays
   *  unverified (and therefore confers nothing) until the next read. */
  async function resolveFacts(messages, budget = 20) {
    if (!chain) return txFacts;
    const wanted = [];
    for (const m of messages) {
      const w = work.parseWork(m && m.body);
      if (w && w.kind === 'settle' && w.txHash && !txFacts.has(w.txHash)) wanted.push(w.txHash);
    }
    for (const h of [...new Set(wanted)].slice(0, budget)) {
      try { const f = await chain.checkTx(h); if (f) rememberFact(h, f); } catch {}
    }
    return txFacts;
  }

  /* AUTHENTICATE the premium caller. v1 gated on an unauthenticated `x-lawbor-caller` header — anyone
   * could claim a subscribed address. Now: if a signature verifier is injected (deps.verifyAuth, same
   * shape as the relay's verifySig), a caller proves control of their address by signing a
   * time-windowed challenge in `x-lawbor-auth: <addr>:<sig>`. The window (this minute or last) stops
   * replay without any server state. Without a verifier wired, we fall back to the raw header for
   * dev/testing — /health + /apps report `authenticatesCaller` so nobody assumes a gate that isn't on. */
  async function authCaller(req) {
    const signed = req.headers['x-lawbor-auth'];
    if (signed && typeof deps.verifyAuth === 'function') {
      const i = String(signed).indexOf(':');
      const addr = i > 0 ? String(signed).slice(0, i) : '';
      const sig = i > 0 ? String(signed).slice(i + 1) : '';
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
      const minute = Math.floor(Date.now() / 60000);
      for (const m of [minute, minute - 1]) {                 // accept current + previous minute (clock skew)
        const message = 'LAWBOR-AUTH:' + addr.toLowerCase() + ':' + m;
        try { const v = await deps.verifyAuth({ message, sig, claimed: addr }); if (v && v.ok === true && String(v.signer || '').toLowerCase() === addr.toLowerCase()) return addr.toLowerCase(); } catch {}
      }
      return null;                                            // signed but did not verify → unauthenticated
    }
    return req.headers['x-lawbor-caller'] || null;            // dev fallback (unauthenticated)
  }

  /* Operator-only gate for LOCAL controls (block / unblock / accept / delete). These mutate the
   * operator's OWN node — and /delete is IRREVERSIBLE (it scrubs a stored body), so an open /delete on
   * a publicly-bound node would let any stranger wipe the operator's store. Rule:
   *   - loopback (127.0.0.1 / ::1) is trusted — the desktop pod and same-host tools reach the node here;
   *   - a REMOTE caller must cryptographically sign AS the operator (verifyAuth wired, caller === self).
   * The unauthenticated x-lawbor-caller dev-fallback is deliberately NOT accepted for the remote path —
   * it is spoofable, so trusting it would reopen the hole. On a public deploy (Railway fronts a proxy,
   * so nothing is loopback) wire deps.verifyAuth to operate these controls remotely. Peer traffic
   * (/lawbor/accept) is unaffected: it is reputation-gated, not operator-gated. */
  const isLoopback = (req) => { const ra = (req.socket && req.socket.remoteAddress) || ''; return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'; };
  async function operatorOk(req) {
    if (isLoopback(req)) return true;
    if (typeof deps.verifyAuth !== 'function') return false;  // remote + no verifier ⇒ fail closed
    const caller = await authCaller(req);
    return !!caller && caller.toLowerCase() === String(node.self).toLowerCase();
  }
  const denyOperator = (res) => json(res, 401, { error: 'operator-only: call from localhost, or sign as self in x-lawbor-auth (needs verifyAuth wired)' });

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    try {
      // verifiesSettlements is reported next to authenticatesSenders on purpose: both are "is this node
      // actually checking, or just accepting?" A node with no chain reader rates nothing, and says so.
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, self: node.self, peers: node.peers().length, authenticatesSenders: node.relay.authenticates, verifiesSettlements: !!chain, consentLocal: true });
      if (req.method === 'GET' && url === '/.well-known/lawbor.json') return json(res, 200, { v: 1, addr: node.self, accept: '/lawbor/accept', minScore: MIN_SCORE, oracle: 'MainStreet', note: 'reputation-gated bot messaging' });
      // the installable agent skill: how to orchestrate a dynamic, trust-gated org on this node.
      if (req.method === 'GET' && url === '/skill.md') {
        try { const md = require('fs').readFileSync(require('path').join(__dirname, 'SKILL.md'), 'utf8'); res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' }); return res.end(md); }
        catch { return json(res, 404, { error: 'no skill on this node' }); }
      }

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
      if (req.method === 'GET' && url === '/lawbor/peers') return json(res, 200, { peers: sharePeers(3) });

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
        // For a settle, resolve the chain fact right away and report HONESTLY whether it verified. A
        // settle that cannot be checked is not an error (the tx may simply be young) but the caller must
        // never be left believing a rating edge exists when none does.
        let settled = undefined;
        if (a.kind === 'settle') {
          await resolveFacts([{ body: wbody }], 1);
          const j = work.foldThread(store.all(), { txFacts }).get(a.jobId);
          settled = {
            verified: !!(j && j.settlement),
            note: !chain ? 'no chain reader configured (LAWBOR_RPC_URL=off) — this settlement can never verify here, and confers no credit'
              : (j && j.settlement) ? 'verified against Base — settled means PAID, not delivered'
              : 'not verified (yet): unknown tx, too few confirmations, or a from/to/amount mismatch. Confers no credit until it verifies.',
          };
        }
        return json(res, 200, { id: r.envelope.id, thread: r.envelope.thread, delivered: r.delivered, sign: r.sign, reason: r.reason || null, ...(settled ? { settled } : {}) });
      }

      /* THE RATING — per-viewer, conservation-bounded, never a global score (RATING-DESIGN.md).
       * Five rating designs were farmed by a dedicated adversary; what survived is that standing is a
       * CONSERVED, DEBITED quantity bounded by this node's OWN irrecoverable spend. So this is the view
       * from `node.self` and from nobody else, and two nodes will legitimately disagree. */
      if (req.method === 'GET' && url === '/credit') {
        const { blocked: cBlocked } = store.control();
        const msgs = store.all().filter((m) => !cBlocked.has(String(m.from).toLowerCase()));
        await resolveFacts(msgs);
        const edges = work.settlementsFrom(msgs, { txFacts });
        const c = creditFor(node.self, edges, { returnFlow: deps.returnFlow || null });
        const of = q.get('of');
        const num = (m, k) => String(m.get(String(k).toLowerCase()) || 0);
        if (of) {
          return json(res, 200, {
            viewer: node.self, of: String(of).toLowerCase(),
            directUsdcMicro: num(c.direct, of), circleUsdcMicro: num(c.circle, of),
            evidence: c.evidence.filter((e) => e.worker === String(of).toLowerCase()),
            netted: c.netted, limits: c.limits.concat(RATING_LIMITS),
          });
        }
        return json(res, 200, {
          viewer: node.self,
          direct: [...c.direct.entries()].sort((a, b) => b[1] - a[1]).map(([addr, m]) => ({ addr, usdcMicro: String(m) })),
          circle: [...c.circle.entries()].sort((a, b) => b[1] - a[1]).map(([addr, m]) => ({ addr, usdcMicro: String(m) })),
          inbound: [...c.inbound.entries()].sort((a, b) => b[1] - a[1]).map(([addr, m]) => ({ addr, usdcMicro: String(m) })),
          evidence: c.evidence, netted: c.netted,
          verifiesSettlements: !!chain,
          limits: c.limits.concat(RATING_LIMITS),
        });
      }
      if (req.method === 'GET' && url === '/jobs') {
        // a blocked address is invisible in /jobs too — fold only non-blocked messages, so a blocked
        // sender's job posts AND bids disappear (they used to show here even though you blocked them).
        const { blocked: jobBlocked } = store.control();
        const jobMsgs = store.all().filter((m) => !jobBlocked.has(String(m.from).toLowerCase()));
        await resolveFacts(jobMsgs);
        const jobs = [...work.foldThread(jobMsgs, { txFacts }).values()].sort((a, b) => b.at - a.at);
        const state = q.get('state');
        return json(res, 200, {
          jobs: state ? jobs.filter((j) => j.state === state) : jobs,
          verifiesSettlements: !!chain,
          note: 'negotiation + settlement PROOF. A job is settled only when a Base USDC tx matching the signed award verifies on-chain; settled means PAID, never delivered.'
            + (chain ? '' : ' No chain reader configured here (LAWBOR_RPC_URL=off), so no settlement can verify on this node.'),
        });
      }

      // The agent-org GRAPH: nodes + dependency edges + the ready (claimable) frontier. Same blocked
      // filter as /jobs. `ready` = deps satisfied means upstream AWARDED, not delivered (no execution here).
      if (req.method === 'GET' && url === '/graph') {
        const { blocked: gBlocked } = store.control();
        const g = work.graphOf(store.all().filter((m) => !gBlocked.has(String(m.from).toLowerCase())));
        return json(res, 200, { ...g, note: 'dependency = upstream awarded (a worker chosen) or settled (paid) — NEITHER means delivered; LAWBOR models no execution' });
      }

      if (req.method === 'GET' && url === '/inbox') return json(res, 200, { view: 'inbox', threads: store.inbox(node.self, Number(q.get('limit')) || 50) });
      if (req.method === 'GET' && url === '/requests') return json(res, 200, { view: 'requests', threads: store.requests(node.self, Number(q.get('limit')) || 50), note: 'first contact from unknown senders — reply or accept to move them to your inbox' });
      if (req.method === 'GET' && url === '/bot-activity') return json(res, 200, { view: 'bot-activity', threads: store.botActivity(node.self, Number(q.get('limit')) || 50) });

      // LOCAL consent controls — your own block/accept list. Never gossiped, no key, no funds.
      if (req.method === 'POST' && url === '/block') { if (!(await operatorOk(req))) return denyOperator(res); const a = await body(req) || {}; if (!a.addr) return json(res, 400, { error: 'addr required' }); return json(res, 200, node.block(a.addr)); }
      if (req.method === 'POST' && url === '/unblock') { if (!(await operatorOk(req))) return denyOperator(res); const a = await body(req) || {}; if (!a.addr) return json(res, 400, { error: 'addr required' }); return json(res, 200, node.unblock(a.addr)); }
      if (req.method === 'POST' && url === '/accept') { if (!(await operatorOk(req))) return denyOperator(res); const a = await body(req) || {}; if (!a.addr) return json(res, 400, { error: 'addr required' }); return json(res, 200, node.accept(a.addr)); }
      // Local delete — remove an ALREADY-STORED body (block only stops future ones). IRREVERSIBLE, so
      // the operator gate matters most here: a stranger must never be able to wipe the operator's store.
      if (req.method === 'POST' && url === '/delete') { if (!(await operatorOk(req))) return denyOperator(res); const a = await body(req) || {}; if (!a.id) return json(res, 400, { error: 'id required' }); return json(res, 200, node.deleteMsg(a.id)); }
      if (req.method === 'GET' && url === '/thread') { const id = q.get('id'); if (!id) return json(res, 400, { error: 'id required' }); return json(res, 200, { thread: id, messages: store.thread(id) }); }

      if (req.method === 'POST' && url === '/lawbor/accept') { const a = await body(req) || {}; if (!a.envelope) return json(res, 400, { error: 'envelope required' }); const r = await node.receive(a.envelope); return json(res, r.action === 'drop' ? 202 : 200, { action: r.action, reason: r.reason || null }); }

      // MCP over streamable-http, for clients that prefer a URL to a local process. NOTE: LAWBOR is
      // decentralized — this serves YOUR node only. Sharing one hosted node with strangers would hand
      // them your inbox and identity; the intended distribution is the stdio package (npx lawbor-bot).
      if (req.method === 'POST' && url === '/mcp') {
        const msg = await body(req);
        if (!msg) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        const out = await mcpDispatch(msg, { node, apps, txFacts, resolveFacts, returnFlow: deps.returnFlow || null });
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

      // ---- installed apps (extensibility) + the premium tier ------------------------------------
      if (req.method === 'GET' && url === '/apps') return json(res, 200, { apps: apps.apps(), premium: paywall ? { priceUsdc: paywall.price, payTo: paywall.payTo, network: paywall.network, verifies: paywall.verifies, authenticatesCaller: typeof deps.verifyAuth === 'function' } : null });
      if (req.method === 'POST' && url === '/x402/settle') { if (!paywall) return json(res, 503, { error: 'no premium tier configured (set LAWBOR_PAY_TO)' }); const a = await body(req) || {}; const r = await paywall.settle(a.payment || a); return json(res, r.ok ? 200 : 402, r); }
      // app routes: /app/<name>/... — tried after the built-ins, before 404. Premium apps 402 here.
      if (url.startsWith('/app/')) {
        const caller = await authCaller(req);
        const appBody = req.method === 'POST' ? (await body(req)) : undefined;
        const r = await apps.http(req.method, url, { node, store, query: q, body: appBody, caller, now: Date.now() });
        if (r) {
          // a raw contentType (HTML/SVG/text) is served verbatim so an app can ship a real UI, not just JSON
          if (r.contentType && typeof r.body === 'string') { res.writeHead(r.status, { 'content-type': r.contentType, 'access-control-allow-origin': '*' }); return res.end(r.body); }
          return json(res, r.status, r.body, r.headers);
        }
      }

      return json(res, 404, { error: 'GET /health,/inbox,/requests,/bot-activity,/thread,/jobs,/graph,/apps,/skill.md,/app/<name>/... · POST /say,/bot/say,/block,/unblock,/accept,/delete,/work,/x402/settle,/lawbor/*,/peers' });
    } catch (e) { return json(res, 500, { error: e.message }); }
  });
  return { server, node, mesh, startHeartbeat, stopHeartbeat };
}

module.exports = { build };
if (require.main === module) {
  // ship the built-in free apps by default on a standalone node: the org-graph viewer, a node digest,
  // and a stateless two-agent game (proof that you ship on it — see PLATFORM.md).
  const { server, startHeartbeat } = build({ apps: [
    require('./apps/orggraph'), require('./apps/standup'), require('./apps/tictactoe'),
    require('./apps/premium-feed'),   // PREMIUM: refused (fail-closed) until LAWBOR_PAY_TO + a verifier are wired
  ] });
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
