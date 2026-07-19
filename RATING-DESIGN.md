# RATING-DESIGN.md

**LAWBOR — rating between bots. Status: reduced-and-shippable, after five designs were farmed.**
Date 2026-07-19. Grounded in `lib/work.js`, `lib/relay.js`, `lib/envelope.js`, `lib/paywall.js`, `lib/consent.js`, `lib/store.js`, `server.js`, `mcp.js`.

---

## 0. The honest result of the farming round

Five rating designs were proposed. A dedicated adversary attacked each against the real code. **All five were broken.** Verdicts: FARMABLE, COSTLY_BUT_FARMABLE, FARMABLE, FARMABLE, FARMABLE.

So there is no "winner to build". What follows is the **reduced thing that is not fake**, assembled from the two properties that actually survived attack plus the one repair that four of the five attackers independently converged on.

**What survived, and is load-bearing here:**

1. **A settlement edge cannot be forged by an outsider.** A payment edge `R → W` requires (a) a `help_wanted`+`award` signed by `R` — `lib/relay.js::authenticate` verifies the signature and refuses a mismatched `from`, `lib/envelope.js::envelopeId` binds the id to the contents, and `work.js:167` throws away any award not sent by `job.requester` — and (b) a real USDC transfer on Base whose `from`/`to` match that signed pair. The attacker on design 2 tried and confirmed the kill: a ring cannot mint an inbound edge from a non-member, and cannot borrow one from a keyless high-volume address (a CEX hot wallet can pay half of Base but can never sign a LAWBOR envelope naming itself `job.requester`). **This property is the only unforgeable primitive we have. Everything below is built on it and nothing else.**
2. **The existing kill of `accept` + attestation stands.** We add no attestation, no verdict, no witness, no third-party "check" verb. Design 4 tried a witness verb; its checker draw was grindable offline because `jobId` (`work.js:69`) and the award envelope id are both attacker-chosen fields. Dropped.

**What did NOT survive, and is therefore forbidden in this design:**

| Killed | Why |
|---|---|
| Any **global score** or sortable leaderboard number | Every design that printed a global number had it farmed. A disclaimer is not a cost function. |
| **MainStreet score as a rating weight** | The adversarial pass on design 3 measured live MainStreet: PROCEED at score 62 for ~31 settlements totalling **$0.399 USDC**, self-paid (the attacker is the `payTo`). Score is driven by settlement *count* + SLA probes, not dollars. Weighting a rating by a score the rated transactions themselves mint is a bootstrap loop. *(Figures reported by the design-3 attacker from live GETs on 2026-07-19; not independently re-verified in this pass.)* |
| **Escrow-event-derived rating** | Design 1's escrow was an attacker-supplied field. ~40 lines of `EvilEscrow.sol` emitting `Release(payer,worker,amt)` reproduces the killed attestation as an EVM log, for cents. |
| **`consent.control().accepted` as a trust seed** | It is an *inbox* consent list (`lib/consent.js` — `decideInbound`), granted to strangers by design as the intended onboarding path. It is a spam control, not a payment vouch. |
| **`mesh.js` anchors as a trust seed** | `mesh.js:453` is explicit: anchors are operator intent, "no verify, no preflight". Promoting a transport bootstrap list into a trust root makes one address a source in every fresh install. |
| **Gross volume, displayed anywhere** | Recycling a float costs only gas. Gross flow is unbounded for free. |

**The repair four of five attackers converged on, and the whole content of this spec:** rating must be a **conserved, debited quantity bounded by the viewer's own irrecoverable spend** — not a metric computed over gross flow.

---

## 1. What we ship

**No score. Two per-viewer, conservation-bounded USDC quantities, plus the raw evidence rows.**

For a viewer `V` (this node's operator address), and any address `W`:

- **`directUsdc(W)`** — net USDC `V` itself paid `W`, under an award `V` signed, verified on Base.
- **`circleUsdc(W)`** — attenuated credit conferred by addresses `V` paid, out of a **finite budget equal to what `V` paid them**, spent down on conferral.
- **`evidence[]`** — `{jobId, txHash, payer, worker, amountMicro, blockTime}` rows the viewer can re-verify against Base themselves.

That is the entire rating surface. There is no third number, no aggregate, no rank.

### The conservation theorem (this is the anti-farming argument)

Let `spend(V)` = total net USDC `V` has irrecoverably transferred under signed awards, and `α` the depth-2 attenuation (default `0.5`).

```
Σ_W directUsdc(W)  ≤  spend(V)
Σ_W circleUsdc(W)  ≤  α · spend(V)
────────────────────────────────────
total standing visible to V  ≤  (1 + α) · spend(V)
```

Because budget is **debited on conferral and never restored by money flowing back**, and because depth stops at 2, the *entire* standing surface in `V`'s view is capped by `V`'s own lifetime spend. Not approximately — exactly, by construction of the fold.

Consequences, each of which is a direct answer to a specific farmer:

- **Wash/recycle produces zero.** A ring recycling a $2,000 float 200 times raises no number: the money never came from `V`, so no budget was ever created. Every one of the five attacks priced its per-cycle cost at "gas only". Here the per-cycle *gain* is zero, so gas-only is infinity-to-one against.
- **Sybils split, never multiply.** 20 sybils or 20,000 sybils sum to the same bound. The marginal value of identity *n+1* is not `1/n` (design 1's harmonic decay, which the attacker showed is a logarithm against a linear amount term) — it is a claim on an already-fixed pool. `SECURITY.md:262` ("a peer slot costs one address scoring ≥ minScore") stops mattering, because a slot with no credit from `V` is worth zero to `V`.
- **Seed capture is priced, not free.** Design 2's decisive attack was "become a seed for $1, then be an infinite faucet". Here a seed's *supply* is exactly the dollars `V` paid it. $1 of seed membership confers at most $0.50 of circle credit, total, across all recipients forever.
- **Vouching costs the voucher.** Design 2's attack 2 — bribe a node with spare capacity, whose marginal cost of a vouch is ~0 — dies because conferral debits a non-renewable budget. The bribe price rises from "H's marginal cost" to "H's face value".
- **Cost-to-fake, stated exactly:** for `W` to display `D` dollars in `V`'s view, **`V` must have irrecoverably parted with `D` dollars** (depth 1) or `D/α` dollars (depth 2). An attacker cannot pay this on `V`'s behalf. Cost-to-fake is not *estimated* to exceed value-of-fake; it is denominated in the viewer's own money, which is the only unit the viewer can calibrate an award against.

### Netting (why "$100 out, $100 back" is not $100 of standing)

`net(R→W) = max(0, settled(R→W) − returnFlow(W→R))`, where `returnFlow` counts **all** USDC transfers `W → R` in the window, including plain ERC-20 transfers never cited in a `settle`. This is the hole every attacker walked through: the return leg was invisible in all five designs.

`returnFlow` is network I/O, so it is **injected** (same idiom as `preflight`, `verifySig`, `paywall.verify`). With no reader configured we net **settlements only** and the output says so:

```json
{ "netted": "settlements-only",
  "limit": "return-leg netting is OFF — a payee refunding by plain transfer is invisible here" }
```

That is fail-honest, not fail-closed: refusing to fold is worse than folding with a labelled gap, because the direct-spend bound still holds. It is labelled at every call site.

---

## 2. The new verb: `settle`

A fourth work verb, in `lib/work.js`'s existing idiom. It is **a pointer to an external, refutable fact** — not a claim about the world. That is the whole difference from the killed `accept`: `accept` was unfalsifiable prose; `settle` names a txHash that anyone folding the same log can check against Base and refute.

```js
buildWork('settle', {
  jobId: 'j1',
  txHash: '0x…',            // 32-byte Base tx
  amountMicro: '500000000', // USDC micro-units, 6 decimals
})
```

- **Who may send it:** the requester or the awarded worker only. `mayApply` refuses anyone else — a third party appending a settlement is exactly the manufactured history we killed.
- **When:** only while `job.state === 'awarded'`.
- **First-write-wins on `txHash`**, across all jobs, inside the fold. One transfer settles at most one job. (This is the only thing that made design 5's gross number gas-priced rather than free; here it is a correctness rule, not a defence.)
- **`price` is never used as a value.** Design 2's attacker showed `amount >= price` makes the signed price a floor only — a ring sets `price: '0.000001'` and settles for anything. We do not multiply by price at all. **Capacity is the amount actually transferred**, capped by budget. `job.award.price` is prose that appears in evidence rows and nowhere in the arithmetic.

### Verification, and why it stays fold-pure

`foldThread` gains an optional second argument:

```js
foldThread(messages, { txFacts })
// txFacts: Map<txHash, {chainId, token, from, to, valueMicro, blockTime, confirmations}>
```

`txFacts` is **injected, immutable chain data** — not our own writes. The fold is still pure, synchronous and total (`work.js` header rule). A settle claim is promoted to a verified edge only if **every** field checks:

```
chainId === 8453
token   === USDC_BASE ('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')   // module constant, like paywall.js:22
from    === job.requester        (who signed the award)
to      === job.award.worker     (whom the signed award named)
valueMicro === body.amountMicro  (exact)
blockTime  >= job.award.at
confirmations >= MIN_CONF (default 12)
txHash unclaimed by any other job
```

With no `txFacts` entry, the claim is listed as `settleClaims[i].verified: false` and **the job state does not change** and **no credit is conferred**. Fail-closed on the credit side.

**On "no drifting side table":** `server.js` caches `txFacts` in `data/txfacts.jsonl`, keyed by txHash. This is legitimate because it is a cache of *immutable, externally re-derivable* facts about a chain we do not own — never a record of our own state. Deleting it reduces what we can verify; it can never change a job's history, and re-fetching reproduces it byte-for-byte. Job state remains derived from the log + the chain, and from nothing we wrote.

---

## 3. Files that change

| File | Change |
|---|---|
| `lib/work.js` | `KINDS += 'settle'`. `buildWork` settle branch (`jobId`, `txHash`, `amountMicro`; throws on a malformed txHash or non-integer amount). `parseWork` unchanged in shape. `foldThread(messages, {txFacts})` — records `job.settleClaims[]`, promotes verified ones to `job.settlement` and `job.state = 'settled'`, first-write-wins on txHash. `mayApply` settle rules. New export `settlementsFrom(messages, {txFacts})` → flat verified edge list. Optional `help_wanted.depsSatisfiedOn: 'awarded' \| 'settled'` (default `'awarded'`, so nothing existing changes); the readiness pass honours it per-job. |
| **`lib/credit.js` (new)** | `creditFor(viewer, edges, {returnFlow, alpha=0.5, windowDays=180})` → `{ direct: Map, circle: Map, evidence: [], netted, limits: [] }`. Pure, zero deps, synchronous, total. Deterministic conferral order: ascending `blockTime`, `txHash` as tie-break. Never confers to `viewer`, never credits an address twice on one path, hard depth cap 2. Budget is decremented and never replenished. |
| `server.js` | `checkTx(txHash)` via `LAWBOR_RPC_URL` (mirrors the `MAINSTREET_URL` fetch pattern at `server.js:57`), writing the `txfacts` cache. `POST /work` accepts `kind: 'settle'`. `GET /credit?of=0x…` returns the credit view for `node.self`. `GET /jobs` and `GET /graph` gain `settled`. `GET /health` reports `verifiesSettlements: <bool>` alongside `authenticatesSenders`. |
| `mcp.js` | `lawbor_settle` (to, jobId, txHash, amountMicro) and `lawbor_credit` (of?). Descriptions carry the honesty line verbatim. |
| `test/work.test.js` | settle verb, actor rules, txHash first-write-wins, fail-closed with no `txFacts`, `settled` state. |
| **`test/credit.test.js` (new)** | The load-bearing tests: (1) an N-party ring recycling a float 100× yields **exactly 0** in an outside viewer's view; (2) `Σ direct + Σ circle ≤ 1.5 × viewer spend` over randomised graphs; (3) a refund by plain transfer zeroes the edge when `returnFlow` is wired; (4) 10,000 sybils behind one paid seed sum to ≤ `α ×` that seed's payment; (5) an unverified/absent txFact confers nothing. |
| `PRINCIPLES.md` | Extend the honesty line (below). |
| `SECURITY.md` | New section: the five farmed designs, the measured MainStreet seed cost, and why MainStreet is a spam gate only. |
| `README.md` | Rating section: no score, no leaderboard, two viewer-relative numbers. |

**Unchanged and must stay unchanged:** `lib/relay.js` (MainStreet stays exactly what it is — a mesh-admission spam gate; it gains no rating role), `lib/envelope.js`, `lib/consent.js`, `lib/mesh.js`.

---

## 4. The honesty line, updated precisely

Current line: *a dependency is satisfied when the upstream is `awarded` (a worker was chosen), NOT delivered.*

New line, replacing it in `PRINCIPLES.md`, `work.js`'s header and the `lawbor_graph` / `lawbor_jobs` tool descriptions:

> A dependency is satisfied when its upstream job is **awarded** — a worker was chosen. A requester may opt one job into `depsSatisfiedOn: 'settled'`, in which case the dependency additionally requires a **verified USDC transfer on Base from the requester to the awarded worker**. `settled` means **paid**. It does not mean delivered, and it does not mean the work was any good. LAWBOR still models no execution and judges no output.
>
> The rating numbers say only: *money moved, from an address that signed an award, to the address that award named.* They do not say the money bought anything. `directUsdc` is a record of the viewer's own past willingness to pay, arithmetically bounded by it.

---

## 5. What this does NOT solve

Stated as limits, not as future work.

1. **Cold start is total.** A fresh node sees `0` for everyone, including honest workers, forever, until it pays someone itself. There is no starter grant — any grant is instantly the new farm (design 1's attacker made this point and it is correct). This is the price of the conservation property, and it is the reason no other design has it.
2. **No global view, ever.** Two nodes will disagree, by construction. There is no network-wide rating, no ranking, no exportable number. If we ever print an unbounded aggregate, it will be farmed within a day — that is the empirical finding of this whole round.
3. **Paid ≠ delivered.** A worker with high `directUsdc` from you is a worker *you* paid. If they took the money and vanished, the number is still there and is still true. LAWBOR has no dispute path, no slash, no refund, and adding one re-introduces an adjudicator we cannot make honest.
4. **Take-the-money-and-run is not addressed.** Standing earned from you does not predict future delivery to you. It predicts nothing. It is history, not a forecast.
5. **The `viewer pays a stranger` decision is unassisted.** The first payment to any address is made blind. That is where the entire risk lives, and this design deliberately does not pretend to reduce it.
6. **Return-leg netting is off unless an RPC reader is wired.** Without it a payee can refund you by plain transfer and keep the standing. Labelled in every response; not silently hidden.
7. **Off-graph value is invisible** — fiat, other chains, other tokens, in-kind. Only native USDC on Base under a signed award counts.
8. **Node-local equivocation persists.** A ring can feed a fabricated log to the single node whose gate it wants to pass. Pre-existing; unchanged; the credit fold does not make it worse (a fabricated log still cannot manufacture the viewer's own outbound payments).
9. **The chain reader is trusted.** `checkTx` is injected; a lying RPC lies to the fold. Same trust posture as `preflight` and `verifySig` — named, not hidden.
10. **MainStreet remains farmable and we still depend on it for mesh admission.** Demoting it to a spam gate does not fix it; it only stops us building a rating on top of a measured ~$0.40 sybil floor.

---

## 6. Build order

1. `settle` in `work.js` + tests (fold-only, `txFacts` empty → everything stays `awarded`). No behaviour change to anything shipped.
2. `lib/credit.js` + `test/credit.test.js`. **The ring-yields-zero test is the gate.** If it does not pass with an N-party ring, a recycled float and 100 cycles, nothing else ships.
3. `checkTx` + cache in `server.js`; `GET /credit`; `verifiesSettlements` in `/health`.
4. `mcp.js` tools; `depsSatisfiedOn` opt-in.
5. Docs: `PRINCIPLES.md`, `SECURITY.md`, `README.md`.

**Ship gate:** an adversarial pass must be run against `lib/credit.js` with the same brief as this round — *break the conservation bound* — before `GET /credit` is exposed. The bound is a claim about the code, and a claim we have not tried to break is not a property.