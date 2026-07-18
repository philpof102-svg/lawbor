'use strict';
/**
 * LAWBOR — paywall.js  (x402 subscription: pay the operator's wallet, unlock premium apps)
 * =========================================================================================
 * The premium tier is a HOSTED node the operator runs — premium content and premium apps served from
 * it. This gates that: a premium surface answers HTTP 402 with an x402 payment pointer; the caller
 * pays USDC to the operator's wallet; the node verifies the payment and records a subscription
 * (default 30 days). Access is "does this caller hold an active subscription right now?".
 *
 * WHY THIS IS HONEST (read PLATFORM.md): the node SOFTWARE is free and open (MIT) — you cannot charge
 * for something a user self-hosts and forks. What is sold is the operator's HOSTED SERVICE + CONTENT,
 * which has real marginal cost and cannot be self-provided. The free node stays free; premium is the
 * hosted node's content, not the code.
 *
 * 🛑 Descriptor-only, like everything here. LAWBOR NEVER holds a key or receives funds: the x402
 *   payment goes straight to `payTo` (the operator's wallet — e.g. MainStreet's). The node only
 *   ISSUES the challenge and VERIFIES a submitted proof, and verification is INJECTED (an x402
 *   facilitator / RPC read is network I/O, which does not belong in lib/). No verifier ⇒ FAIL CLOSED:
 *   a premium surface is refused, never served free.
 */

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';   // native USDC on Base, 6 decimals
const isAddr = (a) => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
const lower = (a) => String(a || '').toLowerCase();

/** @param {{price?:string, payTo:string, network?:string, periodDays?:number, resource?:string,
 *           verify?:Function, clock?:Function, subs:{record:Function, until:Function}}} cfg
 *  verify(paymentPayload) -> {ok, payer, amountUsdc} (wire to an x402 facilitator). subs persists {payer,until}. */
function createPaywall(cfg = {}) {
  if (!isAddr(cfg.payTo)) throw new Error('payTo must be the operator wallet 0x address (payments go straight there)');
  if (!cfg.subs || typeof cfg.subs.record !== 'function' || typeof cfg.subs.until !== 'function') throw new Error('subs { record, until } required');
  const price = String(cfg.price || '5');                  // USDC per period
  const network = cfg.network || 'base';
  const periodMs = (Number(cfg.periodDays) || 30) * 24 * 3600 * 1000;
  const resource = cfg.resource || 'lawbor:premium';
  const clock = typeof cfg.clock === 'function' ? cfg.clock : Date.now;
  const micro = String(Math.round(Number(price) * 1e6));   // USDC has 6 decimals

  const paymentRequired = {
    x402Version: 1,
    accepts: [{
      scheme: 'exact', network,
      maxAmountRequired: micro,
      resource,
      description: 'LAWBOR premium — ' + (Number(cfg.periodDays) || 30) + ' days full access',
      mimeType: 'application/json',
      payTo: cfg.payTo,
      maxTimeoutSeconds: 300,
      asset: USDC_BASE,
      extra: { name: 'USDC', version: '2', priceUsdc: price },
    }],
  };

  return {
    price, payTo: cfg.payTo, network, verifies: typeof cfg.verify === 'function',

    /** Is this caller subscribed right now? */
    active(caller) { return isAddr(caller) && Number(cfg.subs.until(lower(caller))) > clock(); },

    /** The 402 response body + header a premium surface returns to an unpaid caller. */
    challenge() {
      const b64 = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');
      return { status: 402, headers: { 'payment-required': b64, 'access-control-expose-headers': 'payment-required' }, body: paymentRequired };
    },

    /**
     * Settle a submitted x402 payment. INJECTED verify does the on-chain/facilitator check; on success
     * we record a subscription for the payer. Fail-closed: no verifier, bad proof, wrong amount, wrong
     * recipient, or a throw ⇒ no subscription.
     * @param {object} paymentPayload the decoded `x-payment` the client submitted
     * @returns {Promise<{ok:boolean, payer?:string, until?:number, reason?:string}>}
     */
    async settle(paymentPayload) {
      if (typeof cfg.verify !== 'function') return { ok: false, reason: 'no x402 verifier configured — FAIL CLOSED' };
      let v; try { v = await cfg.verify(paymentPayload); } catch (e) { return { ok: false, reason: 'verifier threw — FAIL CLOSED (' + e.message + ')' }; }
      if (!v || v.ok !== true || !isAddr(v.payer)) return { ok: false, reason: 'payment did not verify' };
      if (Number(v.amountUsdc) + 1e-9 < Number(price)) return { ok: false, reason: 'underpaid: ' + v.amountUsdc + ' < ' + price + ' USDC' };
      const until = clock() + periodMs;
      cfg.subs.record(lower(v.payer), until);
      return { ok: true, payer: lower(v.payer), until };
    },
  };
}

module.exports = { createPaywall, USDC_BASE };
