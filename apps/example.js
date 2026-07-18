'use strict';
/**
 * LAWBOR apps — a template you copy to ship your own (a game, a feed, a tool) on a node.
 * ======================================================================================
 * Two apps: `hello` (free) and `vault` (premium, x402-gated). A node loads them with createApps([...]).
 * An app declares routes and/or tools; ctx gives it the node/store and the caller's address. Handlers
 * run in-process — no key, no signing, no funds. To ship your own: export an app of the same shape,
 * add it to the node's app list (LAWBOR_APPS or build({ apps })), done. Premium apps only make sense
 * on a HOSTED node the operator runs (a fork removes the gate — see PLATFORM.md).
 */

// FREE app: proves the mechanism. A tiny deterministic "daily roll" — no state, no luck to store.
const hello = {
  name: 'hello',
  description: 'a free example app — a health ping and a deterministic daily roll',
  routes: [
    { method: 'GET', path: '/', handle: (ctx) => ({ body: { app: 'hello', node: ctx.node.self, caller: ctx.caller || null, msg: 'apps run on your node — ship your own, see PLATFORM.md' } }) },
    { method: 'GET', path: '/roll', handle: (ctx) => {
      const day = Math.floor((ctx.now || Date.now()) / 86400000);
      const roll = 1 + ((day * 2654435761) % 6);          // deterministic per-day, same for everyone
      return { body: { day, roll, of: 6, note: 'deterministic — everyone sees the same roll today' } };
    } },
  ],
  tools: [
    { name: 'ping', description: 'health check for the hello app', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: (_a, ctx) => ({ ok: true, node: ctx.node.self }) },
  ],
};

// PREMIUM app: the same shape + `premium:true`. Its routes/tools return 402 until the caller holds an
// active x402 subscription (5 USDC/mo → the operator's wallet). This is the shape a paid game or a
// curated content feed takes.
const vault = {
  name: 'vault',
  description: 'a premium example — content behind the 5 USDC/mo x402 subscription',
  premium: true,
  routes: [
    { method: 'GET', path: '/latest', handle: (ctx) => ({ body: {
      app: 'vault', premium: true, caller: ctx.caller,
      content: ['premium item #1', 'premium item #2', 'premium item #3'],
      note: 'you are seeing this because your subscription is active',
    } }) },
  ],
  tools: [
    { name: 'read', description: 'read the premium feed (requires an active subscription)', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: (_a, ctx) => ({ premium: true, items: ['premium item #1', 'premium item #2'], caller: ctx.caller }) },
  ],
};

module.exports = { hello, vault, apps: [hello, vault] };
