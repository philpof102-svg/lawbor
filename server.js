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
// OPTIONAL signature verifier (viem, lazily loaded). Absent ⇒ the relay stays fail-closed on inbound
// peers, which /health reports. See lib/verify.js for why the crypto is not hand-rolled here.
const { createVerifier, createAuthVerifier, verifierStatus, keyProofMessage } = require('./lib/verify');
// The MCP surface. server.js advertised /mcp and /.well-known/mcp.json for weeks while BOTH returned
// 500 'mcpDispatch is not defined' — this module was never required. The suite missed it because
// test/mcp.test.js imports ../mcp directly and never went through the HTTP server. A machine-readable
// discovery card promising tools that 500 is the worst kind of false claim: it is aimed at agents.
const { dispatch: mcpDispatch, TOOLS: mcpTools } = require('./mcp');
const CORS = { 'access-control-allow-origin': '*' };

const SELF = process.env.LAWBOR_ADDR || '0x0000000000000000000000000000000000000000';
/* THE ORACLE, and the fact that it is OURS.
 * ================================================================================================
 * Every inbound envelope is gated on an answer from this URL. LAWBOR's state is decentralized — folded
 * from a local log, viewer-relative, no global score — but ADMISSION runs through one HTTP service, and
 * the shipped default is a service WE operate. A default nobody changes is an authority in practice,
 * whatever the architecture diagram says.
 *
 * We are not removing the default (a node that refuses everyone until configured is a worse first
 * experience, and preflight has always been injectable). We are making the dependency IMPOSSIBLE TO
 * MISS: /health names the oracle and says plainly when it is ours rather than the operator's, and the
 * boot banner repeats it. Nobody can choose otherwise while the dependency is invisible — and it WAS
 * invisible: /health did not mention the oracle at all, and the discovery card gave a name with no URL. */
const DEFAULT_ORACLE = 'https://avisradar-production.up.railway.app';
const MAINSTREET_URL = (process.env.MAINSTREET_URL || DEFAULT_ORACLE).replace(/\/$/, '');
const ORACLE_IS_OURS = MAINSTREET_URL === DEFAULT_ORACLE;
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

// A SHORT-TTL admission cache. The oracle is consulted on EVERY inbound envelope, so a burst from
// many newcomers (Phil's "grand nombre de gens") is N HTTP round-trips to MainStreet — the real
// scaling bottleneck once storage is bounded. A verdict is conservation-based (settled on-chain
// transfers), so it changes SLOWLY; reusing it for ~60s is safe and cuts oracle load + p50 latency.
// Caching a REFUSAL is doubly useful: a spammer's bad address is refused from cache, absorbing their
// burst instead of hammering the oracle. Only SUCCESSFUL verdicts are cached — a throw/hang must fall
// through to the relay's own outage handling (probation/fail-closed), never get pinned. Injected
// preflights (tests, custom operators) bypass this entirely.
const _pfCache = new Map();                                   // addr(lower) -> { at, val }
const PF_TTL = Number(process.env.LAWBOR_PREFLIGHT_TTL_MS) || 60_000;   // 0 disables the cache
const PF_MAX = 5000;                                          // bounded: FIFO-evict the oldest entry

async function mainstreetPreflight(addr) {
  const key = String(addr || '').toLowerCase();
  if (PF_TTL > 0) {
    const hit = _pfCache.get(key);
    if (hit && (Date.now() - hit.at) < PF_TTL) return hit.val;
  }
  // ?viewer=self asks the oracle for its viewer-relative conservation block too
  // (what THIS node's operator has provably settled with `addr`, per MainStreet's
  // own x402 settlement index). Additive on the oracle side: decision/score are
  // unchanged, so the admission gate reads exactly what it always read.
  const viewer = SELF !== '0x0000000000000000000000000000000000000000' ? '?viewer=' + SELF : '';
  // BOUND THE ORACLE CALL. Without a timeout a slow/hanging oracle hangs fetch forever, which hangs
  // node.receive, which hangs POST /lawbor/accept — so a NEWCOMER (whose never-seen address is the
  // slowest to score) cannot reach the node at all. The relay already handles a preflight that THROWS
  // (lib/relay.js: admit under probation, or fail-closed), but a hang is not a throw and never reaches
  // that catch. AbortSignal turns the hang into a throw, restoring the relay's own outage handling.
  const ms = Number(process.env.LAWBOR_PREFLIGHT_TIMEOUT_MS) || 6000;
  const r = await fetch(MAINSTREET_URL + '/api/agent/preflight/' + encodeURIComponent(addr) + viewer, { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('preflight HTTP ' + r.status);   // NOT cached — a failure must reach the relay's outage handling
  const val = await r.json();
  if (PF_TTL > 0) {
    _pfCache.set(key, { at: Date.now(), val });
    if (_pfCache.size > PF_MAX) _pfCache.delete(_pfCache.keys().next().value);   // evict oldest (insertion order)
  }
  return val;
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

/**
 * LAWBOR_SIGNER=./my-signer.js — the operator's OWN signing module, loaded by path.
 * ================================================================================================
 * `sign` has always been injectable, but only programmatically: `build({sign})`. Anyone running the
 * shipped binary — which is everyone who installs from npm — therefore had NO way to sign, and since
 * the relay now demands a signature, that meant the published node could never join the mesh it
 * advertises. The gate was correct and the door was missing.
 *
 * 🛑 THIS IS NOT AN ENV-VAR PRIVATE KEY, and the difference is the whole point. We do not name, read,
 * parse or store a key anywhere; LAWBOR_SIGNER names a FILE THE OPERATOR WROTE, exporting one function
 * we call. Their key stays inside their module — talking to a wallet, a KMS, a hardware device, or (at
 * their own risk, in their own code) a local secret. The node still holds nothing. Shipping
 * `LAWBOR_PRIVATE_KEY` instead would have made us the custodian of every operator's key, which is the
 * one promise this project repeats on every surface.
 *
 * Loading a module by path executes that operator's code — the same trust as `node --require`. It is
 * their own config, not something a peer can influence.
 *
 *   module.exports = async ({ payload, envelope }) => '0x…';   // see examples/signer-viem.js
 *
 * A configured-but-broken signer must never downgrade to sending unsigned: lib/node.js REFUSES. Here we
 * fail loudly at boot for the same reason — a typo'd path that silently left the node unsigned would
 * look exactly like success until a peer refused everything.
 */
function loadSigner() {
  const spec = process.env.LAWBOR_SIGNER;
  if (!spec) return undefined;                      // unsigned by design, and /health says so
  let mod;
  try { mod = require(path.resolve(process.cwd(), spec)); }
  catch (e) { throw new Error('LAWBOR_SIGNER=' + spec + ' could not be loaded: ' + e.message + ' — refusing to start unsigned while claiming a signer'); }
  const fn = typeof mod === 'function' ? mod : (mod && typeof mod.sign === 'function' ? mod.sign : null);
  if (!fn) throw new Error('LAWBOR_SIGNER=' + spec + ' must export a function (or { sign }) taking { payload, envelope } and returning a 0x signature');
  return fn;
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
  /* ONBOARDING POLICY — LAWBOR_ADMIT=probation lets addresses MainStreet has never indexed join and
   * SPEAK (they still earn nothing: conservation makes a stranger worth 0, and consent still gates the
   * inbox). Default stays proceed-only, which is the strict historical behaviour. Measured reason this
   * exists: four real wallets — one with 2241 txs — were all refused, because MainStreet returns score
   * `null` for anything outside its own index, so a newcomer can never build the history admission
   * demands. See lib/relay.js for the full argument. */
  const admitProbation = deps.admitProbation !== undefined ? deps.admitProbation
    : process.env.LAWBOR_ADMIT === 'probation';

  const mesh = deps.mesh || createMesh({
    self,
    preflight: deps.preflight || mainstreetPreflight,
    verify: deps.verify || ((url) => fetchDiscoveryCard(url, doFetch, { allowLoopback, allowPrivate })),
    minScore: deps.minScore || MIN_SCORE,
    anchors: parseAnchors(process.env.LAWBOR_ANCHORS),
    admitProbation,
    allowInsecure, allowLoopback, allowPrivate,
  });

  const send = async (toAddr, env) => {                 // transport: POST the envelope to the peer's accept url
    const url = mesh.urlFor(String(toAddr).toLowerCase());
    if (!url || !doFetch) return { ok: false, reason: 'no route to this peer' };
    try {
      const res = await doFetch(url.replace(/\/$/, '') + '/lawbor/accept', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope: env }),
        redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      // The peer ALREADY tells us what it did — 200 {action:'deliver'|'forward'} or 202 {action:'drop',
      // reason}. That answer used to be thrown away, which is precisely why a refused envelope could be
      // reported as delivered. Read it.
      mesh.noteContact(toAddr, true);                   // it ANSWERED, so it is live — liveness, not acceptance
      let a = null;
      try { a = await res.json(); } catch { /* a live peer that answers unparseable JSON ⇒ unknown */ }
      if (!res.ok || (a && a.action === 'drop')) {
        return { ok: false, reason: (a && a.reason) || ('peer refused (HTTP ' + res.status + ')') };
      }
      return a && a.action ? { ok: true, reason: null } : { ok: null, reason: 'peer answered without saying what it did' };
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
    // deps.verifySig wins (tests inject their own); otherwise use viem if the operator installed it.
    /* ONE flag, ONE meaning. The relay ignores allowUnauthenticated whenever a verifier exists (it
     * then demands a signature from everyone) — so the moment viem became installable, that flag
     * silently turned into a no-op and four integration tests that had "passed" for weeks began
     * failing. They were right to: they had been exercising a mesh whose authentication was off, and
     * nothing said so. The bug was never the relay's strictness, it was that the SAME flag meant
     * "accept unsigned" or "" depending on whether an unrelated package happened to be installed.
     * So: asking for unauthenticated mode now means no verifier is wired at all. Fail-closed survives
     * because the flag defaults to FALSE — a real deploy gets the verifier and demands signatures. */
    verifySig: deps.verifySig || (allowUnauthenticated ? undefined : createVerifier()) || undefined,
    allowUnauthenticated, admitProbation,
    // ORIGINATION: the operator injects their own signer (wallet/KMS/hardware). Deliberately no env-var
    // private-key adapter — that would hand the key to the node and break its central promise.
    sign: deps.sign || loadSigner(),
    // the relay READS the mesh's book and delegates fan-out to it — it no longer keeps its own
    peers: () => mesh.addrs(),
    selectTargets: (to, opts) => mesh.selectTargets(to, opts) });

  // Reap retained bids that can no longer change anything — a resolved job's losing
  // bids always, and a stranded blocked-job bid once it is older than
  // LAWBOR_BID_TTL_DAYS (0 = never; the stranded class stays off by default). Same
  // operator-local, keyless, gossip-free path as the store compaction just above.
  if (typeof node.gcBids === 'function') {
    try {
      const bidTtlMs = (Number(process.env.LAWBOR_BID_TTL_DAYS) || 0) * 86_400_000;
      const r = node.gcBids({ bidTtlMs });
      if (r.removed) console.log(`[lawbor] bid GC: dropped ${r.removed} of ${r.eligible} collectable bid(s)`);
    } catch {}
  }

  // Oracle-lens cache for the board: /bazaar is a public GET, so calling the oracle
  // per seller on every hit is an amplifier a stranger could drive. Dedupe + cap +
  // this 60s per-seller cache bound the outbound fan-out to at most CAP calls/minute.
  const _oracleCache = new Map();   // seller → { at, val }
  const oracleLens = async (seller, pf) => {
    const hit = _oracleCache.get(seller);
    if (hit && (Date.now() - hit.at) < 60_000) return hit.val;
    let val;
    try {
      const p = await Promise.race([pf(seller), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      val = { source: 'MainStreet preflight', decision: p.decision || null, score: p.score ?? null, counterparty: p.counterparty || null,
        disclosure: 'ORACLE-REPORTED: MainStreet\'s x402 settlement index, a service this node\'s operator may not control. Not verified by this node; does NOT enter local standing.' };
    } catch (e) {
      val = { error: 'oracle unreachable: ' + (e && e.message), disclosure: 'advisory only — mesh admission elsewhere stays fail-closed' };
    }
    _oracleCache.set(seller, { at: Date.now(), val });
    return val;
  };

  const json = (res, code, obj, extra) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...(extra || {}) }); res.end(JSON.stringify(obj)); };
  /* setEncoding('utf8') matters: without it each chunk is a Buffer stringified INDEPENDENTLY, so a
   * multi-byte character split across two TCP chunks decodes as U+FFFD on both sides of the cut.
   * With it, node's StringDecoder holds the partial sequence across chunks. Verified the happy path
   * survives ("gm — café, emoji 🚀") — the split case is rare but it is a French-speaking operator's
   * messages that would silently corrupt, and an external tester was already chasing mojibake here
   * (theirs turned out to be client-side CP1252, but the server hole was real). */
  const body = (req) => new Promise((r) => { if (typeof req.setEncoding === 'function') req.setEncoding('utf8'); let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r(null); } }); });

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
  /* CAN THIS NODE ACTUALLY VERIFY A SETTLEMENT? /health used to answer `!!chain` — true whenever an RPC
   * URL and a fetch existed, which is a fact about CONSTRUCTION, not about Base. A node whose endpoint
   * rate-limits, is geo-blocked, or points at the wrong chain reported verifiesSettlements:true while
   * verifying nothing, and every settlement silently stayed unverified and conferred nothing. This is
   * the third field in this codebase caught claiming more than it knew (after `delivered` and the
   * verifier status) and it is the most expensive of the three, because the whole rating rests on it.
   *
   * Now it PROBES: eth_chainId, success cached forever, failure retried after a minute, the call itself
   * bounded by a timeout. Never throws — a status route that 500s tells you even less than a wrong one. */
  async function settlementStatus() {
    if (!chain) return { verifying: false, reason: 'no RPC configured (LAWBOR_RPC_URL=off) — settlements can be RECORDED but never verified, so they confer nothing' };
    try {
      const s = await chain.status();
      return s.reachable
        ? { verifying: true, chainId: s.chainId, rpc: s.rpcUrl }
        : { verifying: false, chainId: s.chainId, rpc: s.rpcUrl, reason: 'RPC configured but NOT USABLE: ' + s.lastError + ' — settlements stay unverified and confer nothing until this clears' };
    } catch (e) {
      return { verifying: false, reason: 'chain probe failed: ' + ((e && e.message) || e) };
    }
  }

  /* Opt-in: refuse to AWARD above this amount to a worker who has never proven they hold their key.
   * Unset = off (unchanged behaviour). It stops LAWBOR committing to an unproven address; it cannot
   * stop a human paying one anyway, outside the protocol. */
  const requireProofAbove = deps.requireProofAbove !== undefined ? deps.requireProofAbove
    : (process.env.LAWBOR_REQUIRE_PROOF_ABOVE ? Number(process.env.LAWBOR_REQUIRE_PROOF_ABOVE) : null);
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
  /* The message-signature verifier, used BOTH by the premium caller gate and by key proofs. Until now
   * only tests ever injected one, so on every real deploy `deps.verifyAuth` was undefined and the gate
   * fell back to the spoofable `x-lawbor-caller` header — a gate that reported itself as on while
   * checking nothing. createAuthVerifier() builds one from viem when installed, null otherwise (and
   * /health + /apps keep reporting which, so the fallback stays visible rather than assumed). */
  const verifyAuth = deps.verifyAuth || createAuthVerifier() || null;

  /* Verified signature proofs, keyed by signature. Deliberately NOT persisted to disk like txFacts: a
   * signature re-verifies in microseconds with no network call, so a cache would be pure risk (a stale
   * or poisoned row would forge a key proof) for no gain. Recomputed per boot, in memory. */
  const sigFacts = new Map();
  /* ONE object for every fold, rather than nine sites each assembling their own `foldOpts`. That
   * pattern is how a new kind of fact ends up wired into eight readers and forgotten in the ninth —
   * which reads as "the proof works everywhere except this one screen", the least debuggable bug shape
   * there is. Both maps are mutated in place, so every reader sees the same facts. */
  const foldOpts = { txFacts, sigFacts };
  const rememberFact = (txHash, f) => {
    txFacts.set(txHash, f);
    if (!factsFile || !f || Number(f.confirmations) < MIN_CONF_CACHE) return;   // only cache the final
    try { fs.mkdirSync(path.dirname(factsFile), { recursive: true }); fs.appendFileSync(factsFile, JSON.stringify({ txHash, ...f }) + '\n'); } catch {}
  };
  /** Fetch the chain facts for any settle claims we have not resolved yet. Bounded per call so a large
   *  log can never turn one HTTP request into hundreds of RPC calls. Best-effort: a miss just stays
   *  unverified (and therefore confers nothing) until the next read. */
  async function resolveFacts(messages, budget = 20) {
    /* SIGNATURE PROOFS FIRST, AND OUTSIDE THE CHAIN GATE. They were resolved inside the loop below,
     * which sits after `if (!chain) return` — so on a node with LAWBOR_RPC_URL=off, a key proof could
     * never verify. It needs no chain: that is its entire point (no gas, no USDC, an empty wallet can
     * prove itself). I wrote the gate and then put the one feature that does not need it behind it.
     * Found by running the live test, not by reading the code — the unit tests inject sigFacts directly
     * and so never execute this function at all, which is exactly how `validate` txHashes went
     * unresolved for weeks earlier today. */
    if (verifyAuth) {
      for (const m of messages) {
        const w = work.parseWork(m && m.body);
        if (!w || w.kind !== 'validate' || !w.keySig || !w.keyAddr || sigFacts.has(w.keySig)) continue;
        try {
          const v = await verifyAuth({ message: keyProofMessage(w.keyAddr), sig: w.keySig, claimed: w.keyAddr });
          // Store ONLY on success. A cached failure would freeze a verifier outage into a permanent
          // "this key is not held", which is a lie about someone else's wallet.
          if (v && v.ok === true) sigFacts.set(w.keySig, { signer: String(v.signer).toLowerCase() });
        } catch { /* unverified ⇒ confers nothing, retried next read */ }
      }
    }
    if (!chain) return txFacts;
    const wanted = [];
    for (const m of messages) {
      const w = work.parseWork(m && m.body);
      // BOTH verbs cite a txHash. Resolving only `settle` left every `validate` permanently unverified —
      // invisible to the unit tests, which inject txFacts directly, and caught only by running it live
      // against Base. Any verb that names a transaction must be resolved here, or it silently never works.
      if (w && (w.kind === 'settle' || w.kind === 'validate') && w.txHash && !txFacts.has(w.txHash)) wanted.push(w.txHash);
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
    if (signed && typeof verifyAuth === "function") {
      const i = String(signed).indexOf(':');
      const addr = i > 0 ? String(signed).slice(0, i) : '';
      const sig = i > 0 ? String(signed).slice(i + 1) : '';
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
      const minute = Math.floor(Date.now() / 60000);
      for (const m of [minute, minute - 1]) {                 // accept current + previous minute (clock skew)
        const message = 'LAWBOR-AUTH:' + addr.toLowerCase() + ':' + m;
        try { const v = await verifyAuth({ message, sig, claimed: addr }); if (v && v.ok === true && String(v.signer || '').toLowerCase() === addr.toLowerCase()) return addr.toLowerCase(); } catch {}
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
    // Reads the SAME resolved verifier as authCaller. It used to read deps.verifyAuth directly while
    // authCaller read the resolved one — two gates disagreeing about whether a verifier is wired is the
    // drift that makes a security question unanswerable. WIDENING, stated plainly: now that a verifier
    // is actually built in production, remote operator control becomes possible for the first time —
    // and only for a caller who signs as `self`, which is the documented intent above.
    if (typeof verifyAuth !== 'function') return false;       // remote + no verifier ⇒ fail closed
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
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, self: node.self, peers: node.peers().length, authenticatesSenders: node.relay.authenticates, originatesSigned: node.originatesSigned, verifier: verifierStatus(node.relay.authenticates), verifiesSettlements: await settlementStatus(), consentLocal: true, admits: admitProbation ? 'probation (strangers may speak; they hold no standing and consent still gates the inbox)' : 'proceed-only',
        /* THE ONE EXTERNAL DEPENDENCY THAT CAN STOP THIS NODE, and it was not in its own status.
         * Admission calls this URL for every inbound envelope. Disclosed with WHOSE it is, because
         * "MainStreet" as a bare name (the discovery card's version) tells an operator nothing about
         * who they are trusting. minScore travels with it — a floor is meaningless without its scorer. */
        admissionOracle: deps.preflight ? { url: null, operatedByUs: false, note: 'a preflight function was injected by this operator — no HTTP oracle is consulted' }
          : { url: MAINSTREET_URL, minScore: deps.minScore || MIN_SCORE, operatedByUs: ORACLE_IS_OURS,
              note: ORACLE_IS_OURS
                ? 'THIS IS THE SHIPPED DEFAULT AND WE RUN IT. Every inbound envelope is gated on an answer from a service this node\'s operator does not control. Set MAINSTREET_URL to your own, or inject your own preflight. With LAWBOR_ADMIT=probation an outage admits at score 0 instead of refusing everyone.'
                : 'operator-chosen oracle' } });
      /* The node's public face. The ERC-8004 card declares a `web` service at `/`, and `/` used to
       * 404 — a registration promising an endpoint that does not answer is the exact placeholder
       * pathology that card is written to avoid. Serving it is therefore not decoration. */
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CORS });
        return res.end(require('./apps/home').page);
      }

      if (req.method === 'GET' && url === '/.well-known/lawbor.json') return json(res, 200, { v: 1, addr: node.self, accept: '/lawbor/accept', minScore: MIN_SCORE, oracle: 'MainStreet', note: 'reputation-gated bot messaging' });
      /* The node's own agent image. Served from here on purpose: an ERC-8004 registration file needs an
       * `image`, and pointing at an external host we do not control is how a registration rots into the
       * placeholder the ecosystem is already full of. This one is live exactly as long as the node is —
       * which is the same condition as every other claim in the card. */
      if (req.method === 'GET' && url === '/agent.svg') {
        const short = String(node.self).slice(0, 6) + '…' + String(node.self).slice(-4);
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="LAWBOR node ' + short + '">'
          + '<rect width="512" height="512" fill="#0b0d10"/>'
          + '<circle cx="256" cy="196" r="86" fill="none" stroke="#4ade80" stroke-width="6"/>'
          + '<circle cx="256" cy="196" r="10" fill="#4ade80"/>'
          + '<path d="M256 110 L256 186 M256 206 L214 268 M256 206 L298 268" stroke="#4ade80" stroke-width="6" fill="none" stroke-linecap="round"/>'
          + '<text x="256" y="360" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="46" fill="#e6e8eb">LAWBOR</text>'
          + '<text x="256" y="404" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="22" fill="#8b949e">' + short + '</text>'
          + '<text x="256" y="452" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="17" fill="#8b949e">paid is proven · no global score</text>'
          + '</svg>';
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS });
        return res.end(svg);
      }

      /* ERC-8004 registration file — DISCOVERY ONLY, and the refusal is the point.
       * ================================================================================================
       * ERC-8004 ("Trustless Agents") is the emerging standard for agent identity/reputation/validation,
       * and its Identity half is genuinely useful: any A2A or MCP agent can find this node without
       * knowing anything about LAWBOR. So we serve the domain-control registration file.
       *
       * WE DO NOT WRITE INTO ITS REPUTATION REGISTRY, and that is a deliberate, measured refusal.
       * The registry's only write rule is "the submitter MUST NOT be the agent owner" — which a second
       * address defeats for the price of gas. That is the collusion our own adversarial round killed
       * (see RATING-DESIGN.md), and the first empirical study of the deployed ecosystem (Xiong et al.,
       * data through 2026-05-13, Ethereum/BSC/Base) found it happening at scale:
       *   - 73.5% / 59.2% / 90.6% of reviewers show COORDINATED SYBIL behaviour;
       *   - after removing Sybil-flagged feedback, 15.8% / 77.9% / 86.8% of rated agents have NO valid
       *     feedback left;
       *   - the authors conclude the registry "cannot function as a trust signal": feedback is "rarely
       *     grounded in verifiable interactions" and "reputation can be manipulated at minimal cost".
       * Publishing a number into it would launder our conservation-bounded rating into exactly the
       * farmable shape we refused to build. We expose the EVIDENCE instead (GET /credit), which anyone
       * can re-verify against Base and refute.
       *
       * The same study found only 3% / 4% / 15% of registrations expose a live endpoint — the rest are
       * placeholders. So `active:true` here is only worth anything because it is true; we omit fields we
       * cannot honestly fill rather than pointing at a 404, which is precisely that pathology. */
      if (req.method === 'GET' && url === '/.well-known/agent-registration.json') {
        const host = String(req.headers.host || '').replace(/[^\w.:\-\[\]]/g, '');
        const base = process.env.LAWBOR_PUBLIC_URL || ((allowInsecure ? 'http://' : 'https://') + host);
        const card = {
          type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
          name: 'LAWBOR node ' + String(node.self).slice(0, 10),
          description: 'Reputation-gated agent messaging and a job market whose outcomes are proven PAID '
            + 'by verified USDC settlements on Base. Holds no key and moves no funds: every write returns '
            + 'an EIP-712 descriptor for the operator to sign.',
          services: [
            { type: 'MCP', url: base + '/mcp' },
            { type: 'web', url: base + '/' },
          ],
          active: true,
        };
        // Only claim what is true of THIS node.
        if (paywall) card.x402Support = true;
        // An on-chain agentId exists only if the operator minted the ERC-721 themselves — a signed
        // transaction, which nothing here does. Never fabricate one.
        const agentId = process.env.LAWBOR_AGENT_ID || null;
        card.registrations = agentId ? [{ agentId }] : [];
        // the node serves its own image (GET /agent.svg), so the field is honestly fillable without
        // depending on a host we do not control. An operator may still override it.
        card.image = process.env.LAWBOR_AGENT_IMAGE || (base + '/agent.svg');

        /* `supportedTrust` is a spec enum we have not verified the exact members of, and guessing a
         * plausible-looking value is how a file becomes confidently wrong. Our trust model goes in a
         * namespaced field instead, where it cannot be mistaken for a standard claim. */
        card['x-lawbor'] = {
          trustModel: 'conservation-bounded, viewer-relative settlement credit — no global score exists',
          evidenceEndpoint: base + '/credit',
          wantedBoard: base + '/wanted',
          skill: base + '/skill.md',
          // PROBED, not assumed: this card is read by other agents deciding whether to trust our evidence.
          verifiesSettlementsOnBase: (await settlementStatus()).verifying,
          admits: admitProbation ? 'probation' : 'proceed-only',
          writesToErc8004ReputationRegistry: false,
          whyNot: 'its only write rule is that the submitter is not the agent owner, which a second address defeats for the price of gas. Measured in the wild at 59-91% coordinated-Sybil reviewers (Xiong et al. 2026). We publish re-verifiable evidence instead of a score.',
          onchainIdentity: agentId ? 'registered' : 'NOT registered on-chain — minting the ERC-721 agentId is a signed transaction the operator performs; set LAWBOR_AGENT_ID afterwards. Until then this file proves domain control only.',
        };
        return json(res, 200, card);
      }

      // the installable agent skill: how to orchestrate a dynamic, trust-gated org on this node.
      if (req.method === 'GET' && url === '/skill.md') {
        try { const md = require('fs').readFileSync(require('path').join(__dirname, 'SKILL.md'), 'utf8'); res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' }); return res.end(md); }
        catch { return json(res, 404, { error: 'no skill on this node' }); }
      }

      // Peer admission. This used to write straight into a bare Map with no checks at all — the
      // ungated side-door that made every defence in mesh.js decorative. It now goes through
      // mesh.addPeer: url policy, discovery-card match, reputation gate, first-write-wins, cap.
      if (req.method === 'POST' && url === '/peers') {
        if (!(await operatorOk(req))) return denyOperator(res); 
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

      if (req.method === 'POST' && url === '/say') {
        if (!(await operatorOk(req))) return denyOperator(res);  const a = await body(req) || {}; if (!a.to || !a.body) return json(res, 400, { error: 'to + body required' }); const r = await node.say(a.to, a.body, { thread: a.thread }); return json(res, 200, { id: r.envelope.id, thread: r.envelope.thread, forwarded: r.forwarded, delivered: r.delivered, targets: r.targets || [], sign: r.sign, reason: r.reason }); }
      if (req.method === 'POST' && url === '/bot/say') {
        if (!(await operatorOk(req))) return denyOperator(res);  const a = await body(req) || {}; if (!a.to || !a.body) return json(res, 400, { error: 'to + body required' }); const r = await node.botSay(a.to, a.body, { thread: a.thread }); return json(res, 200, { id: r.envelope.id, thread: r.envelope.thread, forwarded: r.forwarded, delivered: r.delivered, targets: r.targets || [] }); }

      /* WORK — the three verbs. State is DERIVED from the message log by folding it, so there is no
       * job table to drift out of sync with what was actually said. The actor rules are checked HERE,
       * before the envelope is built: a rule enforced only when rendering is decorative. */
      if (req.method === 'POST' && url === '/work') {
        if (!(await operatorOk(req))) return denyOperator(res); 
        const a = await body(req) || {};
        if (!a.to || !a.kind) return json(res, 400, { error: 'to + kind required' });
        const wMsgs = store.all();
        const job = work.foldThread(wMsgs).get(a.jobId);
        /* KEY-PROOF GUARD on AWARD (opt-in, LAWBOR_REQUIRE_PROOF_ABOVE). Resolved here because it needs
         * chain facts: an address is proven only when it SIGNED a validated transfer. Enforced on the
         * award — the last moment a rule can prevent paying an address nobody controls, since a settle
         * records money that has already left. */
        let proven;
        if (a.kind === 'award' && requireProofAbove != null) {
          await resolveFacts(wMsgs);
          proven = work.provenFrom(wMsgs, foldOpts);
        }
        const may = work.mayApply(job, a.kind, node.self, { requireProofAbove, proven, worker: a.worker, price: a.price, keySig: a.keySig, keyAddr: a.keyAddr });
        if (!may.ok) return json(res, 409, { error: may.reason });
        let wbody; try { wbody = work.buildWork(a.kind, a); } catch (e) { return json(res, 400, { error: e.message }); }
        // `as` decides which of the two views this lands in: a person posting a job is 'human',
        // a bot quoting autonomously is 'bot'. It is not cosmetic — it is the store view.
        // A reply continues the job's thread (bid/quote/award/settle/validate inherit job.thread), so the
        // whole negotiation lives in one followable thread; help_wanted/offer create it (job is null ⇒
        // fresh thread). Caller-supplied a.thread is the fallback when the job is not known locally.
        const wthread = (job && job.thread) || a.thread;
        const r = a.as === 'human' ? await node.say(a.to, wbody, { thread: wthread })
                                   : await node.botSay(a.to, wbody, { thread: wthread });
        // For a settle, resolve the chain fact right away and report HONESTLY whether it verified. A
        // settle that cannot be checked is not an error (the tx may simply be young) but the caller must
        // never be left believing a rating edge exists when none does.
        let settled = undefined, validated = undefined;
        if (a.kind === 'validate') {
          // resolve the handshake immediately and report the DIRECTION honestly — a caller must never
          // read 'validated' as 'this payee holds their key' when the tx went the other way.
          await resolveFacts([{ body: wbody }], 1);
          const allMsgs = store.all();
          const jv = work.foldThread(allMsgs, foldOpts).get(a.jobId);
          // key control is GLOBAL, so report it from provenFrom — saying 'not verified' because the tx
          // was not on this job's rail would hide the very proof the caller just supplied.
          const provenNow = work.provenFrom(allMsgs, foldOpts);
          /* WHICH proof was supplied decides which sentences can be true. The old note tested `!chain`
           * FIRST, so a node with LAWBOR_RPC_URL=off answered "this handshake can never verify here"
           * next to signerProvenKey:true — a free off-chain signature needs no chain, verifying it here
           * is its entire point, and an external tester read that contradiction straight off the wire.
           * The signer lookup also matched sig-rows only because undefined === undefined; now explicit. */
          const wparsed = JSON.parse(wbody);
          const row = (jv && jv.validations || []).find((x) => wparsed.keySig ? x.keySig === wparsed.keySig : x.txHash === wparsed.txHash) || {};
          const signer = row.from || null;
          validated = { pathValidated: !!(jv && jv.pathValidated), payeeProved: !!(jv && jv.payeeProved),
            signer, signerProvenKey: !!(signer && provenNow.has(signer)),
            note: wparsed.keySig
              ? (row.verified ? 'verified OFF-CHAIN: an EIP-191 signature over LAWBOR-KEY:' + (wparsed.keyAddr || '') + ' — no chain needed, that is the point of this path. It proves the key is held, never that a transfer would land (pathValidated stays false), and it confers no standing.'
                : 'signature did NOT verify — wrong key, malformed, or no verifier wired on this node')
              : !chain ? 'no chain reader on this node — a TX handshake cannot verify here (LAWBOR_RPC_URL is off). The free keyAddr+keySig signature path still can.'
              : (jv && jv.payeeProved) ? 'the PAYEE signed it: they control that address'
              : (jv && jv.pathValidated) ? 'a real transfer crossed between you, but it was NOT signed by the payee — it does not prove they hold that key'
              : signer ? 'verified on Base: ' + signer + ' signed it, so THAT address is proven to hold its key. It is not this job rail (the two parties did not both take part), so pathValidated stays false.'
              : 'not verified: unknown tx, too few confirmations, or not a USDC transfer on Base' };
        }
        if (a.kind === 'settle') {
          await resolveFacts([{ body: wbody }], 1);
          const j = work.foldThread(store.all(), foldOpts).get(a.jobId);
          settled = {
            verified: !!(j && j.settlement),
            note: !chain ? 'no chain reader configured (LAWBOR_RPC_URL=off) — this settlement can never verify here, and confers no credit'
              : (j && j.settlement) ? 'verified against Base — settled means PAID, not delivered'
              : 'not verified (yet): unknown tx, too few confirmations, or a from/to/amount mismatch. Confers no credit until it verifies.',
          };
        }
        /* C3's warning, not a refusal. Posting help_wanted with dependsOn on an upstream THIS node has
         * never seen is not wrong — you may be assembling a graph top-down — but the recipient will fold
         * that upstream as blockedByUnknown until it reaches them, and a silent success hides that. So we
         * SURFACE it: delivered stays true, and warnings[] names the gap. An operator learns they created
         * a retention case; an autopilot can choose to send the upstream too. It puts the information
         * exactly where the invariant is still repairable — at emission — without lying about a state we
         * did not verify. (Enforcement itself lives in the fold, receiver-side; this is only the heads-up.) */
        const warnings = [];
        if (a.kind === 'help_wanted') {
          const unsent = work.unsentDepsTo(wMsgs, a.dependsOn, node.self, a.to);
          if (unsent.length) warnings.push('dependsOn ' + unsent.join(', ') + ' not in the outbound log to this peer — they never received those upstreams, so they will fold this job blockedByUnknown forever. Send them too, or this is a retention case.');
        }
        // Negotiation feedback: after a quote, report whether the two sides now AGREE; after a settle,
        // WARN (never block) if the paid amount differs from the price they converged on.
        let agreedPrice = undefined;
        if (a.kind === 'quote' || a.kind === 'confirm' || a.kind === 'settle') {
          const jq = work.foldThread(store.all(), foldOpts).get(a.jobId);
          if (a.kind === 'quote' || a.kind === 'confirm') agreedPrice = (jq && jq.agreedPrice) || null;
          if (a.kind === 'settle' && jq && jq.agreedPrice && String(jq.agreedPrice.amountMicro) !== String(a.amountMicro)) {
            warnings.push('settle amountMicro ' + a.amountMicro + ' ≠ ' + (jq.agreedPrice.accepted ? 'the LOCKED agreedPrice ' : 'agreedPrice ') + jq.agreedPrice.amountMicro + ' — advisory only, the settle is not blocked.');
          }
        }
        return json(res, 200, { id: r.envelope.id, thread: r.envelope.thread, forwarded: r.forwarded, delivered: r.delivered, targets: r.targets || [], sign: r.sign, reason: r.reason || null, ...(warnings.length ? { warnings } : {}), ...(settled ? { settled } : {}), ...(validated ? { validated } : {}), ...(agreedPrice !== undefined ? { agreedPrice } : {}) });
      }

      /* THE WANTED BOARD — the open, claimable frontier, each poster annotated with OUR OWN verified
       * history with them. This is the "communication by trust" surface: before answering a wanted
       * poster, the one question a worker can settle without trusting anyone is "has this requester
       * ever actually paid ME?" — so the board answers exactly that, and nothing more. No global score;
       * a 0 is labelled an absence, never a bad mark. Anyone — human or bot — may bid on any row. */
      /* THE BAZAAR — the SUPPLY side. Offers listed for sale (a service / MCP tool / good), each shown
       * with the SELLER's trust FROM THE VIEWER'S POINT OF VIEW: what this node has irrecoverably paid
       * them, verified on Base and conserved (a ring buying its own listing earns an outsider nothing).
       * A raw purchase count is included but explicitly flagged NOT a trust signal — the same discipline
       * as /who and /wanted: a free-to-manufacture number never sits next to a verified one unlabelled. */
      if (req.method === 'GET' && url === '/bazaar') {
        const { blocked: zBlocked } = store.control();
        const zMsgs = store.all().filter((m) => !zBlocked.has(String(m.from).toLowerCase()));
        await resolveFacts(zMsgs);
        const zc = creditFor(node.self, work.settlementsFrom(zMsgs, foldOpts), { returnFlow: deps.returnFlow || null });
        const of = q.get('of') ? String(q.get('of')).toLowerCase() : null;
        const rawOffers = [...work.foldThread(zMsgs, foldOpts).values()]
          .filter((j) => j.isOffer && (!of || j.requester === of))
          .sort((a, b) => b.at - a.at);
        // ORACLE LENS on the board — the same two-lens composition lawbor_vet uses,
        // now per offer. Bounded: dedupe sellers, cap the lookups, cache 60s, and
        // keep it SEPARATE from the local number — averaging would launder "the
        // oracle said" into "we verified". Default on unless ?oracle=0.
        const ORACLE_CAP = 25;
        const wantOracle = q.get('oracle') !== '0' && (deps.preflight || mainstreetPreflight);
        const sellers = wantOracle ? [...new Set(rawOffers.map((j) => j.requester))].slice(0, ORACLE_CAP) : [];
        const pf = deps.preflight || mainstreetPreflight;
        const oracleBySeller = new Map(await Promise.all(sellers.map(async (s) => [s, await oracleLens(s, pf)])));
        const offers = rawOffers.map((j) => ({
          jobId: j.jobId, item: j.item, price: j.price, ref: j.ref, tags: j.tags, seller: j.requester, thread: j.thread,
          trust: {
            youPaidSellerMicro: String(zc.direct.get(j.requester) || 0),
            verifiedPurchases: (j.purchases || []).filter((p) => p.verified).length,
            note: 'youPaidSellerMicro is the LOCAL trust number — conserved, unfarmable, verified by THIS node. verifiedPurchases is NOT a trust signal (a seller can sybil-buy their own listing; it earns an outsider nothing).',
          },
          oracle: wantOracle ? (oracleBySeller.get(j.requester) || { note: 'not fetched — board oracle lookups capped at ' + ORACLE_CAP + ' unique sellers' }) : { note: 'oracle lens off (?oracle=0)' },
        }));
        return json(res, 200, { viewer: node.self, offers,
          lenses: 'trust = what THIS node verified on-chain (conserved, unfarmable). oracle = MainStreet\'s viewer-relative view (advisory, ORACLE-REPORTED, never enters local standing). Kept SEPARATE, never merged.',
          howToBuy: 'agree a price by /say, pay the seller in USDC on Base yourself, then /work kind:settle with the txHash against the offer jobId. settled means PAID.',
          limits: RATING_LIMITS });
      }

      if (req.method === 'GET' && url === '/wanted') {
        const { blocked: wBlocked } = store.control();
        const wMsgs = store.all().filter((m) => !wBlocked.has(String(m.from).toLowerCase()));
        await resolveFacts(wMsgs);
        const wJobs = [...work.foldThread(wMsgs, foldOpts).values()];
        const wc = creditFor(node.self, work.settlementsFrom(wMsgs, foldOpts), { returnFlow: deps.returnFlow || null });
        const wanted = wJobs.filter((j) => j.state === 'open' && j.ready).sort((a, b) => b.at - a.at).map((j) => ({
          jobId: j.jobId, task: j.task, ref: j.ref, tags: j.tags, budgetHint: j.budgetHint,
          requester: j.requester, bids: j.bids.length, thread: j.thread,
          trust: {
            paidUsMicro: String(wc.inbound.get(j.requester) || 0),
            wePaidThemMicro: String(wc.direct.get(j.requester) || 0),
            // the penny-drop, kept SEPARATE from standing on purpose: it costs only gas, so it proves a
            // live rail and a held key — never that anyone is good for the money.
            pathValidated: !!j.pathValidated,
            payeeProved: !!j.payeeProved,
            // "a zero-value handshake" was the wording until this morning, and it went stale the moment
            // the recommendation moved from 0 to dust (a zero-value ERC-20 transfer is the signature of
            // address-poisoning). A proof may now also be a free off-chain signature. What has not
            // changed, and is the only part that matters, is that NONE of it is standing.
            note: 'verified on Base, OUR history only — 0 means no history with us, not a bad mark. pathValidated/payeeProved come from a proof of key (a dust transfer, or a free signature), NOT standing.',
          },
        }));
        return json(res, 200, {
          wanted,
          note: 'the WANTED board: open, claimable jobs (reward posters). Anyone — human or bot — may bid; the reward settles directly in USDC on Base between the two parties, LAWBOR holds nothing. A bot may also POST here: its autopilot advertises missing prerequisites of its own blocked jobs (postWanted).',
          // PROBED, like /health. This was `!!chain` in three routes after the /health fix landed — the
          // same construction-time boolean the /health comment says was caught lying, still shipping
          // next to the numbers a payer reads. Fixing one call site is not fixing a claim.
          verifiesSettlements: (await settlementStatus()).verifying,
        });
      }

      /* THE RATING — per-viewer, conservation-bounded, never a global score (RATING-DESIGN.md).
       * Five rating designs were farmed by a dedicated adversary; what survived is that standing is a
       * CONSERVED, DEBITED quantity bounded by this node's OWN irrecoverable spend. So this is the view
       * from `node.self` and from nobody else, and two nodes will legitimately disagree. */
      /* ONE ADDRESS, rendered from exactly what /credit already returns — no extra fact, and pointedly
       * no free quantity (see apps/who.js for why that constraint is the whole design). Read-only and
       * open, like every other read surface here. */
      if (req.method === 'GET' && url === '/who') {
        const of = String(q.get('of') || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(of)) return json(res, 400, { error: 'who needs ?of=0x… (a 20-byte address)' });
        const { blocked: wBlocked } = store.control();
        const wMsgs = store.all().filter((m) => !wBlocked.has(String(m.from).toLowerCase()));
        await resolveFacts(wMsgs);
        const wEdges = work.settlementsFrom(wMsgs, foldOpts);
        const wc = creditFor(node.self, wEdges, { returnFlow: deps.returnFlow || null });
        const pick = (m) => Number((m && m.get(of)) || 0);
        const { renderWho } = require('./apps/who');
        const html = renderWho({
          viewer: node.self, of,
          directMicro: pick(wc.direct), inboundMicro: pick(wc.inbound), circleMicro: pick(wc.circle),
          keyProven: work.provenFrom(wMsgs, foldOpts).has(of),
          evidence: (wc.evidence || []).filter((e) => e.worker === of),
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CORS });
        return res.end(html);
      }

      if (req.method === 'GET' && url === '/credit') {
        const { blocked: cBlocked } = store.control();
        const msgs = store.all().filter((m) => !cBlocked.has(String(m.from).toLowerCase()));
        await resolveFacts(msgs);
        const edges = work.settlementsFrom(msgs, foldOpts);
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
          // PROBED, like /health. This was `!!chain` in three routes after the /health fix landed — the
          // same construction-time boolean the /health comment says was caught lying, still shipping
          // next to the numbers a payer reads. Fixing one call site is not fixing a claim.
          verifiesSettlements: (await settlementStatus()).verifying,
          limits: c.limits.concat(RATING_LIMITS),
        });
      }
      if (req.method === 'GET' && url === '/jobs') {
        // a blocked address is invisible in /jobs too — fold only non-blocked messages, so a blocked
        // sender's job posts AND bids disappear (they used to show here even though you blocked them).
        const { blocked: jobBlocked } = store.control();
        const jobMsgs = store.all().filter((m) => !jobBlocked.has(String(m.from).toLowerCase()));
        await resolveFacts(jobMsgs);
        // Memoize the O(N) whole-store fold on (mutations + resolved-fact count). Same 'wf:' key as the
        // MCP lawbor_jobs, so the two share the cached fold between writes instead of each paying O(N).
        const wfKey = 'wf:' + store.mutations() + ':' + (txFacts ? txFacts.size : 0);
        const jobs = [...store.foldMemo(wfKey, () => work.foldThread(jobMsgs, foldOpts)).values()].sort((a, b) => b.at - a.at);
        const state = q.get('state');
        return json(res, 200, {
          jobs: state ? jobs.filter((j) => j.state === state) : jobs,
          // PROBED, like /health. This was `!!chain` in three routes after the /health fix landed — the
          // same construction-time boolean the /health comment says was caught lying, still shipping
          // next to the numbers a payer reads. Fixing one call site is not fixing a claim.
          verifiesSettlements: (await settlementStatus()).verifying,
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
      if (req.method === 'GET' && url === '/thread') {
        const id = q.get('id'); if (!id) return json(res, 400, { error: 'id required' });
        // Enriched like the MCP lawbor_thread: work messages parsed inline + the DERIVED negotiation
        // state (agreedPrice, bids, award, settled) of any job in this thread, so one read = the whole
        // conversation (chat + structured haggle + where the deal stands).
        const raw = store.thread(id);
        const messages = raw.map((m) => { const w = work.parseWork(m.body); return w ? { ...m, work: w, body: undefined } : m; });
        const jobs = [...work.foldThread(raw, foldOpts).values()].map((j) => ({
          jobId: j.jobId, state: j.state, isOffer: !!j.isOffer, requester: j.requester,
          bids: (j.bids || []).length, quotes: (j.quotes || []).length,
          agreedPrice: j.agreedPrice || null, award: j.award || null, settled: !!j.settlement,
        }));
        return json(res, 200, { thread: id, messages, jobs });
      }

      if (req.method === 'POST' && url === '/lawbor/accept') { const a = await body(req) || {}; if (!a.envelope) return json(res, 400, { error: 'envelope required' }); const r = await node.receive(a.envelope); return json(res, r.action === 'drop' ? 202 : 200, { action: r.action, reason: r.reason || null }); }

      // MCP over streamable-http, for clients that prefer a URL to a local process. NOTE: LAWBOR is
      // decentralized — this serves YOUR node only. Sharing one hosted node with strangers would hand
      // them your inbox and identity; the intended distribution is the stdio package (npx lawbor-bot).
      if (req.method === 'POST' && url === '/mcp') {
        const msg = await body(req);
        if (!msg) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        /* READ tools stay OPEN — publishing a discoverable MCP endpoint is the entire point of the
         * ERC-8004 card, and a stranger reading /wanted or /credit costs us nothing.
         * WRITE tools are operator-gated, because on a PUBLIC node they are the same hole the HTTP
         * write routes had: anyone could make this node speak under its operator's address, or fill its
         * store. Gating is loopback-trusted and fail-closed remotely (no verifyAuth wired ⇒ refused), so
         * a local operator is unaffected and the internet gets a read-only surface — which is exactly
         * what this deployment claims to be. Default-deny: a tool not on the read list is a write. */
        const READ_TOOLS = new Set(['lawbor_whoami', 'lawbor_inbox', 'lawbor_watch', 'lawbor_thread',
          'lawbor_requests', 'lawbor_jobs', 'lawbor_graph', 'lawbor_wanted', 'lawbor_credit', 'lawbor_bazaar', 'lawbor_vet', 'lawbor_peer']);
        if (msg && msg.method === 'tools/call' && !READ_TOOLS.has(((msg.params || {}).name) || '')) {
          if (!(await operatorOk(req))) {
            return json(res, 200, { jsonrpc: '2.0', id: msg.id === undefined ? null : msg.id,
              // Point at something that EXISTS — checked, not assumed. An earlier draft said
              // "npx lawbor-bot" while the package was still unpublished, so a stranger following the
              // advice got a 404. It is published now (lawbor-bot@0.1.0, 2026-07-19), and `npm run
              // claims` re-checks that on every deploy rather than trusting this comment.
              result: { content: [{ type: 'text', text: 'refused: ' + ((msg.params || {}).name || 'this tool') + ' writes, and this node only accepts writes from its operator. Read-only tools (whoami, jobs, graph, wanted, credit, inbox, watch, thread, requests) are open to everyone. To write, run your own node: `npx -y -p lawbor-bot lawbor-mcp` (MIT, zero runtime deps), or clone https://github.com/philpof102-svg/lawbor.' }], isError: true } });
          }
        }
        const out = await mcpDispatch(msg, { node, apps, txFacts, resolveFacts, returnFlow: deps.returnFlow || null,
          preflight: deps.preflight || mainstreetPreflight,
          requireProofAbove, provenAddrs: () => work.provenFrom(store.all(), foldOpts) });
        return out ? json(res, 200, out) : res.writeHead(204, CORS) || res.end();   // notification → 204
      }
      if (req.method === 'GET' && url === '/.well-known/mcp.json') {
        const b = 'http' + (req.headers['x-forwarded-proto'] === 'https' ? 's' : '') + '://' + (req.headers.host || 'localhost');
        return json(res, 200, {
          name: 'lawbor', version: '0.1.0',
          description: 'Decentralized, reputation-gated messaging: every participant is a bot, humans talk through their own.',
          mcp: { transport: 'streamable-http', endpoint: b + '/mcp', stdio: 'npx -y -p lawbor-bot lawbor-mcp' },
          tools: mcpTools.map((t) => ({ name: t.name, description: t.description })),
          safety: { descriptorOnly: true, signs: false, movesFunds: false, gate: 'MainStreet reputation preflight, fail-closed' },
          note: 'Run your OWN node (stdio) — a shared hosted node would centralize the network and expose your inbox.',
        });
      }

      // ---- installed apps (extensibility) + the premium tier ------------------------------------
      if (req.method === 'GET' && url === '/apps') return json(res, 200, { apps: apps.apps(), premium: paywall ? { priceUsdc: paywall.price, payTo: paywall.payTo, network: paywall.network, verifies: paywall.verifies, authenticatesCaller: typeof verifyAuth === "function" } : null });
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
    } catch (e) {
      /* A deliberate refusal is not a server fault. buildWork/buildEnvelope THROW on malformed input
       * ("body exceeds 8192 chars", "needs a jobId", …) and this catch-all dressed every one of them as
       * a 500 — so a client sending an over-long body was told the SERVER crashed, which is both wrong
       * and the kind of signal that makes an autopilot retry a request that can never succeed. Our own
       * validation messages are 400s; anything else genuinely is our fault and stays 500. */
      const ours = /exceeds|required|needs |must |unknown |malformed|refused|invalid/i.test(e.message || '');
      return json(res, ours ? 400 : 500, { error: e.message });
    }
  });
  /* resolveFacts + foldOpts are exposed ON PURPOSE. Every fact this node treats as evidence is produced
   * by resolveFacts, and nothing could reach it from a test — the unit suite injects txFacts/sigFacts by
   * hand, so the function that builds them in production ran only in production. Two bugs shipped
   * through that hole in one day: `validate` txHashes never resolved (only `settle` was), and key proofs
   * placed behind the `if (!chain) return` gate they do not need. Both were found by running a live
   * node. This is the seam that makes them testable. */
  return { server, node, mesh, startHeartbeat, stopHeartbeat, resolveFacts, foldOpts };
}

module.exports = { build, mainstreetPreflight, _resetPreflightCache: () => _pfCache.clear() };
if (require.main === module) {
  // ship the built-in free apps by default on a standalone node: the org-graph viewer, a node digest,
  // and a stateless two-agent game (proof that you ship on it — see PLATFORM.md).
  const { server, node, startHeartbeat } = build({ apps: [
    require('./apps/orggraph'), require('./apps/standup'), require('./apps/tictactoe'),
    require('./apps/premium-feed'),   // PREMIUM: refused (fail-closed) until LAWBOR_PAY_TO + a verifier are wired
  ] });
  const PORT = Number(process.env.PORT || 4830);
  server.listen(PORT, () => {
    /* SAY WHAT IS MISSING, not a fixed sentence. This line used to end with "Set LAWBOR_ADDR + a signer
     * to go live" unconditionally — printed verbatim at a node that had BOTH correctly set, which is an
     * instruction to do something already done. An external tester flagged it, and it is the same defect
     * as `delivered` and `verifiesSettlements` in miniature: a message describing a state it never
     * checked. Now it reports what this process can actually do, and only asks for what is absent. */
    const missing = [];
    if (SELF === '0x0000000000000000000000000000000000000000') missing.push('LAWBOR_ADDR (this node has no address)');
    if (!node.originatesSigned) missing.push('LAWBOR_SIGNER (unsigned envelopes are refused by any authenticating peer)');
    // not authenticating has two causes — viem absent, or the operator asked for it with
    // LAWBOR_ALLOW_UNAUTHENTICATED=1. Only the operator knows which, so the line names both rather than
    // guessing, and says what it COSTS either way.
    if (!node.relay.authenticates) missing.push('a signature verifier — an inbound sender is an unverified claim (npm install viem, or unset LAWBOR_ALLOW_UNAUTHENTICATED)');
    console.log('LAWBOR bot on :' + PORT + ' — self ' + SELF + ' — reputation-gated, descriptor-only.'
      + (missing.length ? '\n  ⚠️  still needed to go live: ' + missing.join(' · ')
        : '\n  ✓ signs its own envelopes' + (node.relay.authenticates ? ' and authenticates inbound peers' : ''))
      // said at every boot, because a dependency nobody sees is a dependency nobody can choose away from
      + (ORACLE_IS_OURS ? '\n  ⓘ  admission asks ' + MAINSTREET_URL + ' — the shipped default, which WE run.'
          + ' Every inbound envelope depends on it. Set MAINSTREET_URL to your own oracle to decide for yourself.' : ''));
    // Liveness + pruning only happen because something drives them; mesh.js schedules nothing.
    if (process.env.LAWBOR_BEAT !== '0') startHeartbeat();
    if (process.env.LAWBOR_ALLOW_UNAUTHENTICATED === '1') {
      console.warn('⚠️  LAWBOR_ALLOW_UNAUTHENTICATED=1 — inbound `from` is NOT verified. Anyone can claim a reputable address and inherit its score. Development only.');
    }
  });
}
