'use strict';
/**
 * LAWBOR — mesh.js  (the PEER layer: presence, peer-exchange, liveness — NOT message routing)
 * =============================================================================================
 * WHY THIS EXISTS. A LAWBOR node used to talk only to bots whose operator typed `addr + url` into
 * POST /peers by hand — ungated — and that table lived in TWO places that could silently disagree:
 * server.js's `const peers = new Map()` (addr → url, used by the transport) and relay.js's own
 * `Set` of addrs (used to pick forward targets). When they drift, relay says "forward" and the
 * transport quietly drops the envelope — and node.say() still reports delivered:true to the human.
 * mesh.js is the ONE peerbook, and it is WIRED (2026-07-18): relay takes `peers: () => mesh.addrs()`,
 * the transport resolves through `mesh.urlFor()`, fan-out goes through selectTargets(), and POST
 * /peers runs full admission. The two views cannot diverge.
 *
 * Peer-exchange (gossip of PEERS, never of messages — relay.js already forwards envelopes) is what
 * lets a node grow past its seed list. Gossip is also the moment a messaging network becomes
 * attackable, so every check here defends one named threat:
 *
 *   - PEERBOOK POISONING / REBIND. A gossiped `{addr,url}` is an unauthenticated claim. Defence:
 *     FIRST-WRITE-WINS. Once an addr is bound, gossip can never rebind it; only the operator can,
 *     and only with confirm:true. Gossip can ADD unknown addrs, nothing more.
 *   - EVICTION / ECLIPSE. A table that evicts to make room lets an attacker flush your honest peers
 *     by flooding candidates. Defence: the book NEVER evicts. Full means refuse, full stop. Combined
 *     with maxPerSource that also removes the need for a separate source-diversity quota.
 *   - LIVENESS-DRIVEN ECLIPSE. If peers could be marked dead remotely, an attacker would kill your
 *     honest peers and leave only theirs. Defence: liveness is strictly FIRST-HAND — noteContact()
 *     is the only writer, offer() carries no liveness, and operator/anchor peers are never pruned.
 *   - ORACLE STORM. Retrying a candidate 10k times must not become 10k MainStreet calls. Defence: a
 *     bounded admission memo off the injected clock; refusals expire SOONER than PROCEEDs so a
 *     revoked identity is never pinned open.
 *   - SSRF via a gossiped url. Defence: classifyUrl() parses with `new URL()` (never substring or
 *     startsWith — parser-confusion forms defeat those), refuses credentials, odd ports, and private
 *     / loopback / link-local IP literals including decimal, octal and hex encodings.
 *   - AMPLIFICATION. `[...peers]` fan-out makes every unknown destination a broadcast. Defence:
 *     selectTargets() caps fan-out at `fanout` and never bounces back to opts.notFrom (wired in
 *     relay.accept/originate, so the bound exists in the running path).
 *
 * WHAT THIS DOES NOT ACHIEVE — read this before writing any marketing copy:
 *   1. It is NOT sybil-resistant. The cost of a peer slot is exactly one MainStreet score ≥ minScore.
 *      (relay.js DOES verify the EIP-712 signature over env.from since 2026-07-18 — see SECURITY.md —
 *      so the cost is now CONTROLLING a scored address rather than merely knowing one. That is a real
 *      raise, but it still does not make identities expensive.)
 *   2. It is bootstrap-dependent. This file ships NO default seed and NO seed url by design, so a new
 *      node cannot join without an anchor its operator supplies. status().bootstrapDependent says so.
 *   3. Peer exchange LEAKS the graph. sample() bounds it to k random operator-sourced peers and hides
 *      anchors, but a peer that polls you repeatedly still reconstructs much of your view.
 *   4. classifyUrl is a STATIC PARSE. It cannot stop DNS rebinding and it cannot stop a 302 redirect
 *      chain — one hop after the check, the socket can land anywhere. Those are TRANSPORT properties:
 *      the injected verify()/send() must set redirect:'error', an AbortSignal timeout, a response-size
 *      cap, and a connect-time lookup hook that applies isPrivateAddress() to the address actually
 *      being dialled. isPrivateAddress is exported for exactly that reason. Do not read the check here
 *      as complete.
 *   5. Message bodies remain PLAINTEXT. Nothing here adds confidentiality.
 *
 * 🛑 Descriptor-only, same rule as every LAWBOR module: no keys, no funds, no timers, no sockets.
 *   mesh.js opens nothing and schedules nothing — prune() is caller-driven and ALL network I/O
 *   reaches this file through the injected verify(). Everything is testable offline via the injected
 *   clock, rng, verify and preflight.
 */

const isAddr = (a) => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);

const MAX_URL = 256;
const SCHEME_TLS = 'https:';
const SCHEME_PLAIN = 'http:';
const OK_PORTS = ['', '443', '80'];
// hostnames that resolve inward by convention — refused by name, since they are not IP literals
const INWARD_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/* ------------------------------------------------------------------------------------------------
 * Pure address helpers. Zero I/O, exported so the transport's connect-time lookup hook can apply the
 * SAME predicate to the address the socket is about to reach.
 * ---------------------------------------------------------------------------------------------- */

/** Normalize any IPv4 literal encoding (dotted, decimal, octal, hex, short forms) to dotted decimal.
 *  Returns null when the string is not an IPv4 literal at all (e.g. a real hostname). */
function normalizeIpv4(host) {
  if (typeof host !== 'string' || !host) return null;
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  const raw = host.endsWith('.') ? host.slice(0, -1) : host;
  const parts = raw.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!p) return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums.pop();                                  // the last part absorbs the remaining bytes
  if (last >= Math.pow(256, 4 - nums.length)) return null;
  let value = last;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] > 255) return null;
    value += nums[i] * Math.pow(256, 3 - i);
  }
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function isPrivateIpv4(dotted) {
  const o = dotted.split('.').map(Number);
  const a = o[0], b = o[1];
  if (a === 0) return true;                                 // 0.0.0.0/8 — "this host"
  if (a === 127) return true;                               // loopback
  if (a === 10) return true;                                // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;          // RFC1918
  if (a === 192 && b === 168) return true;                   // RFC1918
  if (a === 169 && b === 254) return true;                   // link-local — incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT 100.64/10
  if (a === 192 && b === 0) return true;                     // 192.0.0/24 + 192.0.2/24 special-use
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking 198.18/15
  if (a >= 224) return true;                                 // multicast, reserved, 255.255.255.255
  return false;
}

function isPrivateIpv6(s) {
  if (!s.replace(/[:0]/g, '')) return true;                  // ::  /  0:0:…:0
  if (/^0*(:0*)*:0*1$/.test(s) || s === '::1') return true;   // loopback
  let m = s.match(/^::ffff:(\d[\d.]*)$/) || s.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const v4 = normalizeIpv4(m[1]); if (v4) return isPrivateIpv4(v4); }
  m = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);    // IPv4-mapped in hextet form
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return isPrivateIpv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'));
  }
  // Transition/embedding prefixes that carry an IPv4 destination INSIDE a v6 literal. An adversarial
  // panel got loopback and link-local past this function through every one of these forms, and the
  // predicate is exported for the transport's connect hook, so a gap here fails open twice.
  m = s.match(/^64:ff9b::(.+)$/) || s.match(/^64:ff9b:1::(.+)$/);        // NAT64 (RFC 6052 / 8215)
  if (m) {
    const v4 = normalizeIpv4(m[1]);
    if (v4) return isPrivateIpv4(v4);
    const hx = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hx) return isPrivateIpv4(hextetsToV4(hx[1], hx[2]));
    return true;                                              // an unparseable NAT64 tail is refused
  }
  m = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);       // 6to4 — embeds the v4 in hextets 2-3
  if (m) return isPrivateIpv4(hextetsToV4(m[1], m[2]));

  // Fully/partially expanded forms the short-form regexes above miss: 0:0:0:0:0:0:7f00:1 (loopback),
  // ::0.0.0.0, 0:0:…:ffff:c0a8:1, and so on. Expand once and re-read the trailing 32 bits.
  const groups = expandIpv6(s);
  if (groups) {
    const leading = groups.slice(0, 5).every((g) => g === 0);
    if (leading && (groups[5] === 0 || groups[5] === 0xffff)) {
      const v4 = hextetsToV4(groups[6].toString(16), groups[7].toString(16));
      if (groups[6] === 0 && groups[7] <= 1) return true;      // :: and ::1 in any written form
      return isPrivateIpv4(v4);
    }
    const head2 = groups[0];
    const hiByte2 = (head2 >> 8) & 0xff;
    if (hiByte2 === 0xfc || hiByte2 === 0xfd) return true;      // fc00::/7 unique-local
    if (head2 >= 0xfe80 && head2 <= 0xfebf) return true;        // fe80::/10 link-local
    if (head2 >= 0xfec0 && head2 <= 0xfeff) return true;        // fec0::/10 site-local (deprecated, still routed inward)
    return false;
  }

  const head = parseInt(s.split(':')[0] || '0', 16);
  if (!Number.isFinite(head)) return true;                    // unparseable → refuse, do not dial
  const hiByte = (head >> 8) & 0xff;
  if (hiByte === 0xfc || hiByte === 0xfd) return true;        // fc00::/7 unique-local
  if (head >= 0xfe80 && head <= 0xfebf) return true;          // fe80::/10 link-local
  if (head >= 0xfec0 && head <= 0xfeff) return true;          // fec0::/10 site-local
  return false;
}

/** Two hextets → the dotted IPv4 they encode. */
function hextetsToV4(a, b) {
  const hi = parseInt(a, 16) || 0, lo = parseInt(b, 16) || 0;
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
}

/** Expand any IPv6 literal to exactly 8 numeric groups, or null if it is not one. */
function expandIpv6(s) {
  if (typeof s !== 'string' || !s.includes(':')) return null;
  let str = s;
  const dotted = str.match(/(\d+\.\d+\.\d+\.\d+)$/);          // trailing dotted-quad form
  if (dotted) {
    const v4 = normalizeIpv4(dotted[1]);
    if (!v4) return null;
    const o = v4.split('.').map(Number);
    str = str.slice(0, -dotted[1].length) +
      ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const out = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** Strictly loopback — 127/8 and ::1 in any written form. Deliberately NARROWER than
 *  isPrivateAddress: it is the only thing the development escape may open. */
function isLoopback(ip) {
  if (typeof ip !== 'string' || !ip) return false;
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes(':')) {
    const g = expandIpv6(s);
    if (!g) return false;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;      // ::1
    const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff);
    return mapped ? hextetsToV4(g[6].toString(16), g[7].toString(16)).startsWith('127.') : false;
  }
  const v4 = normalizeIpv4(s);
  return !!v4 && v4.startsWith('127.');
}

/** Is this a private LAN address safe to open for CROSS-MACHINE dev/testing? RFC1918 + loopback ONLY.
 *  Deliberately EXCLUDES 169.254 (link-local / cloud metadata 169.254.169.254), 0.0.0.0, CGNAT and
 *  every other special range — those stay refused even in LAN-test mode, because the metadata endpoint
 *  is the SSRF target that actually matters. Narrower than isPrivateAddress on purpose. */
function isLan(ip) {
  if (typeof ip !== 'string' || !ip) return false;
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const v4 = s.includes(':') ? null : normalizeIpv4(s);
  if (!v4) return isLoopback(ip);                 // IPv6 LAN is rare in testing — allow loopback only
  const o = v4.split('.').map(Number), a = o[0], b = o[1];
  if (a === 127) return true;                      // loopback
  if (a === 10) return true;                       // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;         // 192.168/16
  return false;                                    // NOT 169.254, NOT 0.0.0.0, NOT anything else
}

/** Is this normalized IP literal one we must never dial? Accepts v4 (any encoding), v6, and
 *  bracketed v6. NOTE: a hostname check upstream cannot stop DNS rebinding — apply this predicate
 *  again in the transport's connect-time lookup hook, on the address actually being connected to. */
function isPrivateAddress(ip) {
  if (typeof ip !== 'string' || !ip) return false;
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s) return false;
  if (s.includes(':')) return isPrivateIpv6(s);
  const v4 = normalizeIpv4(s);
  return v4 ? isPrivateIpv4(v4) : false;
}

/** Pure, zero-I/O url policy. Exported so tests and the injected transport share ONE implementation.
 *  Parses with `new URL()` on purpose — substring/regex/startsWith checks are defeated by parser
 *  confusion. Returns the NORMALIZED origin+pathname; that normalized form is what addPeer stores,
 *  never the caller's raw string. Query strings and fragments are refused rather than silently
 *  dropped by normalization. This is a STATIC parse: it does not and cannot cover redirects or DNS
 *  rebinding — see the header. */
function classifyUrl(url, opts = {}) {
  if (typeof url !== 'string' || !url) return { ok: false, reason: 'url must be a non-empty string' };
  if (url.length > MAX_URL) return { ok: false, reason: 'url longer than ' + MAX_URL + ' chars' };
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, reason: 'unparseable url' }; }
  const insecureOk = opts.allowInsecure === true;
  if (u.protocol !== SCHEME_TLS && !(insecureOk && u.protocol === SCHEME_PLAIN)) {
    return { ok: false, reason: 'scheme ' + u.protocol + ' refused (tls required unless allowInsecure)' };
  }
  if (u.username || u.password) return { ok: false, reason: 'credentials in url refused' };
  if (!u.hostname) return { ok: false, reason: 'no host' };
  if (u.search) return { ok: false, reason: 'query string refused' };
  if (u.hash) return { ok: false, reason: 'fragment refused' };
  // A trailing dot makes an FQDN absolute — "localhost." resolves exactly like "localhost" but the
  // `$` anchor in INWARD_NAMES never matched it. Strip it before ANY host test. (Confirmed bypass.)
  const host = u.hostname.replace(/\.+$/, '');
  if (!host) return { ok: false, reason: 'no host' };
  /* DEVELOPMENT ESCAPE — loopback only, never the rest of the private space.
   * Two nodes on one machine are how anyone actually tries LAWBOR, and the test suite runs on
   * 127.0.0.1. But this must NOT become "allow private addresses": 169.254.169.254 (cloud metadata)
   * and the RFC1918 ranges are the SSRF targets that matter, and they stay refused here even in
   * development. Loopback is uninteresting to an attacker who is already on the box. */
  const loopbackOk = opts.allowLoopback === true;
  // allowPrivate opens RFC1918 LAN literals for CROSS-MACHINE dev/testing — but 169.254 (metadata),
  // 0.0.0.0 and other special ranges STAY refused (isLan excludes them). LAN-test convenience must
  // not reopen the SSRF target that matters.
  const privateOk = opts.allowPrivate === true;
  const literal = host.startsWith('[') || host.includes(':') ? host : (normalizeIpv4(host) ? host : null);
  const isLocal = literal ? isLoopback(literal) : /(^|\.)localhost$/i.test(host);
  const exempt = (loopbackOk && isLocal) || (privateOk && literal && isLan(literal));
  if (literal) {
    if (isPrivateAddress(literal) && !exempt) {
      return { ok: false, reason: 'private / loopback / link-local address refused' };
    }
  } else if (INWARD_NAMES.test(host) && !exempt) {
    return { ok: false, reason: 'inward-resolving hostname refused' };
  }
  /* PORT POLICY. Restricting peers to 80/443 is what stops a peer url from being pointed at an
   * arbitrary internal service — a peerbook of urls is otherwise a port scanner with extra steps.
   * The loopback exemption lifts it, because two dev nodes on one machine need real ports, and by
   * then the url is already confined to 127.0.0.1 where an attacker gains nothing. */
  if (!exempt && OK_PORTS.indexOf(u.port) === -1) return { ok: false, reason: 'port ' + u.port + ' refused' };
  return { ok: true, normalized: u.origin + u.pathname };
}

/* ------------------------------------------------------------------------------------------------
 * The mesh.
 * ---------------------------------------------------------------------------------------------- */

/** Create the peer layer for one bot node.
 *  @param {{self:string, preflight:Function, verify:Function, clock?:Function, rng?:Function,
 *           anchors?:Array<{addr:string,url:string}>, minScore?:number, maxPeers?:number,
 *           maxPerSource?:number, fanout?:number, peerTtlMs?:number, maxFails?:number,
 *           allowInsecure?:boolean, memoOkMs?:number, memoRefuseMs?:number, maxMemo?:number}} cfg
 *  preflight(addr) → {decision:'PROCEED'|…, score}  (MainStreet /api/agent/preflight/<addr>)
 *  verify(url)     → the peer's discovery card {addr,…}. This is the ONLY way network I/O reaches
 *                    this module; harden it (redirect:'error', timeout, size cap, lookup hook). */
function createMesh(cfg = {}) {
  if (!isAddr(cfg.self)) throw new Error('self must be the bot 0x address');
  if (typeof cfg.preflight !== 'function') throw new Error('preflight required (wire to MainStreet preflight)');
  if (typeof cfg.verify !== 'function') throw new Error('verify(url) required (injected transport that reads the peer discovery card)');

  const self = cfg.self.toLowerCase();
  const clock = typeof cfg.clock === 'function' ? cfg.clock : Date.now;
  const rng = typeof cfg.rng === 'function' ? cfg.rng : Math.random;
  const minScore = Number.isFinite(cfg.minScore) ? cfg.minScore : 40;
  const maxPeers = Number.isInteger(cfg.maxPeers) ? cfg.maxPeers : 16;
  const maxPerSource = Number.isInteger(cfg.maxPerSource) ? cfg.maxPerSource : 4;
  const fanout = Number.isInteger(cfg.fanout) ? cfg.fanout : 3;
  const peerTtlMs = Number.isFinite(cfg.peerTtlMs) ? cfg.peerTtlMs : 30 * 60 * 1000;
  const maxFails = Number.isInteger(cfg.maxFails) ? cfg.maxFails : 3;
  const allowInsecure = cfg.allowInsecure === true;
  // development only — loopback ONLY, see classifyUrl. Never opens the rest of the private space.
  const allowLoopback = cfg.allowLoopback === true;
  const allowPrivate = cfg.allowPrivate === true;  // RFC1918 LAN for cross-machine testing (isLan excludes metadata)
  // admission memo: PROCEEDs live longer than refusals, so a revoked identity is never pinned open
  const memoOkMs = Number.isFinite(cfg.memoOkMs) ? cfg.memoOkMs : 120000;
  const memoRefuseMs = Number.isFinite(cfg.memoRefuseMs) ? cfg.memoRefuseMs : 15000;
  const maxMemo = Number.isInteger(cfg.maxMemo) ? cfg.maxMemo : 256;

  const book = new Map();        // addr(lower) → { url, source, addedAt, lastSeen, fails, learnedFrom, pending }
  // A reservation occupies its slot (so the cap and first-write-wins hold) but is NOT yet a peer:
  // nothing routes to it until verify() and the reputation gate have both passed.
  const live = (e) => !!e && e.pending !== true;
  const anchors = new Set();     // operator-typed seeds: never pruned, never gossiped out
  const memo = new Map();        // addr(lower) → { v, exp }   bounded, insertion-ordered

  const lower = (x) => String(x == null ? '' : x).toLowerCase();

  function pickN(arr, n) {
    const a = arr.slice();
    const k = Math.max(0, Math.min(Number.isFinite(n) ? Math.floor(n) : 0, a.length));
    for (let i = 0; i < k; i++) {
      const span = a.length - i;
      let j = i + Math.floor(rng() * span);
      if (!(j >= i) || j >= a.length) j = i;                 // rng returning 1 / NaN must not corrupt
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a.slice(0, k);
  }

  function memoPut(addr, v, exp) {
    if (memo.has(addr)) memo.delete(addr);
    memo.set(addr, { v, exp });
    while (memo.size > maxMemo) memo.delete(memo.keys().next().value);   // bounded: drop oldest
  }

  /** The same PROCEED + score test relay.gate uses, FAIL CLOSED, memoised per addr. */
  async function gate(addr) {
    const now = clock();
    const hit = memo.get(addr);
    if (hit && hit.exp > now) return hit.v;
    let v;
    try {
      const r = await cfg.preflight(addr);
      if (!r || r.decision !== 'PROCEED') {
        v = { ok: false, reason: 'peer not PROCEED on MainStreet (' + ((r && r.decision) || 'UNKNOWN') + ')' };
      } else if (!(Number(r.score) >= minScore)) {
        v = { ok: false, reason: 'peer score ' + r.score + ' < ' + minScore + ' — too low to peer' };
      } else {
        v = { ok: true, score: r.score };
      }
    } catch (e) {
      v = { ok: false, reason: 'preflight down — FAIL CLOSED (' + (e && e.message) + ')' };
    }
    memoPut(addr, v, now + (v.ok ? memoOkMs : memoRefuseMs));
    return v;
  }

  /** The ONLY write path into the peerbook. Every admission — operator or gossip — passes here. */
  async function addPeer(addr, url, opts = {}) {
    if (!isAddr(addr)) return { ok: false, reason: 'not a bot 0x address' };
    const a = addr.toLowerCase();
    if (a === self) return { ok: false, reason: 'a node does not peer with itself' };

    const cls = classifyUrl(url, { allowInsecure, allowLoopback, allowPrivate });
    if (!cls.ok) return { ok: false, reason: 'url refused: ' + cls.reason };

    const prev = book.get(a);
    if (prev) {
      // FIRST-WRITE-WINS. Gossip can never rebind; the operator must say so explicitly.
      if (!(opts.source === 'operator' && opts.confirm === true)) {
        return { ok: false, reason: 'already bound (rebind refused)' };
      }
    } else if (book.size >= maxPeers) {
      // NEVER evict to make room — an attacker must not be able to displace an established peer.
      return { ok: false, reason: 'peerbook full' };
    }

    /* RESERVE THE SLOT SYNCHRONOUSLY — everything below this line yields to the event loop.
     * ------------------------------------------------------------------------------------
     * Until this existed, the guards above ran, then `await` handed control back, and a second
     * concurrent addPeer() saw the same pre-await state: both passed, both wrote. That made BOTH
     * headline defences void — an adversarial panel drove 20 peers into a maxPeers:2 book and
     * rebound an operator-bound peer to an attacker url without any confirm. offer() ingests
     * candidates concurrently, so this was reachable from a single gossip payload.
     * A reservation is visible to every later caller before the first await, so first-write-wins
     * and the never-evict cap become atomic on the single-threaded loop.
     */
    const start = clock();
    // Least privilege: 'operator' must be asked for explicitly. It used to be the DEFAULT, so an
    // omitted opts.source silently minted an unprunable, gossip-launderable peer.
    const source = opts.source === 'operator' ? 'operator' : 'gossip';
    const reservation = {
      url: cls.normalized, source,
      addedAt: prev ? prev.addedAt : start,
      lastSeen: start, fails: 0,
      learnedFrom: opts.learnedFrom ? lower(opts.learnedFrom) : null,
      pending: true,                    // not routable until verified — see addrs()/urlFor()
    };
    book.set(a, reservation);
    // Undo precisely: restore a displaced binding rather than deleting it, or a failed operator
    // rebind would silently destroy a working peer.
    const release = (reason) => {
      if (book.get(a) === reservation) { if (prev) book.set(a, prev); else book.delete(a); }
      return { ok: false, reason };
    };

    let card;
    try { card = await cfg.verify(cls.normalized); }
    catch (e) { return release('discovery card unreachable — FAIL CLOSED (' + (e && e.message) + ')'); }
    if (!card || !isAddr(card.addr) || card.addr.toLowerCase() !== a) {
      return release('discovery card addr does not match the claimed peer');
    }

    const g = await gate(a);
    if (!g.ok) return release(g.reason);

    // Someone else may have resolved this addr while we awaited; theirs won (first write wins).
    if (book.get(a) !== reservation) return { ok: false, reason: 'already bound (rebind refused)' };
    book.set(a, { ...reservation, pending: false, lastSeen: clock() });
    return { ok: true, addr: a };
  }

  // Anchors are OPERATOR INTENT, not network input: seeded synchronously, no verify, no preflight.
  // Their url is still policy-checked, and a bad one throws loudly at construction rather than
  // leaving the operator believing they are meshed when they are not.
  for (const s of (Array.isArray(cfg.anchors) ? cfg.anchors : [])) {
    const a = s && s.addr;
    if (!isAddr(a)) throw new Error('anchor addr must be a bot 0x address: ' + JSON.stringify(a));
    if (a.toLowerCase() === self) throw new Error('anchor cannot be this node itself');
    const cls = classifyUrl(s.url, { allowInsecure, allowLoopback, allowPrivate });
    if (!cls.ok) throw new Error('anchor url refused: ' + cls.reason + ' (' + String(s.url) + ')');
    const now = clock();
    book.set(a.toLowerCase(), { url: cls.normalized, source: 'operator', addedAt: now, lastSeen: now, fails: 0, learnedFrom: null });
    anchors.add(a.toLowerCase());
  }

  function tracesToAnchor(addr, seen) {
    const e = book.get(addr);
    if (!e) return false;
    if (anchors.has(addr)) return true;
    if (!e.learnedFrom) return false;
    if (seen.has(addr)) return false;
    seen.add(addr);
    return tracesToAnchor(e.learnedFrom, seen);
  }

  function record(addr) {
    const e = book.get(lower(addr));
    return e ? { url: e.url, source: e.source, addedAt: e.addedAt, lastSeen: e.lastSeen, fails: e.fails, learnedFrom: e.learnedFrom } : undefined;
  }

  const mesh = {
    self, minScore, maxPeers, maxPerSource, fanout, peerTtlMs, maxFails,

    addPeer,

    /** Ingest a gossip payload of peer CANDIDATES from an ALREADY-ADMITTED peer. Peers gossip PEERS
     *  only — there is no envelope path here and no message-forwarding code in this file. */
    async offer(fromAddr, candidates = []) {
      const from = lower(fromAddr);
      if (!book.has(from)) {
        return { admitted: [], rejected: [{ addr: from, reason: 'offer from an addr that is not a peer' }] };
      }
      // truncate BEFORE any work: a 50k payload must cost at most maxPerSource verify/preflight calls
      const list = (Array.isArray(candidates) ? candidates : []).slice(0, maxPerSource);
      const admitted = [], rejected = [];
      for (const c of list) {
        const addr = c && c.addr;
        const r = await addPeer(addr, c && c.url, { source: 'gossip', learnedFrom: from });
        if (r.ok) admitted.push(r.addr);
        else rejected.push({ addr: typeof addr === 'string' ? addr.toLowerCase() : addr, reason: r.reason });
      }
      return { admitted, rejected };
    },

    /** The ONLY writer of liveness, and strictly FIRST-HAND. Records a boolean outcome and a
     *  timestamp — never a status code, latency, error string or response body, so mesh state can
     *  never be read back as an internal port scanner. No gossip payload can mark a third party
     *  alive or dead. */
    noteContact(addr, ok) {
      const e = book.get(lower(addr));
      if (!e) return;
      if (ok === true) { e.lastSeen = clock(); e.fails = 0; }
      else { e.fails += 1; }
    },

    /** Caller-driven. This module starts no timer and schedules nothing — a heartbeat loop is the
     *  caller's job. Operator/anchor peers are never pruned: that is what stops liveness-driven
     *  eclipse. @returns {string[]} the addrs removed */
    prune() {
      const now = clock();
      const removed = [];
      for (const [a, e] of book) {
        if (e.source === 'operator') continue;
        if (e.fails >= maxFails || (now - e.lastSeen) > peerTtlMs) removed.push(a);
      }
      for (const a of removed) book.delete(a);
      return removed;
    },

    /** The bounded, NON-TRANSITIVE answer to a peer-exchange request: at most n operator-sourced
     *  peers, anchors hidden, gossip-learned entries excluded so we never launder another node's
     *  binding onward under our own reputation. Never the full table, never any timestamp. */
    sample(n = 3) {
      const pool = [];
      for (const [a, e] of book) if (live(e) && e.source === 'operator' && !anchors.has(a)) pool.push({ addr: a, url: e.url });
      return pickN(pool, n);
    },

    /** Bounds fan-out. Direct peer → deliver to it; otherwise at most `fanout` peers, never
     *  [...peers], never bouncing back to the peer that handed us the envelope.
     *  Wired: relay.accept and relay.originate both route through this via cfg.selectTargets. */
    selectTargets(toAddr, opts = {}) {
      const dest = lower(toAddr);
      if (dest && book.has(dest)) return [dest];
      const notFrom = opts.notFrom ? lower(opts.notFrom) : null;
      const pool = [];
      for (const [a, e] of book) if (live(e) && a !== notFrom) pool.push(a);
      return pickN(pool, fanout);
    },

    addrs() { const out = []; for (const [a, e] of book) if (live(e)) out.push(a); return out; },
    urlFor(addr) { const e = book.get(lower(addr)); return e && live(e) ? e.url : undefined; },
    record,
    has(addr) { const e = book.get(lower(addr)); return !!e && live(e); },

    status() {
      const nonAnchor = [];
      let count = 0;
      for (const [a, e] of book) { if (!live(e)) continue; count++; if (!anchors.has(a)) nonAnchor.push(a); }
      return {
        peers: count,
        anchors: anchors.size,
        // the CAP counts reservations (book.size), because that is what the cap must bound;
        // `peers` counts only what is actually routable. Reporting one number for both would
        // either hide in-flight admissions or overstate the mesh.
        full: book.size >= maxPeers,
        // honest, not hidden: true when every peer we have traces back to a seed the operator typed
        bootstrapDependent: nonAnchor.length > 0 && nonAnchor.every((a) => tracesToAnchor(a, new Set())),
      };
    },

    /** Serialisable view. Deliberately carries only {url,source,addedAt,lastSeen,fails,learnedFrom}
     *  per peer — no status codes, no latencies, no bodies, no error strings. */
    toJSON() {
      const peers = {};
      for (const a of book.keys()) peers[a] = record(a);
      return { self, peers, anchors: [...anchors] };
    },
  };

  return mesh;
}

module.exports = { isLoopback, isLan, createMesh, classifyUrl, isPrivateAddress, normalizeIpv4 };
