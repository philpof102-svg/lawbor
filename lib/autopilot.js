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
  if (p.bidPrice > p.maxPrice) return { bid: false, reason: 'bidPrice above maxPrice' };
  return { bid: true, price: `${p.bidPrice} ${p.currency}` };
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
  const best = usable.slice().sort((a, b) => (priceOf(a.price) - priceOf(b.price)) || (a.at - b.at))[0];
  return { award: true, worker: best.worker, price: best.price };
}

/** All the intents this bot would act on right now, given the folded log. PURE. */
function plan(messages, self, policy = {}) {
  const jobs = jobsFrom(messages);
  const out = [];
  for (const job of jobs) {
    const a = decideAward(job, self, policy);
    if (a.award) { out.push({ kind: 'award', jobId: job.jobId, to: a.worker, worker: a.worker, price: a.price, thread: job.thread }); continue; }
    const b = decideBid(job, self, jobs, policy);
    if (b.bid) out.push({ kind: 'bid', jobId: job.jobId, to: job.requester, price: b.price, thread: job.thread });
  }
  return out;
}

/**
 * Drive one pass: fold, plan, speak as the BOT. Returns what it did (and what it refused, honestly).
 * Sends at most `maxActionsPerTick` so an unattended loop cannot burst.
 */
async function tick(node, policy = {}) {
  const p = { maxActionsPerTick: 4, ...policy };
  const intents = plan(node.store.all(), node.self, p).slice(0, p.maxActionsPerTick);
  const done = [];
  for (const i of intents) {
    const fields = i.kind === 'bid' ? { jobId: i.jobId, price: i.price } : { jobId: i.jobId, worker: i.worker, price: i.price };
    try {
      const r = await node.botSay(i.to, buildWork(i.kind, fields), { thread: i.thread });
      done.push({ ...i, delivered: r.delivered, signed: r.sign && r.sign.signed });   // signed is always false
    } catch (e) { done.push({ ...i, error: (e && e.message) || String(e) }); }
  }
  return done;
}

module.exports = { decideBid, decideAward, plan, tick, DEFAULTS };
