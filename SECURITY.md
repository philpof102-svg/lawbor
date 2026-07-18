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

## Not yet wired — mesh.js is inert

`server.js` still keeps its own `const peers = new Map()` and `POST /peers` still calls the ungated
`relay.addPeer`. So today the peer layer's checks protect nothing in the running node, and
`selectTargets()`'s fan-out cap does not exist in the live path. Wiring it (relay taking
`peers: () => mesh.addrs()`, the transport resolving through `mesh.urlFor()`, and both branches of
`relay.accept/originate` routing through `selectTargets`) is the next change. Until then, treat
`lib/mesh.js` as reviewed-but-unused code, not as an active defence.

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
