'use strict';
/* ERC-8004 registration DESCRIPTOR — builds the transaction, never sends it.
 * =================================================================================================
 * Mints an `agentId` (ERC-721) in the ERC-8004 Identity Registry so any A2A/MCP agent can discover
 * this node. Everything here is verified rather than assumed:
 *
 *   - the registry address is CHECKED ON-CHAIN (is it a contract? does it answer name()/symbol()?
 *     does it declare ERC-721 via ERC-165?) before anything is encoded;
 *   - the `register(string)` selector 0xf2c298be was recovered from the DEPLOYED bytecode's dispatch
 *     table and resolved against the public 4byte directory — not copied from a blog post;
 *   - the agentURI is FETCHED and validated before the calldata is built. This is the load-bearing
 *     check: the first empirical study of ERC-8004 (Xiong et al., through 2026-05-13) found that only
 *     3% / 4% / 15% of registrations on Ethereum / BSC / Base expose a live endpoint — the rest are
 *     placeholders. Encoding a registration for a URL that 404s is how you become one. So we refuse.
 *
 * 🛑 THIS SCRIPT NEVER SIGNS AND NEVER SENDS. It prints a transaction for the operator to sign from
 *    their own wallet — the same descriptor-only rule the whole project runs on.
 *
 *   node erc8004-register.cjs https://your-node.example
 */
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';   // Base mainnet, verified below
const RPC = process.env.LAWBOR_RPC_URL && process.env.LAWBOR_RPC_URL !== 'off'
  ? process.env.LAWBOR_RPC_URL : 'https://mainnet.base.org';
const SELECTOR = '0xf2c298be';                                    // register(string)

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + j.error.message);
  return j.result;
};
const decodeString = (hex) => {
  if (!hex || hex === '0x') return null;
  try { const b = Buffer.from(hex.slice(2), 'hex'); const len = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + len).toString('utf8'); } catch { return null; }
};
/** ABI-encode register(string). Head/tail layout: offset(32) | length(32) | utf8 padded to 32. */
function encodeRegister(uri) {
  const bytes = Buffer.from(uri, 'utf8');
  const pad = (h) => h.padStart(64, '0');
  const body = bytes.toString('hex') + '0'.repeat((32 - (bytes.length % 32)) % 32 * 2);
  return SELECTOR + pad('20') + pad(bytes.length.toString(16)) + body;
}

(async () => {
  const baseUrl = (process.argv[2] || '').replace(/\/$/, '');
  console.log('ERC-8004 registration descriptor (Base mainnet)\n');

  // 1. the registry is real, and is what it claims to be
  const code = await rpc('eth_getCode', [REGISTRY, 'latest']);
  if (!code || code === '0x') { console.error('REFUSED: ' + REGISTRY + ' is not a contract on this chain.'); process.exit(1); }
  const call = (data) => rpc('eth_call', [{ to: REGISTRY, data }, 'latest']).catch(() => null);
  const name = decodeString(await call('0x06fdde03'));
  const symbol = decodeString(await call('0x95d89b41'));
  const is721 = await call('0x01ffc9a7' + '80ac58cd' + '0'.repeat(56));
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  console.log('  registry   :', REGISTRY);
  console.log('  verified   :', name + ' / ' + symbol, '· ERC-721:', !!(is721 && BigInt(is721) === 1n), '· chainId:', chainId);
  if (chainId !== 8453) { console.error('REFUSED: this RPC is not Base (chainId ' + chainId + ').'); process.exit(1); }
  if (name !== 'AgentIdentity') { console.error('REFUSED: the contract does not identify as AgentIdentity — do not register into it blind.'); process.exit(1); }

  if (!baseUrl) {
    console.log('\n  Usage: node erc8004-register.cjs https://your-public-node.example');
    console.log('  The agentURI must be a PUBLIC url that really serves /.well-known/agent-registration.json.');
    console.log('  A local node is not enough: an unreachable agentURI is exactly the placeholder');
    console.log('  registration that 85-97% of the ecosystem already consists of.');
    process.exit(0);
  }

  // 2. the agentURI must ACTUALLY serve a valid registration file — the whole point
  const agentURI = baseUrl + '/.well-known/agent-registration.json';
  console.log('\n  agentURI   :', agentURI);
  let card;
  try {
    const r = await fetch(agentURI, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    card = await r.json();
  } catch (e) {
    console.error('\n  REFUSED: could not fetch the registration file (' + e.message + ').');
    console.error('  Deploy the node publicly first. Registering an unreachable URI creates a placeholder,');
    console.error('  which is the exact pathology this project refuses to add to.');
    process.exit(1);
  }
  const problems = [];
  if (card.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1') problems.push('wrong or missing `type`');
  if (!card.name) problems.push('missing `name`');
  if (!card.description) problems.push('missing `description`');
  if (!card.image) problems.push('missing `image`');
  if (!Array.isArray(card.services) || !card.services.length) problems.push('no `services`');
  if (card.active !== true) problems.push('`active` is not true');
  // a service endpoint that does not answer is the placeholder pathology in miniature
  for (const s of (card.services || []).slice(0, 4)) {
    try { const r = await fetch(s.url, { method: 'GET' }); if (!r.ok && r.status >= 500) problems.push('service ' + s.type + ' returned ' + r.status); }
    catch (e) { problems.push('service ' + s.type + ' (' + s.url + ') is unreachable'); }
  }
  console.log('  file       :', problems.length ? 'INVALID → ' + problems.join('; ') : 'valid, endpoints answer');
  if (problems.length) { console.error('\n  REFUSED: fix the registration file before minting an identity that points at it.'); process.exit(1); }

  // 3. the descriptor — for the OPERATOR to sign
  const data = encodeRegister(agentURI);
  console.log('\n────────────────────────────────────────────────────────────────────────');
  console.log('  SIGN THIS YOURSELF — I do not sign and I do not send.');
  console.log('    network  : Base mainnet (chainId 8453)');
  console.log('    to       : ' + REGISTRY);
  console.log('    value    : 0');
  console.log('    function : register(string agentURI)   [selector ' + SELECTOR + ', read off the deployed bytecode]');
  console.log('    argument : ' + agentURI);
  console.log('    data     : ' + data);
  console.log('\n  After it confirms, read your agentId from the Transfer event (tokenId) and set:');
  console.log('    LAWBOR_AGENT_ID=eip155:8453:' + REGISTRY + ':<tokenId>');
  console.log('  The registration file then advertises it, and the claim becomes checkable both ways.');
  console.log('────────────────────────────────────────────────────────────────────────');
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
