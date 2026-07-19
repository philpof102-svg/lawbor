'use strict';
/**
 * LAWBOR — chain.js  (the only thing here that reads Base, and it reads NOTHING else)
 * ================================================================================================
 * lib/work.js is pure and cannot fetch, so a `settle` claim is only ever promoted to a verified
 * settlement when it is handed an immutable chain FACT. This module is what produces those facts, and
 * it is deliberately the narrowest possible reader: given a txHash it returns the single USDC transfer
 * that transaction made, or null. It never signs, never sends, never holds a key — read-only JSON-RPC.
 *
 * IT REFUSES RATHER THAN GUESSES, in three places that each protect the rating from a false positive:
 *   1. CHAIN IDENTITY. It calls eth_chainId once and refuses everything if it is not Base (8453). An
 *      RPC url mis-pointed at Ethereum (or a fork) would otherwise happily "verify" transfers of a
 *      DIFFERENT token on a DIFFERENT chain, minting standing for money that never moved on Base.
 *   2. AMBIGUITY. A transaction containing zero USDC transfers is not a settlement; one containing
 *      SEVERAL (a swap, a batch, a disperse) gives us no way to know which one is "the" payment, and
 *      picking one would be manufacturing evidence. Both cases return null.
 *   3. FAILURE. A reverted tx, an unfetchable receipt, a malformed hash — null. Every path that is not
 *      a fully-read, successful, unambiguous USDC transfer produces no fact, and no fact means no credit.
 *
 * `confirmations` is computed against the current head, so it GROWS. Callers that cache a fact must
 * only cache one that is already final (see server.js), or they would freeze a young tx at 3 forever.
 */

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_CHAIN_ID = 8453;
// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event signature
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const hex = (x) => { try { return Number(BigInt(x)); } catch { return NaN; } };
const addrFromTopic = (t) => '0x' + String(t || '').slice(-40).toLowerCase();

/**
 * @param {object} o  { rpcUrl, fetch, token=USDC_BASE, chainId=8453 }
 * @returns reader with { checkTx(txHash) -> fact|null, chainOk() } — or NULL if not configured, which
 *          callers must treat as "cannot verify anything" (fail closed), never as "everything is fine".
 */
function createChainReader(o = {}) {
  const rpcUrl = o.rpcUrl, doFetch = o.fetch;
  if (!rpcUrl || typeof doFetch !== 'function') return null;
  const token = String(o.token || USDC_BASE).toLowerCase();
  const chainId = Number(o.chainId || BASE_CHAIN_ID);
  let id = 0, chainChecked = null;

  const rpc = async (method, params) => {
    const r = await doFetch(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!r || !r.ok) throw new Error('rpc http ' + (r && r.status));
    const j = await r.json();
    if (j && j.error) throw new Error('rpc: ' + (j.error.message || 'error'));
    return j && j.result;
  };

  const reader = {
    /** Is this RPC actually Base? Asked once, cached, and fatal to verification if false. */
    async chainOk() {
      if (chainChecked !== null) return chainChecked;
      try { chainChecked = hex(await rpc('eth_chainId', [])) === chainId; } catch { chainChecked = false; }
      return chainChecked;
    },

    /** The single USDC transfer this tx made, as an immutable fact — or null. */
    async checkTx(txHash) {
      if (!/^0x[0-9a-f]{64}$/i.test(String(txHash || ''))) return null;
      if (!(await reader.chainOk())) return null;              // wrong/unknown chain ⇒ verify nothing

      let rc; try { rc = await rpc('eth_getTransactionReceipt', [txHash]); } catch { return null; }
      if (!rc || !rc.blockNumber) return null;                 // pending or unknown
      if (hex(rc.status) !== 1) return null;                   // reverted tx settles nothing

      const transfers = (rc.logs || []).filter((l) =>
        String(l.address || '').toLowerCase() === token &&
        String((l.topics || [])[0] || '').toLowerCase() === TRANSFER_TOPIC &&
        (l.topics || []).length >= 3);
      if (transfers.length !== 1) return null;                 // 0 = not a payment; >1 = ambiguous, refuse
      const l = transfers[0];
      let valueMicro; try { valueMicro = BigInt(l.data).toString(); } catch { return null; }

      let head; try { head = hex(await rpc('eth_blockNumber', [])); } catch { return null; }
      const bn = hex(rc.blockNumber);
      if (!Number.isFinite(bn) || !Number.isFinite(head)) return null;

      let blockTime = null;
      try { const b = await rpc('eth_getBlockByNumber', [rc.blockNumber, false]); blockTime = b && b.timestamp ? hex(b.timestamp) : null; } catch { /* a missing timestamp only costs ordering, not validity */ }

      return {
        chainId, token,
        from: addrFromTopic(l.topics[1]),
        to: addrFromTopic(l.topics[2]),
        valueMicro,
        confirmations: Math.max(0, head - bn + 1),
        blockNumber: bn, blockTime,
      };
    },
  };
  return reader;
}

module.exports = { createChainReader, USDC_BASE, BASE_CHAIN_ID, TRANSFER_TOPIC };
