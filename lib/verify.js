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
 * and the node stays fail-closed and says so at /health. The zero-runtime-dependency CORE is untouched:
 * nothing in lib/ requires this, and every module here still runs with node alone.
 *
 * viem is an OPTIONAL dependency, and it was not one for too long. The live node ran for weeks with
 * `authenticatesSenders:false` and `peers:0` — honestly reported at /health, and read by nobody —
 * because it told operators to "install viem to accept peers" while declaring no way to install it.
 * The mesh could be discovered and never joined. A default that cannot perform the product's core
 * function is not a safe default, it is a broken one, so the package now pulls viem on install.
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
  const viem = ('viem' in opts) ? opts.viem : loadViem();   // explicit null === absent (testable regardless of what is installed)
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

/**
 * Build a verifier for PLAIN MESSAGES (EIP-191 personal_sign), or NULL when viem is absent.
 *
 * server.js has expected a `verifyAuth` of this exact shape since the premium gate was written, but
 * nothing ever BUILT one — only tests injected it. So on every real deploy the gate silently fell back
 * to the spoofable `x-lawbor-caller` header. This closes that, and serves the key-proof path too: both
 * ask the one question viem answers here, "did this address sign this string".
 *
 * 🛑 EOA ONLY. A smart-contract wallet holds no key and cannot personal_sign; verifying it needs an
 * ERC-1271 call, which needs a chain client, which this module deliberately does not have (lib/ does no
 * network I/O). A contract wallet must therefore prove itself with the ON-CHAIN validate path, whose tx
 * the chain reader already resolves. That limit is stated rather than papered over — silently returning
 * false for a whole class of wallet is how a gate becomes a mystery.
 */
function createAuthVerifier(opts = {}) {
  const viem = ('viem' in opts) ? opts.viem : loadViem();   // explicit null === absent (testable regardless of what is installed)
  if (!viem || typeof viem.verifyMessage !== 'function') return null;

  return async function verifyAuth({ message, sig, claimed }) {
    if (!message || !sig || !claimed) return { ok: false };
    try {
      const ok = await viem.verifyMessage({ address: claimed, message, signature: sig });
      // Same reasoning as createVerifier: this is a boolean over a FIXED address, not a recovery, so
      // returning `claimed` as the signer is sound only while the caller keeps comparing it.
      return ok ? { ok: true, signer: String(claimed).toLowerCase() } : { ok: false };
    } catch { return { ok: false }; }
  };
}

/** The exact string an address signs to prove it holds its key. Domain-separated by the `LAWBOR-KEY:`
 *  prefix so a signature harvested from another protocol's login flow can never be replayed as one of
 *  ours. No nonce, by design — see the reasoning in lib/work.js under `validate`. */
const keyProofMessage = (addr) => 'LAWBOR-KEY:' + String(addr || '').toLowerCase();

module.exports = { createVerifier, createAuthVerifier, verifierStatus, keyProofMessage };
