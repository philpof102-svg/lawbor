'use strict';
/**
 * LAWBOR — work.js  (the three verbs that turn messaging into doing business)
 * ============================================================================
 * A work message is an ordinary LAWBOR envelope whose `body` is a typed JSON payload. Nothing new on
 * the wire, nothing new in the store: a job's state is DERIVED by folding the thread it lives in.
 * That is deliberate — a separate job table could drift from the message log, which is exactly the
 * failure this project already hit when the transport map and the relay's peer set disagreed.
 *
 * THREE VERBS ONLY, and the reason for each cut is written down:
 *   help_wanted — a requester states a need           (open the job)
 *   bid         — a worker answers with a price       (many, one live per worker)
 *   award       — the requester picks one             (close the job)
 *   cancel      — the requester withdraws             (their own escape hatch, so it is honest)
 * `availability`, `deliver`, `accept`, `reject` are NOT here. An adversarial panel showed each of
 * them either does nothing without a settlement rail (which we have not built) or actively invites
 * abuse: `accept` plus an attestation lets two colluding addresses manufacture a work history from
 * nothing. Negotiation is self-contained and can be completed honestly; execution cannot, yet.
 *
 * 🚧 WHAT THIS IS NOT. LAWBOR work messages carry a negotiation to an agreed price and an agreed
 *   worker; the `settle` verb then binds that job to a REAL USDC transfer on Base. But LAWBOR still
 *   holds no key, moves no funds, releases no funds and enforces no delivery: the exchange happens
 *   directly between the two parties on-chain, and `settle` only records a txHash that anyone folding
 *   the same log can VERIFY against Base and refute. `settled` means paid — never delivered, never
 *   "the work was any good". No escrow, no dispute path, no adjudicator (adding one re-introduces the
 *   authority we cannot make honest). So: reputation-gated negotiation whose outcomes can be proven
 *   paid, not a labour market that clears an exchange for you.
 *
 * Design points that exist because the panel broke the first draft:
 *   - `jobId` is CHOSEN BY THE REQUESTER and carried in the body, never the envelope id. A
 *     "broadcast" is N envelopes with N different ids (`to` is inside the id), so an envelope-id job
 *     key would fragment one job into N markets.
 *   - `award` is SELF-CONTAINED (worker + price + eta), not just a bidId. Gossip has no ordering, so
 *     an award can arrive before the bid it names; requiring the bid first would strand the job.
 *   - Ordering uses the RECEIVER's clock (`rxAt`), never `msg.ts` — a sender picks their own ts and
 *     nothing validates it.
 *   - The reducer is SYNCHRONOUS and total. Anything that awaits mid-transition reproduces the
 *     TOCTOU that voided guarantees twice already in this repo.
 *   - Only `job.from`'s node is authoritative. Other nodes RENDER a job; they never refuse a
 *     transition signed by the requester on the grounds of their own partial view.
 *
 * DEPENDENCY GRAPH (help_wanted.dependsOn). A job may name other jobIds it depends on. This turns the
 * flat job list into a graph — the coordination substrate an agent ORG needs so a swarm does not bid on
 * "deploy" before "build" is settled. Two honesty rules make it not-a-lie:
 *   - A dependency is SATISFIED when the upstream job is `awarded` (a worker was chosen), NOT when work
 *     was delivered. LAWBOR models no execution or settlement (see "WHAT THIS IS NOT"), so this orders
 *     NEGOTIATIONS; it does not track task completion. Framed as such everywhere.
 *   - Readiness is DERIVED (a second fold pass), never a stored field, so it cannot drift and two nodes
 *     that saw the same messages compute the same ready/blocked set. A job with unmet deps is
 *     `ready:false` and takes no bids (gated in mayApply, which server.js + mcp.js call at accept time).
 * The graph REWRITES ITSELF at runtime for free: any node can append a new help_wanted whose dependsOn
 * points at a live job (a worker spawning sub-tasks, a checker re-opening on failure). The fold absorbs
 * new nodes with no schema change — a "dynamic agent org" is just more append-only envelopes.
 */

const MARKER = 'lawbor.work';
const V = 1;
const KINDS = ['help_wanted', 'bid', 'award', 'cancel', 'settle', 'validate'];

// settle binds a job to a REAL USDC transfer on Base. LAWBOR verifies nothing itself (it has no network);
// the fold is handed immutable chain facts (injected) and refuses to credit anything it cannot check.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';   // USDC on Base, 6 decimals (lowercased)
const BASE_CHAIN_ID = 8453;
const MIN_CONF = 12;

const MAX_TEXT = 400;
const MAX_TAGS = 8;
const MAX_DEPS = 16;   // a job naming more upstreams than this is almost certainly malformed/abusive
const str = (x, n = MAX_TEXT) => (typeof x === 'string' ? x.trim().slice(0, n) : '');

/** Build the body string for a work message. Throws on nonsense — a malformed job helps nobody. */
function buildWork(kind, fields = {}) {
  if (!KINDS.includes(kind)) throw new Error('unknown work kind: ' + kind);
  const b = { [MARKER]: V, kind };

  if (kind === 'help_wanted') {
    b.jobId = str(fields.jobId, 80);
    b.task = str(fields.task);
    if (!b.jobId) throw new Error('help_wanted needs a jobId (chosen by the requester)');
    if (!b.task) throw new Error('help_wanted needs a task');
    b.tags = (Array.isArray(fields.tags) ? fields.tags : []).map((t) => str(t, 24)).filter(Boolean).slice(0, MAX_TAGS);
    if (fields.budgetHint) b.budgetHint = str(fields.budgetHint, 40);
    // WHERE the work is — the common shape of a real job is a code bounty ("fix this, suggest that"),
    // so a job can point at the repo / issue / file it is about. An OPAQUE pointer: LAWBOR never
    // fetches, resolves or judges it, exactly like settlementRef before it.
    if (fields.ref) b.ref = str(fields.ref, 200);
    if (fields.dependsOn) {
      // upstream jobIds this job waits on; a job cannot depend on itself, dups collapsed, count capped
      const deps = [...new Set((Array.isArray(fields.dependsOn) ? fields.dependsOn : [])
        .map((d) => str(d, 80)).filter((d) => d && d !== b.jobId))].slice(0, MAX_DEPS);
      if (deps.length) b.dependsOn = deps;
    }
  } else {
    b.jobId = str(fields.jobId, 80);
    if (!b.jobId) throw new Error(kind + ' needs a jobId');
  }

  if (kind === 'bid') {
    b.price = str(fields.price, 40);
    if (!b.price) throw new Error('bid needs a price');
    if (fields.eta) b.eta = str(fields.eta, 40);
    if (fields.note) b.note = str(fields.note, 200);
  }
  if (kind === 'award') {
    // self-contained on purpose: the referenced bid may never arrive, or arrive later
    b.worker = str(fields.worker, 42).toLowerCase();
    b.price = str(fields.price, 40);
    if (!/^0x[0-9a-f]{40}$/.test(b.worker)) throw new Error('award needs the winning worker address');
    if (!b.price) throw new Error('award must restate the agreed price — it is the requester\'s signed commitment');
    if (fields.eta) b.eta = str(fields.eta, 40);
    // opaque, never created or checked here. See the header: settlement is out of scope.
    if (fields.settlementRef) b.settlementRef = str(fields.settlementRef, 120);
  }
  if (kind === 'cancel' && fields.reason) b.reason = str(fields.reason, 200);
  if (kind === 'settle') {
    // a pointer to an external, REFUTABLE fact (a Base USDC tx), never a claim about the world. That is
    // the whole difference from the killed `accept`: accept was unfalsifiable prose; this names a txHash
    // anyone folding the same log can check against Base and refute.
    b.txHash = str(fields.txHash, 66).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(b.txHash)) throw new Error('settle needs a 0x… 32-byte tx hash');
    const amt = String(fields.amountMicro == null ? '' : fields.amountMicro).trim();
    if (!/^\d+$/.test(amt)) throw new Error('settle needs amountMicro (USDC micro-units, integer string)');
    // A ZERO transfer settles NOTHING. Without this, a 0-value USDC transfer verifies field-for-field
    // (it really does emit a Transfer event) and would flip a job to `settled` — a job showing PAID
    // while nothing was paid. The rating was already safe (conservation gives 0 standing for 0 USDC),
    // but the STATE would have lied, and the state is what a human reads. Use `validate` for a
    // zero-value handshake; that is what it is for.
    if (amt === '0') throw new Error('settle needs a non-zero amount — a zero transfer proves a live path, not a payment (use validate)');
    b.amountMicro = amt;
    // WHAT was paid for — for a code bounty, the PR / commit the requester is settling. An OPAQUE
    // pointer for humans to follow; it is NOT verified and it is NOT what makes the settlement count
    // (only the on-chain USDC fact does). Two verifiable ends — the code link and the payment tx —
    // with LAWBOR honestly claiming only the second.
    if (fields.deliverable) b.deliverable = str(fields.deliverable, 200);
  }
  if (kind === 'validate') {
    /* THE PENNY-DROP. A zero-value (or dust) USDC transfer on Base, cited to prove the payment RAIL
     * works before real money crosses it — the bank micro-deposit, on-chain. It is deliberately a
     * SEPARATE verb from settle, because it proves something completely different:
     *
     *   requester -> worker :  "my key works and this address accepts a transfer"
     *   worker -> requester :  "I CONTROL this address"   <- the one that matters to a payer
     *
     * Sending to an address proves nothing about who holds it; only a tx SIGNED BY that address does.
     * So the direction is recorded and the two are never conflated. This directly attacks the single
     * most irreversible risk in the system: paying an address nobody controls (a typo, a stale paste,
     * a swapped clipboard) and losing the money forever.
     *
     * 🛑 A validation NEVER becomes standing. It costs only gas, so it is farmable by construction —
     * anyone can ping a thousand addresses for pennies. It answers "is this path live and is the key
     * held", never "is this counterparty good for the money". lib/credit.js is untouched by it. */
    b.txHash = str(fields.txHash, 66).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(b.txHash)) throw new Error('validate needs a 0x… 32-byte tx hash');
  }

  return JSON.stringify(b);
}

/** Is this envelope body a work message? Returns the payload, or null for ordinary chat. */
function parseWork(body) {
  if (typeof body !== 'string' || body.length > 4096 || body[0] !== '{') return null;
  let b; try { b = JSON.parse(body); } catch { return null; }
  if (!b || b[MARKER] !== V || !KINDS.includes(b.kind) || typeof b.jobId !== 'string' || !b.jobId) return null;
  return b;
}

// Receiver's clock first; a sender-chosen ts is only a fallback for rows written before rxAt existed.
const orderOf = (m) => (Number.isFinite(m.rxAt) ? m.rxAt : Number(m.ts) * 1000);
const lower = (a) => String(a || '').toLowerCase();

/**
 * Fold a thread's messages into job states. PURE and synchronous.
 * @param {Array} messages store rows ({from,to,body,ts,rxAt,id}) — order does not matter
 * @returns {Map<string, object>} jobId → { jobId, state, requester, task, tags, bids[], award, … }
 */
function foldThread(messages, opts = {}) {
  const jobs = new Map();
  // injected, IMMUTABLE chain facts: Map<txHash, {chainId, token, from, to, valueMicro, confirmations}>.
  // The fold stays pure/synchronous/total — it reads these, it never fetches. Absent fact ⇒ unverified.
  const txFacts = opts.txFacts || null;
  const getFact = (h) => (txFacts && typeof txFacts.get === 'function') ? txFacts.get(h) : (txFacts ? txFacts[h] : null);
  const seenTx = new Set();   // first-write-wins on a txHash across ALL jobs — one transfer settles one job
  // Deterministic total order: receive time, envelope id as tie-break. Two nodes that saw the same
  // messages must fold to the same result, or "the job" means something different on each screen.
  const rows = (Array.isArray(messages) ? messages : [])
    .map((m) => ({ m, w: parseWork(m && m.body) }))
    .filter((x) => x.w)
    .sort((a, b) => (orderOf(a.m) - orderOf(b.m)) || String(a.m.id).localeCompare(String(b.m.id)));

  /* PASS 1 — create every job first, PASS 2 — apply the mutations.
   * This used to be one pass, and a live multi-node sim found the bug that costs: rxAt is a millisecond,
   * so a help_wanted and its award relayed back-to-back can share one, and the id tie-break then orders
   * the award FIRST. A single pass hit "a mutation for a job we have not seen" and dropped the award on
   * the floor — silently, forever, because the fold never revisits. Splitting the passes removes the
   * ordering dependency between a job's CREATION and its mutations, while keeping strict chronological
   * order WITHIN the mutations (so an award still closes the job against later bids). A mutation for a
   * job that appears nowhere in the log is still ignored — we invent nothing. */
  for (const { m, w } of rows) {
    if (w.kind !== 'help_wanted') continue;
    const from = lower(m.from);
    {
      // first writer of a jobId owns it; a second help_wanted for the same id is ignored, so nobody
      // can hijack an open job by re-announcing it under their own address
      if (jobs.has(w.jobId)) continue;
      jobs.set(w.jobId, {
        jobId: w.jobId, state: 'open', requester: from,
        // the thread this job was announced in — so a reply (bid/award) can CONTINUE the conversation
        // instead of rooting a new one. Deterministic: first-writer-wins picks the announcing message.
        thread: m.thread,
        task: w.task, tags: w.tags || [], budgetHint: w.budgetHint || null, ref: w.ref || null,
        // upstream jobIds this job waits on; coerced defensively (a peer's body is untrusted)
        dependsOn: Array.isArray(w.dependsOn) ? w.dependsOn.filter((d) => typeof d === 'string' && d).slice(0, MAX_DEPS) : [],
        ready: true, blockedBy: [],   // overlaid in the second pass below
        bids: [], award: null, cancelled: null, settleClaims: [], settlement: null,
        // the penny-drop handshake: pathValidated = a real transfer crossed between the two parties;
        // payeeProved = the PAYEE signed one, which is the only proof they hold that key.
        validations: [], pathValidated: false, payeeProved: false, at: orderOf(m),
      });
      continue;
    }
  }

  for (const { m, w } of rows) {
    if (w.kind === 'help_wanted') continue;
    const from = lower(m.from);

    const job = jobs.get(w.jobId);
    if (!job) continue;                       // a bid for a job we have not seen: ignore, do not invent

    if (w.kind === 'bid') {
      if (job.state !== 'open') continue;                       // closed jobs take no more bids
      if (from === job.requester) continue;                     // no bidding on your own job
      // one LIVE bid per worker — a rebid replaces, it never accumulates
      const i = job.bids.findIndex((b) => b.worker === from);
      const bid = { worker: from, price: w.price, eta: w.eta || null, note: w.note || null, at: orderOf(m), id: m.id };
      if (i === -1) job.bids.push(bid); else job.bids[i] = bid;
      continue;
    }

    if (w.kind === 'validate') {
      // Either party may prove the rail, at any point after the job exists — you validate BEFORE you
      // award, which is the whole point. The tx must be a real USDC transfer on Base between exactly
      // these two parties, in either direction; the direction is what decides what it proves.
      const worker = job.award ? lower(job.award.worker) : null;
      const parties = [job.requester, worker].filter(Boolean);
      if (!parties.includes(from)) continue;
      if (seenTx.has(w.txHash)) continue;
      seenTx.add(w.txHash);
      const f = getFact(w.txHash);
      const ok = !!f && Number(f.chainId) === BASE_CHAIN_ID && lower(f.token) === USDC_BASE
        && Number(f.confirmations) >= MIN_CONF
        && parties.includes(lower(f.from)) && parties.includes(lower(f.to)) && lower(f.from) !== lower(f.to);
      const v = { txHash: w.txHash, by: from, at: orderOf(m), verified: !!ok,
        from: ok ? lower(f.from) : null, to: ok ? lower(f.to) : null,
        amountMicro: ok ? String(f.valueMicro) : null };
      (job.validations = job.validations || []).push(v);
      if (ok) {
        job.pathValidated = true;                        // a real transfer really crossed between them
        // …but only a tx SIGNED BY the payee proves the payee holds that key. Sending TO an address
        // proves nothing about who controls it, and that is exactly the loss we are trying to prevent.
        if (worker && lower(f.from) === worker) job.payeeProved = true;
      }
      continue;
    }

    if (w.kind === 'settle') {
      // A settlement binds this job to a real USDC transfer. The requester OR the awarded worker may
      // attach it (either side can present the proof); a third party cannot — that would be the
      // manufactured history we killed. Only after an award, and one txHash settles at most one job.
      if (job.state !== 'awarded' && job.state !== 'settled') continue;
      const worker = job.award ? lower(job.award.worker) : null;
      if (from !== job.requester && from !== worker) continue;
      if (seenTx.has(w.txHash)) continue;
      seenTx.add(w.txHash);
      const claim = { txHash: w.txHash, by: from, amountMicro: w.amountMicro, deliverable: w.deliverable || null, at: orderOf(m), verified: false };
      // promote to a VERIFIED settlement only if the injected chain fact matches on every field. No fact,
      // or any mismatch ⇒ verified stays false, the state does NOT change, and no credit is ever conferred.
      const f = getFact(w.txHash);
      if (f && Number(f.chainId) === BASE_CHAIN_ID && lower(f.token) === USDC_BASE
          && lower(f.from) === job.requester && lower(f.to) === worker
          && String(f.valueMicro) === String(w.amountMicro) && Number(f.confirmations) >= MIN_CONF) {
        claim.verified = true; claim.blockTime = Number(f.blockTime) || null;
      }
      (job.settleClaims = job.settleClaims || []).push(claim);
      if (claim.verified && job.state === 'awarded') {
        job.state = 'settled';
        job.settlement = { txHash: w.txHash, from: job.requester, to: worker, amountMicro: w.amountMicro, deliverable: w.deliverable || null, blockTime: claim.blockTime, at: orderOf(m) };
      }
      continue;
    }

    // Only the requester may close their own job. This is the whole actor model.
    if (from !== job.requester) continue;

    if (w.kind === 'award' && job.state === 'open') {
      job.state = 'awarded';
      job.award = {
        worker: w.worker, price: w.price, eta: w.eta || null,
        settlementRef: w.settlementRef || null, at: orderOf(m),
        // true when we have actually seen the winner's bid; an award can legitimately arrive first
        corroborated: job.bids.some((b) => b.worker === w.worker),
      };
    } else if (w.kind === 'cancel' && job.state === 'open') {
      job.state = 'cancelled';
      job.cancelled = { reason: w.reason || null, at: orderOf(m) };
    }
  }

  /* Second pass — readiness overlay. A dep is satisfied when its upstream job is `awarded` (a worker was
   * chosen); a missing or not-yet-awarded upstream leaves this job blocked, a `cancelled` upstream blocks
   * it (its work will never be negotiated). Derived, never stored, so it can't drift. Single-level by
   * design: readiness chains naturally as upstreams get awarded over time, and a dependency CYCLE simply
   * leaves every job in it blocked forever (no traversal, so no infinite loop) rather than crashing. */
  for (const job of jobs.values()) {
    if (!job.dependsOn.length) { job.ready = true; job.blockedBy = []; continue; }
    // a dependency is satisfied once its upstream is awarded — OR settled, which is strictly stronger.
    job.blockedBy = job.dependsOn.filter((d) => { const up = jobs.get(d); return !up || (up.state !== 'awarded' && up.state !== 'settled'); });
    job.ready = job.blockedBy.length === 0;
  }
  return jobs;
}

/** Fold many threads (e.g. store.all()) into a flat, newest-first job list. */
function jobsFrom(messages) {
  return [...foldThread(messages).values()].sort((a, b) => b.at - a.at);
}

/**
 * Render the job set as an agent-org GRAPH — the coordination view a swarm reads. Pure, derived from the
 * same fold, so it never disagrees with jobsFrom. `edges` are dependent → upstream (jobId pairs); `ready`
 * is the frontier an agent can claim right now; `blocked` names what each waiting job is waiting on.
 */
function graphOf(messages) {
  const jobs = foldThread(messages);
  const edges = [];
  for (const job of jobs.values()) for (const dep of job.dependsOn) edges.push({ from: job.jobId, dependsOn: dep });
  const list = [...jobs.values()];
  return {
    nodes: list.map((j) => ({ jobId: j.jobId, state: j.state, ready: j.ready, requester: j.requester,
      dependsOn: j.dependsOn, blockedBy: j.blockedBy, bids: j.bids.length })),
    edges,
    ready: list.filter((j) => j.state === 'open' && j.ready).map((j) => j.jobId),   // claimable frontier
    blocked: list.filter((j) => j.state === 'open' && !j.ready).map((j) => ({ jobId: j.jobId, blockedBy: j.blockedBy })),
    roots: list.filter((j) => !j.dependsOn.length).map((j) => j.jobId),             // jobs with no upstream
  };
}

/**
 * May `addr` send this kind on this job right now? Checked at ACCEPT time, not at render time —
 * a rule enforced only when painting is decorative (the lesson of the ungated POST /peers).
 * Returns { ok } or { ok:false, reason }.
 */
function mayApply(job, kind, addr, opts = {}) {
  const a = lower(addr);
  if (kind === 'help_wanted') {
    // A help_wanted is BROADCAST: the requester sends the same jobId to many workers, so re-sending
    // their OWN job must be allowed (found by the interaction sim — the second copy was refused,
    // which silently broke posting a job to more than one worker). Only a DIFFERENT address claiming
    // an existing jobId is a hijack and refused; the fold already ignores the duplicate row.
    if (job && job.requester !== a) return { ok: false, reason: 'jobId already taken by another requester' };
    return { ok: true };
  }
  if (!job) return { ok: false, reason: 'unknown job' };
  if (kind === 'bid') {
    if (job.state !== 'open') return { ok: false, reason: 'job is ' + job.state };
    if (a === job.requester) return { ok: false, reason: 'a requester cannot bid on their own job' };
    // no bidding on a job whose upstream dependencies are not yet awarded — the graph gate
    if (job.ready === false) return { ok: false, reason: 'job is blocked by unfinished dependencies: ' + (job.blockedBy || []).join(', ') };
    return { ok: true };
  }
  if (kind === 'award' || kind === 'cancel') {
    if (a !== job.requester) return { ok: false, reason: 'only the requester may ' + kind };
    if (job.state !== 'open') return { ok: false, reason: 'job is ' + job.state };
    // a requester may still CANCEL a blocked job (their escape hatch), but must not AWARD one
    if (kind === 'award' && job.ready === false) return { ok: false, reason: 'cannot award a job whose dependencies are unmet: ' + (job.blockedBy || []).join(', ') };

    /* KEY-PROOF GUARD (opt-in: opts.requireProofAbove). Above a threshold, refuse to award to an
     * address that has never signed a transfer proving it holds its key.
     *
     * WHY HERE AND NOT ON `settle`: settle records a payment that has ALREADY left the wallet, so a
     * guard there protects nothing — the money is gone. The award is the commitment that leads to the
     * transfer, and it is the last moment a rule can still prevent the loss.
     *
     * An UNREADABLE price is treated as above the threshold. The operator asked for this protection;
     * silently waving through what we cannot measure would be the fail-open the rest of this file
     * refuses. Honest limit: this stops LAWBOR committing to an unproven address — it cannot stop a
     * human paying one anyway, outside the protocol. */
    if (kind === 'award' && opts.requireProofAbove != null) {
      const worker = lower(opts.worker || (job.award && job.award.worker) || '');
      const n = priceNumber(opts.price);
      const proven = opts.proven instanceof Set ? opts.proven : new Set();
      if (worker && !proven.has(worker)) {
        if (!Number.isFinite(n)) return { ok: false, reason: 'cannot read the price, and this worker has never proven they hold their key — ask them for a `validate` (a transfer signed by THEM) before committing' };
        if (n > Number(opts.requireProofAbove)) return { ok: false, reason: 'awarding ' + n + ' is above your proof threshold (' + opts.requireProofAbove + ') and this worker has never proven they hold their key — ask them for a `validate` (a transfer signed by THEM) first, or you may be paying an address nobody controls' };
      }
    }
    return { ok: true };
  }
  if (kind === 'settle') {
    if (job.state !== 'awarded' && job.state !== 'settled') return { ok: false, reason: 'job is ' + job.state + ' — settle only after award' };
    const worker = job.award ? lower(job.award.worker) : null;
    if (a !== job.requester && a !== worker) return { ok: false, reason: 'only the requester or the awarded worker may settle' };
    return { ok: true };
  }
  if (kind === 'validate') {
    // allowed at ANY live state — the point is to prove the rail BEFORE committing money to it
    if (job.state === 'cancelled') return { ok: false, reason: 'job is cancelled' };
    const worker = job.award ? lower(job.award.worker) : null;
    if (a !== job.requester && a !== worker) return { ok: false, reason: 'only the two parties to this job may validate its payment path' };
    return { ok: true };
  }
  return { ok: false, reason: 'unknown kind' };
}

/**
 * Addresses that have PROVEN they hold their key, across every job in the log.
 * ================================================================================================
 * Key control is a property of an ADDRESS, not of a job: you prove it once and every requester who saw
 * the message knows it. Deriving it per-job was the wrong shape and would not even have worked — the
 * proof is needed BEFORE an award, and a job has no `worker` until the award exists.
 *
 * An address is proven when it SIGNED a USDC transfer on Base that someone cited in a `validate`, and
 * the chain confirmed it. Sending TO an address never proves anything about who holds it.
 * Cheap by design (gas only), so it is deliberately NOT worth reputation — it answers "is this key
 * held", never "is this counterparty good for the money".
 */
function provenFrom(messages, opts = {}) {
  const proven = new Set();
  for (const job of foldThread(messages, opts).values()) {
    for (const v of job.validations || []) if (v.verified && v.from) proven.add(lower(v.from));
  }
  return proven;
}

/** The number in a free-text price ("500 USDC" → 500), or NaN when it cannot be read. */
function priceNumber(price) {
  const m = String(price == null ? '' : price).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

/** Flat list of VERIFIED settlement edges over all jobs — the input to lib/credit.js. Only edges whose
 *  txHash matched an injected chain fact appear; an unverified claim is silently excluded (fail-closed). */
function settlementsFrom(messages, opts = {}) {
  const out = [];
  for (const job of foldThread(messages, opts).values()) {
    if (job.settlement) out.push({ jobId: job.jobId, txHash: job.settlement.txHash, payer: job.settlement.from, worker: job.settlement.to, amountMicro: job.settlement.amountMicro, blockTime: job.settlement.blockTime });
  }
  return out;
}

module.exports = { buildWork, parseWork, foldThread, jobsFrom, graphOf, settlementsFrom, provenFrom, priceNumber, mayApply, KINDS, MARKER, USDC_BASE };
