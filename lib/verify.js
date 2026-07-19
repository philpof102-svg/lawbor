'use strict';
/**
 * LAWBOR — verify.js  (the OPTIONAL signature verifier that lets a node accept inbound peers)
 * ================================================================================================
 * Without a verifier the relay is FAIL-CLOSED: it refuses every inbound envelope rather than trusting a
 * `from` anyone could type. That is the correct default, and it is also why the public node could be
 * discovered but never JOINED — nobody could reach it, so the network could not grow.
 *
 * 🛑 WE DO NOT HAND-ROLL THE CRYPTO. Verifying an EIP-712 signature needs keccak256 and secp256k1
 * public-key recovery, neither of which node ships. Writing them here would be the single worst place
 * in this repo to be clever: a subtly wrong ecrecover does not crash, it silently accepts forgeries.
 * So this module is a thin ADAPTER over viem, loaded LAZILY — if viem is not installed, it returns null
 * and the node stays fail-closed and says so at /health. The zero-runtime-dependency core is untouched:
 * nothing in lib/ requires this, and the package still installs with no dependencies.
 *
 * It verifies exactly what lib/envelope.js::signablePayload() produced — same domain, same types, same
 * bodyHash (sha256, NOT keccak256). A verifier that hashes differently fails every honest signature.
 */

/** Load viem only if the operator installed it. Never throws — absence is a supported state. */
function loadViem() {
  try { return require('viem'); } catch { return null; }
}

/**
 * Build a verifySig for createRelay/createNode, or NULL when no verifier is available.
 * @returns {null | (args: {payload:object, sig:string, claimed:string}) => Promise<{ok:boolean, signer?:string}>}
 */
function createVerifier(opts = {}) {
  const viem = opts.viem || loadViem();
  if (!viem || typeof viem.verifyTypedData !== 'function') return null;

  return async function verifySig({ payload, sig, claimed }) {
    // Every failure path returns {ok:false} rather than throwing: the relay treats a throwing verifier
    // as fail-closed anyway, but a quiet false keeps one malformed envelope from looking like an outage.
    if (!payload || !sig || !claimed) return { ok: false };
    try {
      const ok = await viem.verifyTypedData({
        address: claimed,
        domain: payload.domain,
        types: payload.types,
        primaryType: payload.primaryType,
        message: payload.message,
        signature: sig,
      });
      // The relay ALSO checks signer === from. Returning `claimed` as the signer is only sound because
      // verifyTypedData was asked to verify against that exact address — it is a boolean over a fixed
      // address, not a recovery. Do not "optimise" this into recoverTypedDataAddress without keeping
      // the comparison: a valid signature by the wrong key must stay refused (impersonation).
      return ok ? { ok: true, signer: String(claimed).toLowerCase() } : { ok: false };
    } catch { return { ok: false }; }
  };
}

/** Why a node is or is not authenticating — surfaced honestly rather than left to guesswork. */
function verifierStatus() {
  const viem = loadViem();
  return viem
    ? { available: true, via: 'viem', note: 'inbound envelopes are signature-checked; a valid signature by the wrong key is still refused' }
    : { available: false, via: null, note: 'viem is not installed, so this node is FAIL-CLOSED on inbound peer traffic: it refuses envelopes rather than trusting a `from` anyone could type. Install viem to accept peers.' };
}

module.exports = { createVerifier, verifierStatus };
