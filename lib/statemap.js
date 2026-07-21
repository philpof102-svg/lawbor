'use strict';
/**
 * LAWBOR — statemap.js  (the job lifecycle as an EXPLICIT finite state machine)
 * ================================================================================================
 * work.js DERIVES job state by folding an append-only message log — which is already a state machine
 * (foldThread is δ applied over events). But its transition logic is SCATTERED across the fold's kind
 * branches, so "which states exist and what may follow what" cannot be read in one place or checked
 * exhaustively. This file gathers the MODE transitions into one table, exactly the move the FSM
 * literature argues for: the complete lifecycle fits on one screen, illegal transitions are named, and
 * a property test can walk the whole table instead of sampling paths.
 *
 * It is DERIVED, not authoritative: work.js remains the source of truth (it holds the guards — only the
 * requester awards, only a verified tx settles, …). This table records the MODE edges those guards
 * gate, and statemap.test.js pins the two together so the map can never quietly drift from the fold.
 *
 * Only MODE-changing events appear here. bid / quote / confirm / validate / a bazaar purchase (settle on
 * an offer) mutate a job's CONTEXT (bids, agreedPrice, purchases) but never its mode — the FSM/context
 * split: the mode stays small and enumerable, the context carries the unbounded data alongside it.
 */

// A help_wanted job. Initial: 'open'.
const JOB_TRANSITIONS = {
  open:      { award: 'awarded', cancel: 'cancelled' },
  awarded:   { settle: 'settled' },   // settle counts only when a chain fact verifies it (guard in work.js)
  settled:   {},                       // terminal
  cancelled: {},                       // terminal
};

// A bazaar offer (a standing listing). Initial: 'offered'. A purchase (settle) does NOT change the mode —
// an offer can be bought many times; delisting is the owner's only mode edge.
const OFFER_TRANSITIONS = {
  offered:   { cancel: 'delisted' },
  delisted:  {},                       // terminal
};

const JOB_INITIAL = 'open';
const OFFER_INITIAL = 'offered';
const ALL_STATES = [...new Set([...Object.keys(JOB_TRANSITIONS), ...Object.keys(OFFER_TRANSITIONS)])].sort();
const TERMINAL = new Set(ALL_STATES.filter((s) => {
  const t = (JOB_TRANSITIONS[s] || OFFER_TRANSITIONS[s] || {});
  return Object.keys(t).length === 0;
}));

const table = (isOffer) => (isOffer ? OFFER_TRANSITIONS : JOB_TRANSITIONS);

/** The mode after `event` fires in `state` (assuming its guard passed). Undefined event ⇒ stay put. */
function nextState(state, event, isOffer = false) {
  const row = table(isOffer)[state];
  if (!row) return state;                     // unknown/terminal state: no edges
  return Object.prototype.hasOwnProperty.call(row, event) ? row[event] : state;
}

const isTerminal = (state) => TERMINAL.has(state);

/** Every state reachable from an initial state by following declared edges (BFS, cycle-safe). */
function reachableStates(isOffer = false) {
  const start = isOffer ? OFFER_INITIAL : JOB_INITIAL;
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const s = q.shift();
    for (const nx of Object.values(table(isOffer)[s] || {})) if (!seen.has(nx)) { seen.add(nx); q.push(nx); }
  }
  return seen;
}

/** Is `to` reachable from the initial state? (used by the conformance property test) */
function isReachable(to, isOffer = false) { return reachableStates(isOffer).has(to); }

module.exports = {
  JOB_TRANSITIONS, OFFER_TRANSITIONS, JOB_INITIAL, OFFER_INITIAL,
  ALL_STATES, TERMINAL, nextState, isTerminal, reachableStates, isReachable,
};
