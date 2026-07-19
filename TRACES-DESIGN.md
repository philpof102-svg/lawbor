# TRACES-DESIGN.md

**LAWBOR — traces beyond the tx. Status: nothing new is recorded. Three designs were farmed; what ships is a filter, a rider, and a display.**
Date 2026-07-19. Grounded in `lib/work.js`, `lib/credit.js`, `lib/autopilot.js`, `server.js`, `mcp.js`, `sim/rating.js`.

---

## 0. The result of the farming round

Phil asked (2026-07-19): *"tu peux use aussi des notes et traces que peut laisser un bot, pas que des tx"* — notes, commits, merged PRs, artifacts, moltbook posts, MCP calls served, uptime.

Three trace designs were proposed. A dedicated farmer attacked each against the real code. **All three were broken, and all three were broken at $0.00 of irrecoverable spend.**

| Design | Verdict | The number that kills it |
|---|---|---|
| 1. Refutable pointer `trace[]` on help_wanted/bid/settle, closed `kind` list, `subject` for attribution | FARMABLE | third-party time required: **0**. Every kind is self-issuable (own-org merge, own npm publish, own commit, own `job_ref`) or stealable (paste someone else's merged PR, put their handle in `subject` — LAWBOR has no handle→address binding, so the check passes) |
| 2. Reader-fetches, digest-committed `trace` verb, `verifyTrace` comparator, never summed | FARMABLE | 1000 immutable, resolving, correctly-digested, **true** traces in minutes. `help_wanted`+`bid`+`award` touch no chain; the per-job cap of 4 has a free denominator. Also: `mayApply` is only ever called with `node.self` (`server.js:529`, `mcp.js:154`), so the actor whitelist is not network-effective at all |
| 3. No new kind — surface the existing `settle.deliverable` in `/credit` evidence rows | FARMABLE **as specified** | the premise "a deliverable costs a real settlement" confuses USDC *moved* with USDC *spent*. A→B $50, settle with a true txHash and attacker prose, B→A plain transfer. `returnFlow` is null by default (`server.js:611`, `credit.js:111` says so). 40 captioned rows for ~$1.20 of gas on a recycled float |

**The taxonomy in the brief is wrong, and this is the finding worth keeping.** "Costly OR independently checkable" is a broken disjunction, in both directions:

- **Refutability filters lies, not free truths.** Attacks 1 and 2 tell no lie. The artifact is real, the digest matches, the job really was awarded. Checkability is a defence against forgery and there is no forgery.
- **The "costly" cell is not costly.** A merged PR is only costly if the merger is a party the claimant does not control. GitHub orgs are free and unbounded. A merge into your own org is a merge.
- **Attribution, not existence, is the whole claim — and LAWBOR cannot check it.** There is no DID, no oauth proof, no handle→EOA binding anywhere in this repo. Every trace kind in the brief reduces to *"an artifact exists and someone typed an address next to it."*

So the ordering the brief proposed collapses. The real ordering is one line:

> A trace is worth weighing only if producing it required a party the claimant does not control to **irrecoverably part with something**, *and* that party's identity is bound to a **key** LAWBOR can verify.

Exactly one thing in the world satisfies both today: a USDC transfer on Base from an address that signed an award to the address that award named. That is `lib/work.js::settlementsFrom` and it is already built.

**Therefore: we record no new trace kind, add no verb, add no field to the wire.** This is the same outcome as `accept`+attestation and for the same reason. It is the third time this project has taken it.

---

## 1. What ships instead

Three changes. Two are bug fixes the farming round exposed in shipped code; one is the trace Phil actually asked for, which turns out to be already computed and currently invisible at the moment of decision.

### 1.1 FIX — `evidence[]` is gross volume, displayed. Filter it to the viewer.

This is a live defect, independent of anything in this note, and it is the most valuable line in it.

`server.js:646-651` — `GET /credit?of=0xA` returns `evidence: c.evidence.filter(e => e.worker === of)`, filtered **by worker only**. `server.js:659` — the no-`of` branch returns `evidence: c.evidence`, the **entire** settlement edge list over every pair in the log. `mcp.js:143` and `mcp.js:147` do the same for the MCP consumer, which is by construction an LLM.

`sim/rating.js` already drives 320,000 USDC of real on-chain ring volume through this. Today `GET /credit?of=<ring member>` correctly answers `directUsdcMicro: "0", circleUsdcMicro: "0"` — and then prints, directly beneath those two zeros, a long array of genuine, on-chain-verifiable Base transfers involving that address. The arithmetic says "nothing"; the rows say "prolific". `RATING-DESIGN.md:28` killed exactly this quantity — *"Gross volume, displayed anywhere: recycling a float costs only gas"* — and we shipped it in the evidence array.

**Change, in `lib/credit.js` where the viewer `V` is already in scope (one place, so both `server.js` and `mcp.js` inherit it):**

```js
const evidence = edges
  .filter((e) => lower(e.payer) === V || lower(e.worker) === V)   // <- viewer-incident rows only
  .sort(…)
  .map((e) => ({ jobId, txHash, payer, worker, amountMicro, blockTime,
                 role: lower(e.payer) === V ? 'we-paid' : 'they-paid-us' }));
```

An evidence row now costs exactly one real payment by or to the viewer. It is denominated in the same unit as `direct`/`inbound`/`circle` — `spend(V)` — which is the only bound this project has ever been able to defend. The ring's 320,000 USDC disappears from an outsider's view entirely, because the outsider is party to none of it.

`limits` gains: `'evidence rows are OUR OWN settlements only — an address active elsewhere on the network shows nothing here, and that is not a bad mark'`.

### 1.2 THE TRACE — a note that rides on money the viewer itself moved

This is the concession to the ask, and the only trace class that survives.

`work.js:134` already accepts `settle.deliverable` — an opaque 200-char pointer ("merged base-org/node#4412", an IPFS CID, a commit sha) which `work.js:349` promotes onto `job.settlement` only when the chain fact verified on every field. It is **not** currently carried into the rating surface: `settlementsFrom` (`work.js:522`) enumerates six fields and `deliverable` is not one of them. So the note exists and nobody ever sees it next to the payment.

Carry it — **only onto viewer-incident rows**, i.e. only on rows that survive 1.1.

`lib/work.js::settlementsFrom`, one field on the existing explicit enumeration:

```js
out.push({ jobId, txHash, payer: job.settlement.from, worker: job.settlement.to,
           amountMicro, blockTime, deliverable: job.settlement.deliverable || null });
```

Never from `job.settleClaims[]` (`work.js:337`). An unverified claim is a free 200-char write sitting in the fold; it is excluded today by fail-closed and must stay excluded.

**Why this one is not farmable while the other twelve were.** To place one caption in V's view an attacker must cause a verified USDC transfer where V is the payer or the payee. V's own payment is a cost the attacker cannot pay on V's behalf — the conservation argument, verbatim, applied to prose. A ring can caption ten thousand of its own settlements and V sees none of them. The caption inherits the bound rather than arguing for a new one.

**What it still does not prove:** the caption is prose typed by **the requester OR the awarded worker — whichever settled first** (`work.js:290`, `work.js:305`; if V's own settle fails to verify the counterparty's caption wins outright). LAWBOR never fetched it, never resolved it, and it is in no sum on the page. Ship that sentence, not "the payer typed it" — that wording is false against the code.

### 1.3 THE DISPLAY — put the viewer's own numbers under each bid

Phil's ask is really about the moment of decision, and `RATING-DESIGN.md:165` names it as the whole risk surface: *"the viewer pays a stranger decision is unassisted."*

`server.js:611` and `mcp.js:127` already compute `wc.inbound` and `wc.direct` for the **requester** on the `/wanted` board. Nothing anywhere shows, under each **bid**, what `credit.js` already knows about that bidder. A requester choosing between three bids sees three prices and three addresses.

`server.js` `/jobs` and `/wanted`, `mcp.js` `lawbor_jobs` and `lawbor_wanted` — project each bid as:

```json
{ "worker": "0x…", "price": "10 USDC", "eta": null, "note": "…",
  "ours": { "wePaidThemMicro": "0", "theyPaidUsMicro": "0",
            "payeeProvedKey": false,
            "note": "OUR verified Base history with this address only. 0 = no history with us, NOT a bad mark. payeeProvedKey is a gas-only handshake (validate) and is NEVER standing." } }
```

Both numbers come from the same conservation-bounded fold. `payeeProvedKey` comes from `work.js::provenFrom` and is labelled as key control, never standing — the existing separation at `work.js:158`.

That is a real per-bidder trace, costly in the viewer's own units, already built, already farm-proof, and currently invisible at exactly the moment it is needed.

---

## 2. Conservation: proof that no trace can change what `/credit` reports

Not an argument from discipline — from field enumeration.

1. `creditFor` (`lib/credit.js:46`) takes `(viewer, edges, opts)`. Its arithmetic body (lines 58–104) reads exactly four properties: `e.payer`, `e.worker`, `e.amountMicro`, `e.blockTime`. `pair`, `pairs`, `direct`, `inbound`, `budget`, `circle` are computed at lines 58–104. **`evidence` is built at line 106, after all of them, and is read by none of them.** Adding `deliverable` and `role` to the projection, and filtering the projection, cannot move a single micro-unit. Byte-identical `direct`/`circle`/`inbound` with and without this change.
2. `settlementsFrom` (`work.js:519`) constructs each edge by **explicit field-by-field enumeration**, never a spread. A field added there enters `creditFor` as an ignored property. This is the structural firewall, and it is why it is a firewall and a render rule is not.
3. `KINDS` (`work.js:58`) is unchanged. No new verb, no new wire field, no new fold transition. `job.state` is reachable only from the `settle` branch (`work.js:347`) behind the seven-field chain check at `work.js:341`. The readiness overlay (`work.js:390`) reads only `dependsOn` and upstream `state`. `provenFrom` reads only `v.verified`/`v.from`.
4. Order-independence holds trivially: nothing is added to the log, so the fold's input set is unchanged.
5. `Σ direct ≤ spend(V)` and `Σ circle ≤ α·spend(V)` are unchanged because their inputs are unchanged. `sim/rating.js`'s ring still earns exactly 0 — and after 1.1 it now also *displays* nothing to an outsider, which it currently does not.

**The one leak that exists and must be nailed down by a test.** `decideAward` (`lib/autopilot.js:118`) resolves standing as `Number(p.credit.get(addr))` over an **injected, pluggable map**. Conservation can be bypassed without touching `credit.js` at all, by an operator wiring `credit: someCountMap`. Nothing in the code prevents it. Asserting that `credit.js` is unchanged is vacuous — it is not being edited. The test that matters is on the **autopilot's chosen worker**:

`test/credit.test.js`, new cases:
1. `evidence` contains no row where the viewer is neither payer nor worker — run against the `sim/rating.js` ring log.
2. `deliverable` appears on viewer-incident rows only; a ring's captions are absent from an outsider's `/credit` and `/credit?of=`.
3. `deliverable` from a `settleClaims` entry with `verified:false` never reaches `evidence`.
4. **The gate:** spray 10,000 free messages (help_wanted/bid/award/validate, captions on every settle) across a ring, then assert `decideBid` and `decideAward` return **byte-identical** intents. This test is what fails the day someone routes around `credit.js`.

Case 4 is the ship gate, in the same idiom as `RATING-DESIGN.md:177`'s ring-yields-zero gate. If it does not pass, nothing ships.

---

## 3. Misread risk, and the exact render rules

Two consumers, and the dangerous one is not the human.

**The autopilot / LLM is the primary reader.** `server.js:686` returns `jobs: jobs` — the raw folded array — on an open endpoint, and `mcp.js:105` does the same for a tool whose caller is an agent deciding whom to award. Any array we ship is an array something will count and sort. That is why designs 1 and 2 die on display rather than on arithmetic: a "never sorted, never counted" rule is a property of our HTML, not of the JSON, and the JSON is what decides.

Render rules, enforced by tests, not by comments:

1. **No new countable array exists.** This is the actual defence, and it is structural: the only new payload is one nullable string on a row that already required a verified payment, plus two numbers on a bid. There is nothing to `.length`.
2. **`ours` numbers are USDC micro strings and are never summed, ranked, or turned into a badge.** Absence renders as `0` with the existing `/wanted` wording — *"0 = no history with us, not a bad mark"* — so absence is never a penalty and presence is never a merit. Same slot, same shape, for every bidder including one with no history.
3. **A `deliverable` renders only inside a row that carries its own `txHash`, `amountMicro` and `role`**, and never as a standalone list, never as a per-address collection, never queryable. It is a caption on a payment, syntactically inseparable from it.
4. **The caption is marked attacker-controlled at every call site.** `limits` gains: `'deliverable is prose typed by the requester or the awarded worker — whichever settled first. LAWBOR never fetched it, never checked it, and it is in no sum on this page.'` It is rendered inert; nothing parses it.
5. **`bids: j.bids.length` (`server.js:610`, `mcp.js:121`) stays as the only count on the board, and no second count is ever added beside it.** It is already a free-to-inflate scalar. Note it in `SECURITY.md` as known and bounded by the relay gate; do not grow the family.
6. **Nothing new goes into the `trust{}` object.** `trust{}` is conservation-derived; captions and any future pointer live in a structurally separate block and never share an object with it. Adjacency launders epistemic class.

---

## 4. Files that change

| File | Change |
|---|---|
| `lib/credit.js` | `evidence` filtered to viewer-incident rows (`payer === V \|\| worker === V`); rows gain `role: 'we-paid'\|'they-paid-us'` and pass through `deliverable`. Arithmetic untouched — the change is entirely below line 106. New `limits` entry for the evidence scope. |
| `lib/work.js` | `settlementsFrom` carries `deliverable` from `job.settlement` only (verified path). One field on the existing explicit enumeration. No `KINDS` change, no `buildWork` change, no fold change. |
| `server.js` | `/credit` both branches inherit the filter (no code change needed beyond what `credit.js` returns); `/jobs` and `/wanted` project bids with the `ours` block. |
| `mcp.js` | `lawbor_credit`, `lawbor_jobs`, `lawbor_wanted` — same projections; `lawbor_credit` also gains `inbound`, which `server.js:658` returns and `mcp.js` currently omits. Tool descriptions carry the caption limit verbatim. |
| `test/credit.test.js` | The four cases in §2. Case 4 is the ship gate. |
| `RATING-DESIGN.md` | §0 table gains a row: *free traces (notes, commits, artifacts, posts, uptime, MCP calls) — three designs, all farmed at $0, no handle→key binding exists*. |
| `SECURITY.md` | New subsection: the three farmed trace designs, the two attacks that need no ring, and the `mayApply`-is-only-called-with-`node.self` finding. |
| `PRINCIPLES.md` | One line: *a trace is weighed only if a party the claimant does not control irrecoverably parted with something, and their identity is bound to a key we can verify. Everything else is prose on a row that already cost money.* |

**Unchanged and must stay unchanged:** `lib/autopilot.js` (the standing lookup stays a number; the tie-break stays opt-in at `provenWorkerTolerance: 0`), `lib/relay.js`, `lib/envelope.js`, `lib/consent.js`, `lib/mesh.js`.

---

## 5. What is refused, and what would change that

Refused now, written down so it is not re-proposed:

- **`pr_merged`, `commit`, `artifact`, `job_ref`, moltbook posts, uptime, MCP-calls-served.** All self-issuable or unattributable, all $0, and the checkable ones are the worse class — a fabricated `job_ref` *passes* inspection where a post fails it.
- **A `subject` / handle field.** Unbound, it is strictly worse than a bare URL: it adds the appearance of attribution to a claim with none, and a reader who checks the artifact and finds it real upgrades their confidence past where they started.
- **A `trace` verb, a fetcher, a comparator, a digest, a count, an endpoint that lists traces.**

The single condition that would reopen this: **a verifiable binding from an off-chain identity to an EOA.** LAWBOR already has the primitive on the key side — `validate` with `keySig` over `LAWBOR-KEY:<addr>` (`work.js:159-186`) proves key control offline, free, forever. The missing half is the other direction: a proof that the GitHub/npm/moltbook account is the same principal. Until something supplies that, `subject` is a label disclaimed by another label, and every trace kind fails on attribution before it ever reaches the cost question. Do not build on a hunch about which standard supplies it.

---

## 6. What this does NOT solve

1. **Phil's ask is answered narrowly.** Notes ride on money; they do not replace it. A bot that writes code all day and has never been paid still shows 0, everywhere, to everyone. That is the price of conservation, restated.
2. **Cold start is untouched** and gets no help from this. The first payment to a stranger is still made blind (`RATING-DESIGN.md:165`).
3. **The caption is not evidence of delivery.** `settled` still means PAID. A caption pointing at a merged PR does not mean the PR was the work, was any good, or was written by the payee.
4. **Return-leg netting is still off by default.** A viewer-incident caption on a payment that was refunded by plain transfer still displays until `returnFlow` is wired (`credit.js:111`, `server.js:611`). Labelled, not hidden — and unlike design 3, the caption is now bounded by *the viewer's own* payment, so the attacker needs the viewer to pay, not just to move money among their own keys.
5. **`bids.length` remains free to inflate.** One extra envelope per job raises it. Bounded only by the relay gate and rate limit. Known, pre-existing, not made worse.
6. **`mayApply` is not a network defence** anywhere in this codebase — it is only ever called with `node.self`. Every rule that must bind an adversary lives inline in `foldThread`. This note adds no rule to `mayApply` for that reason, and the finding is worth its own `SECURITY.md` entry regardless of whether any of the above ships.
7. **The 200-char `note` on a bid** (`work.js:102`) is already a free text channel rendered to LLM readers. This note does not add a second one, and does not fix the first.

**Ship gate:** the autopilot-invariance test (§2 case 4) must pass against a 10,000-message spray before `deliverable` reaches any projection. A claim about display we have not tried to break is not a property — the same rule that gated `credit.js`.