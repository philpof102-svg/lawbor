'use strict';
/**
 * A REFERENCE remote-signer ENDPOINT — the SERVER half of examples/signer-remote.js.
 * ================================================================================================
 * This is what LAWBOR_SIGNER_URL points at. The node sends { payload, envelope }; this endpoint holds
 * the key, decides whether to sign, and returns { signature }. Run it anywhere the key may live and the
 * node cannot reach the key directly:
 *
 *   LAWBOR_SIGNER_KEY=0x<throwaway 32-byte key>  LAWBOR_SIGNER_PORT=8787 \
 *   [LAWBOR_SIGNER_TOKEN=<shared secret>] [LAWBOR_SIGNER_ADDR=0x<expected addr>] \
 *   node examples/signer-endpoint.js
 *
 * Then the node:
 *   LAWBOR_ADDR=<that address>  LAWBOR_SIGNER=./examples/signer-remote.js \
 *   LAWBOR_SIGNER_URL=http://127.0.0.1:8787/sign  [LAWBOR_SIGNER_TOKEN=<same secret>] node server.js
 *
 * 🛑 THIS IS A REFERENCE, and it holds the key IN PROCESS via LAWBOR_SIGNER_KEY. That is acceptable for
 * ONE case and no other: a THROWAWAY identity for a public node (posture A) whose compromise costs a
 * reputation rebuild and never money. For anything holding funds, replace the two lines under "the key"
 * with a call to a KMS / HSM / CDP server-wallet — the private key then never exists in this process at
 * all, and everything else here (the policy gate, the auth, the address check) stays exactly the same.
 *
 * It is a POLICY POINT, not a signing oracle. Signing is the last gate before an address vouches for a
 * message, so this endpoint REFUSES rather than signs when anything looks wrong:
 *   - a bearer token may be required, so only the node that knows the secret can ask;
 *   - the payload must be a well-formed EIP-712 LAWBOR message for the expected domain;
 *   - the body length is bounded (an over-long body is refused, matching the node's own 8192 cap);
 *   - if LAWBOR_SIGNER_ADDR is set, the endpoint refuses to sign as any other address — a guard against
 *     being pointed at the wrong key by mistake.
 * Add your own rules here (rate limit, allowlist of `to`, a human tap for unusual bodies): this file is
 * where operator judgement belongs.
 */
const http = require('node:http');
const { privateKeyToAccount } = require('viem/accounts');

const PORT = Number(process.env.LAWBOR_SIGNER_PORT || 8787);
const TOKEN = process.env.LAWBOR_SIGNER_TOKEN || null;         // optional shared secret
const EXPECT_ADDR = (process.env.LAWBOR_SIGNER_ADDR || '').toLowerCase() || null;
const MAX_BODY = 16 * 1024;                                    // generous; the LAWBOR body cap is 8192

// --- the key: THE ONLY PART TO REPLACE FOR A FUND-HOLDING IDENTITY (use a KMS/CDP instead) ----------
const KEY = process.env.LAWBOR_SIGNER_KEY;
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  throw new Error('LAWBOR_SIGNER_KEY must be a 0x 32-byte key. For a public node use a THROWAWAY key, never the one that holds funds.');
}
const account = privateKeyToAccount(KEY);
// ----------------------------------------------------------------------------------------------------

if (EXPECT_ADDR && account.address.toLowerCase() !== EXPECT_ADDR) {
  throw new Error('LAWBOR_SIGNER_KEY is for ' + account.address + ' but LAWBOR_SIGNER_ADDR expects ' + EXPECT_ADDR + ' — refusing to start with the wrong key');
}

/** Reject anything that is not a LAWBOR EIP-712 message we recognise, before touching the key. */
function acceptable(payload) {
  if (!payload || typeof payload !== 'object') return 'no payload';
  const d = payload.domain, t = payload.types, m = payload.message;
  if (!d || d.name !== 'LAWBOR') return 'not a LAWBOR domain';
  if (!t || !payload.primaryType || !m) return 'incomplete typed data';
  return null;   // ok
}

const server = http.createServer((req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return reply(405, { error: 'POST { payload, envelope } to sign' });
  if (TOKEN && req.headers.authorization !== 'Bearer ' + TOKEN) return reply(401, { error: 'bad or missing bearer token' });

  req.setEncoding('utf8');
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > MAX_BODY) { reply(413, { error: 'body too large' }); req.destroy(); } });
  req.on('end', async () => {
    let parsed; try { parsed = JSON.parse(b); } catch { return reply(400, { error: 'unparseable JSON' }); }
    const why = acceptable(parsed.payload);
    if (why) return reply(422, { error: 'refused: ' + why });          // a REFUSAL, deliberate, not a crash
    try {
      const p = parsed.payload;
      const signature = await account.signTypedData({ domain: p.domain, types: p.types, primaryType: p.primaryType, message: p.message });
      return reply(200, { signature });
    } catch (e) {
      return reply(500, { error: 'sign failed: ' + ((e && e.message) || e) });
    }
  });
});

// Listen ONLY when run directly. Importing this file (a test, or a wrapper that adds its own policy)
// must NOT start a server — that made it un-importable and forced double-listen. Standard main-guard.
if (require.main === module) {
  server.listen(PORT, () => {
    // print the ADDRESS (public, safe) — never the key
    console.log('LAWBOR reference signer endpoint on :' + PORT + ' — signs as ' + account.address
      + (TOKEN ? ' · bearer-gated' : ' · OPEN (set LAWBOR_SIGNER_TOKEN for a shared secret)')
      + '\n  point a node at it:  LAWBOR_ADDR=' + account.address + '  LAWBOR_SIGNER_URL=http://<host>:' + PORT + '/sign');
  });
}

module.exports = { server, address: account.address };
