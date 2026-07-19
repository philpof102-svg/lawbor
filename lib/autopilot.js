'use strict';
/**
 * LAWBOR — autopilot.js  (a bot that works the job graph on its own)
 * ================================================================================================
 * LAWBOR's premise is that every participant is a BOT and the human talks through theirs. Until now the
 * bots only relayed: a human had to drive every bid and every award. This is the piece that makes the
 * org autonomous — a node can watch the folded job graph and negotiate for itself, which is also what
 * finally gives the "watch my bot" feed something true to show.
 *
 * DESIGN: the decisions are PURE FUNCTIONS of the folded graph (decideBid / decideAward). They return an
 * intent, never a side effect. A thin driver turns an intent into a botSay, so the same rules can be
 * unit-tested without a node, a socket or a clock. That split is deliberate: an autonomous agent whose
 * policy you cannot test offline is an agent you cannot trust to run unattended.
 *
 * 🛑 The autopilot changes WHO decides, not WHAT is allowed:
 *   - it proposes only transitions the actor rules already permit (it re-checks mayApply itself);
 *   - it speaks as the BOT (origin 'bot'), so its traffic lands in the watch feed, never in a human inbox;
 *   - it signs NOTHING and settles NOTHING. botSay returns an EIP-712 descriptor with signed:false, and a
 *     job reaching `awarded` still means "a worker was chosen", not "work was delivered or paid".
 *   - every policy bound is explicit and small by default (maxOpenBids, maxPrice, minBidsBeforeAward), so
 *     an unattended bot cannot fan out. Brakes before horsepower.
 */
const { jobsFrom, mayApply, buildWork } = require('./work');

const DEFAULTS = {
  maxOpenBids: 3,          // how many live bids this bot will carry at once
  maxPrice: 100,           // never bid above this (bare number, unit-free — the price string carries the unit)
  bidPrice: 10,            // what it offers when it does bid
  currency: 'USDC',
  minBidsBeforeAward: 1,   // a requester waits for at least this many bids before choosing
  skills: null,            // optional: only bid on jobs whose tags intersect these
  /* REPUTATION, applied as a RISK PREMIUM and not as a wall — this is the load-bearing choice.
   * The rating (lib/credit.js) is conservation-bounded, which means cold start is TOTAL: a fresh node
   * has paid nobody, so it rates everybody 0. If a bot refused to bid on anyone it had not already been
   * paid by, no new node could ever take a first job and the market would deadlock at zero — the rating
   * would kill the thing it exists to serve. So by default a stranger is still served, just priced
   * higher; refusing outright stays OPT-IN (requirePaidRequester) for an operator who wants it.
   * TWO DIRECTIONS, and they are not interchangeable (a live two-node run caught them being confused):
   *   inbound — what an address has verifiably paid US. The right question when we are the WORKER
   *             deciding whether to take their job: is this client good for it?
   *   credit  — what WE have verifiably paid an address. The right question when we are the REQUESTER
   *             choosing between bidders: is this a hand we have already paid?
   * Both are INJECTED (Map addr→USDC-micro), because computing them needs chain I/O and this stays pure. */
  credit: null,
  inbound: null,
  unknownRequesterPremium: 1,   // multiplier applied when the requester has never paid us (1 = no change)
  requirePaidRequester: false,  // opt-in: refuse strangers entirely (deadlocks a cold-start node — say so)
};

const lower = (a) => String(a || '').toLowerCase();
const priceOf = (s) => { const m = String(s || '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };

/** Jobs this bot currently has a live bid on. */
function openBidsOf(jobs, self) {
  return jobs.filter((j) => j.state === 'open' && j.bids.some((b) => lower(b.worker) === lower(self)));
}

/**
 * Should this bot bid on this job? PURE.
 * @returns {{bid:boolean, price?:string, reason?:string}}
 */
function decideBid(job, self, jobs, policy = {}) {
  const p = { ...DEFAULTS, ...policy };
  const may = mayApply(job, 'bid', self);
  if (!may.ok) return { bid: false, reason: may.reason };          // the actor rules decide, not the policy
  if (job.bids.some((b) => lower(b.worker) === lower(self))) return { bid: false, reason: 'already bid' };
  if (openBidsOf(jobs, self).length >= p.maxOpenBids) return { bid: false, reason: 'at maxOpenBids' };
  if (Array.isArray(p.skills) && p.skills.length) {
    const tags = (job.tags || []).map(lower);
    if (!p.skills.some((s) => tags.includes(lower(s)))) return { bid: false, reason: 'no matching skill tag' };
  }

  /* What has this requester actually PAID US, verified on Base — the INBOUND direction.
   * This must not be confused with `credit` (what WE paid THEM): a two-node run caught exactly that
   * mistake, quoting a stranger-premium to a client who had just paid us. Deciding whether to take a
   * job is a question about the CLIENT's demonstrated willingness to pay us, and nothing else. */
  const paidUs = p.inbound ? Number((p.inbound.get ? p.inbound.get(job.requester) : p.inbound[job.requester]) || 0) : 0;
  if (!paidUs && p.requirePaidRequester) {
    return { bid: false, reason: 'requester has never settled with us (requirePaidRequester is on — note this refuses EVERY stranger, so a cold-start node bids on nothing)' };
  }
  const price = paidUs > 0 ? p.bidPrice : p.bidPrice * (Number(p.unknownRequesterPremium) || 1);
  if (price > p.maxPrice) return { bid: false, reason: `priced ${price} above maxPrice ${p.maxPrice}` + (paidUs ? '' : ' (unknown-requester premium applied)') };
  return {
    bid: true,
    price: `${Math.round(price * 100) / 100} ${p.currency}`,
    // surfaced so an operator watching the feed can see WHY the bot quoted what it quoted
    basis: paidUs > 0 ? `requester has settled ${paidUs / 1e6} USDC with us` : 'requester unknown to us — premium applied',
  };
}

/**
 * Should this bot award its own job, and to whom? PURE. Cheapest live bid wins; ties break on the
 * earliest bid so the outcome is deterministic (two nodes folding the same log must agree).
 * @returns {{award:boolean, worker?:string, price?:string, reason?:string}}
 */
function decideAward(job, self, policy = {}) {
  const p = { ...DEFAULTS, ...policy };
  const may = mayApply(job, 'award', self);
  if (!may.ok) return { award: false, reason: may.reason };
  if (job.bids.length < p.minBidsBeforeAward) return { award: false, reason: `waiting for bids (${job.bids.length}/${p.minBidsBeforeAward})` };
  const usable = job.bids.filter((b) => Number.isFinite(priceOf(b.price)) && priceOf(b.price) <= p.maxPrice);
  if (!usable.length) return { award: false, reason: 'no bid within maxPrice' };
  const byPrice = usable.slice().sort((a, b) => (priceOf(a.price) - priceOf(b.price)) || (a.at - b.at));

  /* The other half of "contribute more, do better": a worker WE have already paid — meaning they took a
   * job from us and a real USDC transfer settled — can win against a marginally cheaper stranger. The
   * tolerance is explicit and defaults to 0 (pure cheapest-wins) so this never changes an operator's
   * outcomes unless they ask for it, and the whole rule stays deterministic: two nodes folding the same
   * log and holding the same credit must award the same worker. */
  const tol = Number(p.provenWorkerTolerance) || 0;
  const standing = (w) => (p.credit ? Number((p.credit.get ? p.credit.get(lower(w)) : p.credit[lower(w)]) || 0) : 0);
  let best = byPrice[0];
  if (tol > 0) {
    const ceiling = priceOf(byPrice[0].price) * (1 + tol);
    const within = byPrice.filter((b) => priceOf(b.price) <= ceiling);
    best = within.slice().sort((a, b) => (standing(b.worker) - standing(a.worker))
      || (priceOf(a.price) - priceOf(b.price)) || (a.at - b.at))[0];
  }
  return {
    award: true, worker: best.worker, price: best.price,
    basis: standing(best.worker) > 0 ? `worker has settled ${standing(best.worker) / 1e6} USDC with us` : 'cheapest bid',
  };
}

/**
 * Should this bot POST a wanted job of its own? PURE — and this is the WANTED-poster principle: a bot
 * advertises something IT needs done, for a reward, answerable by a human or another bot alike.
 * The need is MECHANICAL, never invented: a job WE requested is blocked on a prerequisite jobId that
 * nobody anywhere has posted yet. That missing upstream is a real, derivable need — so the bot posts it,
 * with a budget hint, and the org ASSEMBLES ITSELF: deploy blocked on build → bot posts build → someone
 * bids → award → deploy unblocks. Self-limiting by construction: once posted, the job exists in our own
 * fold, so the next tick proposes nothing (no re-post spam). Off by default (postWanted) — a bot that
 * can create work for others is a bot the operator must explicitly enable.
 * @returns intents [{kind:'post', jobId, task, budgetHint, thread}]
 */
function decideWanted(jobs, self, policy = {}) {
  const p = { ...DEFAULTS, ...policy };
  if (!p.postWanted) return [];
  const have = new Set(jobs.map((j) => j.jobId));
  const out = new Map();
  for (const job of jobs) {
    if (job.requester !== lower(self)) continue;      // only OUR blocked work is OUR need
    if (job.state !== 'open' || job.ready) continue;
    for (const dep of job.blockedBy || []) {
      if (have.has(dep) || out.has(dep)) continue;    // exists (just unfinished) or already queued: not missing
      out.set(dep, { kind: 'post', jobId: dep,
        task: 'WANTED: ' + dep + ' — prerequisite of "' + (job.task || job.jobId) + '"',
        budgetHint: p.wantedBudget || null, thread: job.thread });
      if (out.size >= (p.maxWantedPerTick || 2)) return [...out.values()];
    }
  }
  return [...out.values()];
}

/** All the intents this bot would act on right now, given the folded log. PURE. */
function plan(messages, self, policy = {}) {
  const jobs = jobsFrom(messages);
  const out = [];
  for (const job of jobs) {
    const a = decideAward(job, self, policy);
    if (a.award) { out.push({ kind: 'award', jobId: job.jobId, to: a.worker, worker: a.worker, price: a.price, thread: job.thread, basis: a.basis }); continue; }
    const b = decideBid(job, self, jobs, policy);
    if (b.bid) out.push({ kind: 'bid', jobId: job.jobId, to: job.requester, price: b.price, thread: job.thread, basis: b.basis });
  }
  return out;
}

/**
 * Drive one pass: fold, plan, speak as the BOT. Returns what it did (and what it refused, honestly).
 * Sends at most `maxActionsPerTick` so an unattended loop cannot burst.
 */
async function tick(node, policy = {}) {
  const p = { maxActionsPerTick: 4, ...policy };
  const msgs = node.store.all();
  const intents = plan(msgs, node.self, p).slice(0, p.maxActionsPerTick);
  const done = [];
  for (const i of intents) {
    const fields = i.kind === 'bid' ? { jobId: i.jobId, price: i.price } : { jobId: i.jobId, worker: i.worker, price: i.price };
    try {
      const r = await node.botSay(i.to, buildWork(i.kind, fields), { thread: i.thread });
      done.push({ ...i, delivered: r.delivered, signed: r.sign && r.sign.signed });   // signed is always false
    } catch (e) { done.push({ ...i, error: (e && e.message) || String(e) }); }
  }

  // WANTED posts — the bot advertises its own mechanical needs (missing prerequisites) to its peers.
  // Broadcast is bounded (first maxWantedPeers peers) and self-limiting: once sent, the job lives in
  // our own fold and decideWanted proposes nothing next tick.
  for (const w of decideWanted(jobsFrom(msgs), node.self, p)) {
    const peers = (typeof node.peers === 'function' ? node.peers() : []).slice(0, p.maxWantedPeers || 3);
    for (const peer of peers) {
      const to = peer.addr || peer;
      try {
        const r = await node.botSay(to, buildWork('help_wanted', { jobId: w.jobId, task: w.task, budgetHint: w.budgetHint || undefined }), { thread: w.thread });
        done.push({ kind: 'post', jobId: w.jobId, to, delivered: r.delivered, basis: 'missing prerequisite — the org assembles itself' });
      } catch (e) { done.push({ kind: 'post', jobId: w.jobId, to, error: (e && e.message) || String(e) }); }
    }
  }
  return done;
}

module.exports = { decideBid, decideAward, decideWanted, plan, tick, DEFAULTS };
