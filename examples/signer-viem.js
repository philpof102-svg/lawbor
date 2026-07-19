'use strict';
/**
 * An EXAMPLE LAWBOR signer. Copy it, do not require it from here.
 * ================================================================================================
 *   LAWBOR_SIGNER=./my-signer.js node server.js
 *
 * The node calls this with the EIP-712 payload lib/envelope.js built, and expects a 0x signature back.
 * Whatever happens in between is yours: LAWBOR never sees your key, and there is no env var it reads to
 * find one. That is the entire reason this file is an example rather than a feature.
 *
 * 🛑 THE VERSION BELOW KEEPS A RAW PRIVATE KEY IN THE PROCESS. That is acceptable for a LAN test with a
 * throwaway address and for nothing else. A key that can sign LAWBOR envelopes is usually the same key
 * that holds USDC — and this project's whole subject is that paying the wrong address is the one
 * irreversible loss. For anything real, replace the two lines under "the key" with a call to a KMS, a
 * hardware wallet, or a remote signing service, and keep the rest.
 *
 * Requires viem (already an optional dependency of this package):  npm i viem
 */
const { privateKeyToAccount } = require('viem/accounts');

// --- the key: THE ONLY PART YOU SHOULD REPLACE FOR REAL USE -------------------------------------
// A throwaway test key. Generate your own; never reuse one that holds funds.
const account = privateKeyToAccount(process.env.MY_TEST_KEY || ('0x' + '11'.repeat(32)));
// ------------------------------------------------------------------------------------------------

/**
 * @param {{payload: object, envelope: object}} args
 *   payload  — exactly what lib/envelope.js::signablePayload() produced: {domain, types, primaryType, message}
 *   envelope — the full envelope, if you want to inspect or refuse it before signing
 * @returns {Promise<string>} a 0x… signature. Throw to REFUSE — the node will not send unsigned.
 */
module.exports = async function sign({ payload, envelope }) {
  // A signer is also a policy point, and it is the right one: this is the last moment before your
  // address vouches for a message. Refusing here is safe — lib/node.js turns a throw into a refusal,
  // never into an unsigned send.
  if (envelope && typeof envelope.body === 'string' && envelope.body.length > 4096) {
    throw new Error('refusing to sign an oversized body');
  }
  return account.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message,
  });
};

// The address this signer speaks as. It MUST equal the node's LAWBOR_ADDR, or every peer will refuse
// the envelopes as impersonation — a valid signature by the wrong key is still refused, by design.
module.exports.address = account.address;
