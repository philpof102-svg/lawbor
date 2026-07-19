'use strict';
/**
 * A REMOTE LAWBOR signer. The key lives somewhere the node cannot reach; the node ASKS for a signature.
 * ================================================================================================
 *   LAWBOR_SIGNER=./examples/signer-remote.js LAWBOR_SIGNER_URL=https://your-signer.internal/sign node server.js
 *
 * This is the pattern that lets the PUBLIC node originate (`originatesSigned:true`) WITHOUT ever holding
 * a key — the same promise the node makes everywhere else, kept across the network boundary. It mirrors
 * how KMS/HSM signing works in production (AWS KMS, GCP KMS, a hardware signer, or a laptop the operator
 * controls): the private key never leaves the signing environment; the node sends the EIP-712 payload
 * and receives back a 0x signature.
 *
 * The endpoint you point LAWBOR_SIGNER_URL at is YOURS to build. Its only contract:
 *     POST  { payload, envelope }  ->  200 { signature: "0x…" }   (or a non-2xx / no signature to REFUSE)
 * Back it with a KMS, a hardware wallet, a Frame/Rabby bridge, or a human-approval queue. LAWBOR does
 * not care how you sign — only that IT never sees the key.
 *
 * 🛑 THE HONEST SECURITY TRADEOFF, because a remote signer is not free.
 * A hot remote signer means: while the node process is running, it can request a signature for ANY
 * envelope it constructs. KMS/HSM prevents the key from being EXFILTRATED — an attacker who owns the box
 * cannot walk away with it — but it does NOT prevent the key from being USED during a compromise window.
 * For the public node, which is the single most-attacked surface in the system, that window matters.
 * Two real mitigations, and this example enables both:
 *   1. THE ENDPOINT IS A POLICY POINT. It sees the full envelope and may refuse — rate-limit, require the
 *      body match an allowlist, demand a human tap for anything unusual. Signing is the last gate before
 *      your address vouches for a message; put judgement there, not just a key.
 *   2. SCOPE THE ADDRESS. Do not put the address that also holds funds behind a hot signer. Give the
 *      public node its OWN throwaway identity, so a compromise costs reputation-rebuild, never money.
 * If neither is acceptable for your deployment, the honest answer is to run the node RECEIVE-ONLY
 * (no LAWBOR_SIGNER) and originate from a node you sign for out-of-band. `originatesSigned:false` is a
 * supported, stated state — a one-way mailbox is a real and honest thing to be.
 */

const URL = process.env.LAWBOR_SIGNER_URL;
const TOKEN = process.env.LAWBOR_SIGNER_TOKEN;   // optional bearer, so only this node may ask
const TIMEOUT_MS = Number(process.env.LAWBOR_SIGNER_TIMEOUT_MS || 8000);

if (!URL) {
  // Fail LOUD at load, not silently unsigned — the same rule server.js applies to a bad signer path.
  throw new Error('signer-remote.js needs LAWBOR_SIGNER_URL (the endpoint that holds your key and signs for you)');
}

/**
 * @param {{payload: object, envelope: object}} args  the EIP-712 payload from lib/envelope.js + the envelope
 * @returns {Promise<string>} a 0x signature. THROW to refuse — lib/node.js turns a throw into a refusal,
 *   never an unsigned send, so a signer outage fails closed by construction.
 */
module.exports = async function sign({ payload, envelope }) {
  let res;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) },
      body: JSON.stringify({ payload, envelope }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // network/timeout — REFUSE. Better a message that does not send than one sent unsigned, or one that
    // hangs the node waiting on a dead signer.
    throw new Error('remote signer unreachable (' + ((e && e.message) || e) + ') — refused rather than sent unsigned');
  }
  if (!res.ok) {
    // a non-2xx is the endpoint's chosen way to REFUSE this specific envelope (policy said no). Honour it.
    throw new Error('remote signer refused this envelope: HTTP ' + res.status);
  }
  let body;
  try { body = await res.json(); } catch { throw new Error('remote signer returned unparseable response'); }
  const sig = body && (body.signature || body.sig);
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]+$/.test(sig)) {
    throw new Error('remote signer returned no usable 0x signature');
  }
  return sig;
};
