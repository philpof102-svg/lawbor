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
 *   worker and stop there: `settlementRef` is an opaque string LAWBOR never creates, resolves or
 *   checks, so nothing here holds funds, releases funds, or enforces delivery — after an `award`,
 *   the two parties are exactly as exposed to each other as they were before it. Call it
 *   reputation-gated job negotiation. It is not a labour market, because no exchange occurs.
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
 */

const MARKER = 'lawbor.work';
const V = 1;
const KINDS = ['help_wanted', 'bid', 'award', 'cancel'];

const MAX_TEXT = 400;
const MAX_TAGS = 8;
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
function foldThread(messages) {
  const jobs = new Map();
  // Deterministic total order: receive time, envelope id as tie-break. Two nodes that saw the same
  // messages must fold to the same result, or "the job" means something different on each screen.
  const rows = (Array.isArray(messages) ? messages : [])
    .map((m) => ({ m, w: parseWork(m && m.body) }))
    .filter((x) => x.w)
    .sort((a, b) => (orderOf(a.m) - orderOf(b.m)) || String(a.m.id).localeCompare(String(b.m.id)));

  for (const { m, w } of rows) {
    const from = lower(m.from);

    if (w.kind === 'help_wanted') {
      // first writer of a jobId owns it; a second help_wanted for the same id is ignored, so nobody
      // can hijack an open job by re-announcing it under their own address
      if (jobs.has(w.jobId)) continue;
      jobs.set(w.jobId, {
        jobId: w.jobId, state: 'open', requester: from,
        task: w.task, tags: w.tags || [], budgetHint: w.budgetHint || null,
        bids: [], award: null, cancelled: null, at: orderOf(m),
      });
      continue;
    }

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
  return jobs;
}

/** Fold many threads (e.g. store.all()) into a flat, newest-first job list. */
function jobsFrom(messages) {
  return [...foldThread(messages).values()].sort((a, b) => b.at - a.at);
}

/**
 * May `addr` send this kind on this job right now? Checked at ACCEPT time, not at render time —
 * a rule enforced only when painting is decorative (the lesson of the ungated POST /peers).
 * Returns { ok } or { ok:false, reason }.
 */
function mayApply(job, kind, addr) {
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
    return { ok: true };
  }
  if (kind === 'award' || kind === 'cancel') {
    if (a !== job.requester) return { ok: false, reason: 'only the requester may ' + kind };
    if (job.state !== 'open') return { ok: false, reason: 'job is ' + job.state };
    return { ok: true };
  }
  return { ok: false, reason: 'unknown kind' };
}

module.exports = { buildWork, parseWork, foldThread, jobsFrom, mayApply, KINDS, MARKER };
