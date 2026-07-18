# Security

## Fixed 2026-07-18 — the reputation gate was bypassable by impersonation

**What was wrong.** `env.from` arrived as an unverified claim. `lib/relay.js` asked MainStreet for
the reputation of whatever address the sender had written there, and nothing ever checked a
signature — `lib/envelope.js` produced an EIP-712 descriptor to sign, but no receiver could
recompute it, so no signature was ever verified.

**Impact.** An attacker refused under their own address was admitted by writing a well-scored
address into `from`. No key, no signature. Base addresses are public, so the cost of the attack was
zero. Reproduced against the real relay:

```
as themselves  -> drop     "sender not PROCEED on MainStreet (BLOCK)"
impersonating  -> deliver  senderScore 90
```

Every claim built on the gate — anti-spam, "safe to talk", reputation-gated relay — was decorative
against anyone who knew one reputable address.

**The fix.** `relay.accept()` now authenticates *before* it asks the oracle anything:

1. `signablePayload(env)` moved into `lib/envelope.js` and is exported, so a **receiver** can
   recompute the exact bytes the sender signed. It only existed inside `buildEnvelope()` before,
   which is the structural reason verification was impossible.
2. The sender attaches the signature as `env.sig`.
3. `createRelay({ verifySig })` — verification is **injected**, like `preflight`. Recovering a
   secp256k1 signer needs `ecrecover` and keccak256; node ships neither and LAWBOR has zero runtime
   dependencies, so the core cannot do it alone. Wire it to viem/ethers.
4. **Fail closed.** With no verifier configured the relay *refuses* inbound envelopes. It does not
   quietly trust `from`. The old behaviour still exists but must be named out loud:
   `allowUnauthenticated: true` (or `LAWBOR_ALLOW_UNAUTHENTICATED=1`, which logs a warning at boot).
5. A valid signature by the *wrong* key is refused with `impersonation refused` — a correct
   signature is not enough, it must be the signature of `from`.
6. `GET /health` reports `authenticatesSenders`, and delivered messages carry `authenticated` into
   the store, so a UI can distinguish a proven sender from a merely-claimed one instead of drawing
   both the same.

Pinned by five regression tests in `test/lawbor.test.js` (impersonation refused, genuine sender
still admitted, fail-closed with no verifier, fail-closed on a throwing or malformed verifier, and
no oracle call wasted on an unauthenticated sender).

### Wiring a verifier

```js
import { verifyTypedData } from 'viem'            // or ethers
createRelay({
  self, preflight,
  verifySig: async ({ payload, sig, claimed }) => {
    const ok = await verifyTypedData({ address: claimed, ...payload, signature: sig })
    return ok ? { ok: true, signer: claimed } : { ok: false }
  },
})
```

`bodyHash` in the payload is **sha256, not keccak256** (no keccak in node, zero dependencies). A
verifier must hash exactly as `signablePayload()` does or every signature will fail.

## Fixed 2026-07-18 — mesh.js concurrency and SSRF (found before it was ever wired)

`lib/mesh.js` was reviewed by three independent adversarial agents immediately after it was
written. All three returned *fix-first*. The important class was **TOCTOU**: `addPeer()` checked its
guards, then `await`ed `verify()` and `preflight()`, then wrote. Concurrent callers — and `offer()`
ingests candidates concurrently — all saw the same pre-await state, so **both** headline defences
were void: 20 peers were driven into a `maxPeers: 2` book, and an operator binding was rebound to an
attacker URL without any `confirm`.

Fixed by reserving the slot **synchronously**, before the first `await`. A reservation occupies its
slot (so the cap and first-write-wins are atomic on the single-threaded loop) but is not routable:
`addrs()`, `urlFor()`, `sample()` and `selectTargets()` all skip pending entries until `verify()`
and the reputation gate have passed. A failed operator rebind restores the previous binding instead
of destroying it.

Also fixed: `opts.source` defaulted to the **privileged** value, so an omitted source minted an
unprunable, gossip-launderable peer — it now defaults to `gossip`. And these confirmed SSRF
bypasses, which passed both `classifyUrl()` and the exported `isPrivateAddress()`:
`localhost.` (a trailing dot made the `$` anchor miss), `::ffff:7f00:1`, fully expanded
`0:0:0:0:0:0:7f00:1`, `::127.0.0.1`, NAT64 `64:ff9b::`, 6to4 `2002::`, and site-local `fec0::/10`.

Nothing was exposed in the meantime: `lib/mesh.js` is not yet imported by any running path (see
below). Pinned by 7 regression tests in `test/mesh.test.js`.

## Wired 2026-07-18 — the peer layer is now in the running path

`server.js` no longer keeps its own peer Map, and `POST /peers` no longer calls the ungated
`relay.addPeer` — that route was the side-door that made every check in `mesh.js` decorative. It now
goes through `mesh.addPeer`: url policy → discovery-card match → reputation gate → first-write-wins
→ cap. The relay reads the book via `peers: () => mesh.addrs()` and delegates fan-out to
`mesh.selectTargets()`, so a message to an unknown destination is bounded instead of broadcast, and
`relay.addPeer()` returns false when the book is delegated rather than quietly minting a peer.

Two nodes, live, with the wiring in place:

```
peer whose card names someone else -> refused "discovery card addr does not match the claimed peer"
peer url 169.254.169.254           -> refused "private / loopback / link-local address refused"
honest peering (card matches)      -> ok
rebind of an established peer      -> refused "already bound (rebind refused)"
GET /lawbor/peers                  -> a bounded sample, never the full table
message A -> B                     -> delivered, lands in B's inbox
```

Transport-side defences that a static url parse cannot provide now live in `fetchDiscoveryCard()`:
the hostname is resolved and every returned address is re-checked with `isPrivateAddress()`,
`redirect:'error'` (a 302 must never reach an unchecked host), an abort timeout, and a 64 KiB cap.
**Honest limit:** resolve-then-fetch is still two lookups, so a determined DNS-rebinding attacker can
change the answer in between. Closing that needs a connect-time lookup hook (undici `Agent`), which
would cost a runtime dependency. This narrows the window; it does not eliminate it.

### Heartbeat — because "caller-driven" meant nobody drove it

`mesh.js` schedules nothing by design, which is correct for a library and wrong in practice until
something drives it: `prune()` was never called, so dead peers stayed in the book forever. `lawbor-node`
now runs a heartbeat (`LAWBOR_BEAT=0` disables it; it is never started on `require`, so embedding the
module opens no sockets and the test suite inherits no timer).

Decisions live in `lib/beat.js`, pure and offline-tested; the timer and the sockets stay in
`server.js`. Three bounds it enforces:

- **Thundering herd** — every delay is jittered ±30% off an injected rng, so nodes do not align into
  a synchronised storm as the network grows.
- **Heartbeat amplification** — a tick contacts at most `batch` peers (default 4), oldest-contact
  first, so cost is O(batch) not O(peers), and no peer starves.
- **Graph leakage** — peer exchange runs at most once every 5 ticks, to a single peer, with a bounded
  sample. Growing the mesh is worth some disclosure; broadcasting the table is not.

Liveness stays strictly first-hand: only our own contact result writes it, so no peer can mark
another dead. Verified live — a peer killed mid-run was contacted, marked failed, and pruned.

### Development escape — loopback only

Two nodes on one machine is how anyone actually tries LAWBOR, and the url policy correctly refuses
loopback and non-80/443 ports in production. `LAWBOR_ALLOW_LOOPBACK=1` (with
`LAWBOR_ALLOW_INSECURE=1` for plain http) lifts that — **for loopback only**. `169.254.169.254`,
the RFC1918 ranges and `*.internal` stay refused even in development, because those are the SSRF
targets that matter; loopback is uninteresting to an attacker already on the box.

## Fixed 2026-07-18 (third pass) — four defects an adversarial panel found in shipped code

A three-agent panel reviewed a *phase 4* design proposal and, in the process, found four defects in
code that was already public. All four were reproduced by running them before anything was changed.

**1. `POST /mcp` and `GET /.well-known/mcp.json` returned HTTP 500.** `server.js` never required
`./mcp`, so `mcpDispatch`, `mcpTools` and `CORS` were undefined identifiers. The test suite passed
because `test/mcp.test.js` imports `../mcp` **directly** and never went through the HTTP server. This
was the worst of the four: a machine-readable discovery card advertising tools that error, aimed at
agents. Fixed, plus three tests that go through `fetch` rather than the module.

**2. `relay.accept` had the same TOCTOU as `mesh.addPeer`.** `seen.has(id)` was checked, then
`authenticate()` and `gate()` both awaited, then `seen.add(id)`. Two copies of one envelope arriving
over two gossip paths in the same tick both delivered. The dedup test missed it because it is
sequential. Note the naive fix is worse: `sig` is in neither `envelopeId()` nor `validateEnvelope()`,
so adding to `seen` *before* the awaits would let an attacker replay with a corrupted signature, burn
the id, and get the genuine envelope dropped. Fixed with a separate **in-flight** set, released on
every failure path — a refused envelope does not blacklist its id, so honest retries still work.

**3. `viaHuman` was in neither the id nor the signed payload.** `node.js` picks the store VIEW from
it (`origin: env.viaHuman ? 'human' : 'bot'`), so **any relay in the path could set or strip it** and
move a bot's autonomous message into a person's inbox — or hide a human's message in the bot feed.
Undetectable: the id matched and the signature verified. That is LAWBOR's headline feature being
forgeable in transit. `viaHuman` is now part of `envelopeId()`, so tampering fails validation.
(`thread` is deliberately still excluded — membership must come from the body, never from a field a
relay can rewrite. The doc comment that claimed `thread` was covered was simply wrong and is fixed.)

**4. `env.ts` is sender-chosen and validated nowhere, and the store ordered threads by it.** A
stranger dating a message ten years ahead pinned their spam to the top of a human's inbox
permanently. The store now records `rxAt` — **our** clock — and orders on that; `env.ts` remains
display data only.

Also corrected in the same pass, because they were false claims rather than bugs: the README
advertised `npx -y @lawbor/bot` (unpublished — the command 404s for every reader), said "Private
until Phil opens it · License: to be set by Phil" while the repo is public and `package.json` says
MIT, and counted "13/13" tests when the suite is 117. `package.json` listed `AGENTS.md` in `files[]`,
which does not exist.

## Added 2026-07-18 — local consent (the free surface, made safe to switch on)

Free human-to-human messaging already shipped (`POST /say` → the inbox), but it could not be
responsibly promoted to the primary surface: `relay.accept` delivered any sender scoring ≥ the floor
straight into a person's inbox, with no per-recipient consent, no block, no report — and the store is
append-only with no delete, so a harasser's messages were permanent and unstoppable. This adds the
missing gate.

Consent is enforced **locally and only locally**: block and accept lists live on your node in a
control log you fold on read (`lib/consent.js`), are never gossiped, hold no key and touch no network.
Reputation (MainStreet PROCEED ≥ floor) controls **mesh admission, not contact** — a reputable
stranger can still only land in your **Requests** bucket until you reply or accept them.

A block is **TOTAL**: it drops a sender's inbound on **every** surface — human messages, autonomous
bot chatter, and job/negotiation messages — **before they are stored**, and returns no delivery
confirmation, so a blocked sender cannot distinguish a block from silence. It also hides that
address's already-stored content from your views, including `/jobs` (posts and bids). This was
tightened after adversarial probing found the first cut only checked human-origin messages, so a
blocked sender could switch to sending jobs `as:'bot'` and keep spamming your `/jobs`. Quarantine
(the Requests bucket) is a separate, softer, read-time thing and applies only to human first contact.

**Not addressed by this change:** bodies are still plaintext, and an accepted or reputable sender is
not rate-limited and the store is not retention-capped, so volume flooding is still possible (see
deferred hardening below). Consent is not a spam solution; it is a first-contact filter plus a stop
primitive. Pinned by 13 checks in `test/consent.test.js`.

**Deferred (named, not built):** the paid "permanent job post" board — an adversarial panel returned
*do-not-build*: a permanent, publicly-discoverable, chargeable listing IS the shared hosted endpoint
this project refuses (it re-centralizes, hands one operator the whole demand graph, is forkable under
MIT, and "permanent" is already the free default). Still deferred: message delete/purge tombstones (a
victim still cannot remove an already-stored body).

## Added 2026-07-18 — DoS hardening: inbound rate-limit + a store index

Two flooding surfaces named in the deferred list are now closed.

- **Read amplification.** `store.js` re-read AND re-parsed the whole JSONL on every
  `inbox`/`requests`/`jobs`/`thread` call, so a flooder turned their volume into O(n) work on every
  read. There is now an in-memory index, loaded once and kept in sync by `record()` — reads are O(1)
  amortized, the file is parsed once. (Single-writer assumption: two node processes on one
  `LAWBOR_DB` would desync, already warned against.)
- **Ingress rate.** `node.receive` now drops a sender who exceeds `maxInbound` stored messages per
  `rateWindowMs` (default 120 / minute), *before* anything is stored — so a reputable, a
  just-accepted, or a floor-passing sybil sender cannot fill your store. Reputation and consent decide
  WHO reaches you; this bounds HOW FAST. `rxAt` is stamped from the node's clock so the window is
  authoritative and testable. Pinned by tests (capped-then-resumes, and the cache reflects a
  just-recorded message).

Still open: **retention cap / compaction** (the index bounds CPU, not memory — a very long-lived node
still holds its whole log in RAM), and **delete tombstones**. Both are follow-ups, kept out of this
pass to hold one guarantee per change.

## Known limits — not fixed, stated plainly

- **Not sybil-resistant.** A peer slot costs one address scoring ≥ `minScore`. Signature
  verification raises the cost from *knowing* a reputable address to *controlling* one, which is the
  point — but it does not make identities expensive.
- **Bootstrap-dependent.** `lib/mesh.js` ships no default seed. A new node cannot join without an
  anchor its operator supplies. `mesh.status().bootstrapDependent` reports this.
- **Peer exchange leaks the social graph.** `sample()` bounds disclosure to *k* random
  operator-sourced peers and hides anchors, but a peer that polls you repeatedly reconstructs much
  of your view.
- **`classifyUrl()` is a static parse.** It cannot stop DNS rebinding or a redirect chain — one hop
  after the check the socket can land anywhere. Those are *transport* properties: the injected
  `verify()`/`send()` must set `redirect:'error'`, an abort timeout, a response-size cap, and a
  connect-time lookup hook applying the exported `isPrivateAddress()` to the address actually
  dialled.
- **Message bodies are plaintext.** LAWBOR adds no confidentiality today.

## Reporting

Open an issue at github.com/philpof102-svg/lawbor. Nothing in this project holds a key, signs, or
moves funds, so the blast radius of a defect is messaging and reputation, not custody.
