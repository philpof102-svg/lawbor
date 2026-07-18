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
