# LAWBOR as a platform — ship apps, sell premium

LAWBOR is a node you run. This is how it becomes something you build **on** — games, feeds, tools —
and how a premium tier is charged **honestly** over x402.

## The honesty line (why we don't sell "the software")

The node is open-source (MIT). You **cannot** charge for access to software someone self-hosts —
they fork it and delete the paywall in one line. Any "pay for full access to the system" that gates
the *code* is a false promise, and this repo doesn't make it.

What has real, non-self-providable value — and what we sell — is a **hosted service + content**:

| | free | premium (5 USDC / month via x402) |
|---|---|---|
| the node software | ✅ run your own | ✅ same software |
| your inbox, jobs, mesh | ✅ | ✅ |
| **a hosted node the operator runs** | — | ✅ its content is the product |
| **premium apps / curated content / a hosted catalog** | — | ✅ |

The free node stays free (the decentralization principle holds). The paid tier is the operator's
**hosted node's content**, which has genuine marginal cost — hosting, curation, availability — that a
fork cannot reproduce. You pay for the meal, not the recipe.

## Ship an app (a game, a feed, a tool)

An app is one module. It declares HTTP routes and/or MCP tools; a node loads a list of them.

```js
// apps/tictactoe.js
module.exports = {
  name: 'tictactoe',
  description: 'play a game on your node',
  routes: [{ method: 'POST', path: '/move', handle: (ctx) => ({ body: nextBoard(ctx.body) }) }],
  tools:  [{ name: 'move', description: 'make a move', inputSchema: {/*…*/}, handle: (args, ctx) => nextBoard(args) }],
};
```

Load it:
```js
const { apps } = require('./apps/example');           // or your own list
build({ apps: [require('./apps/tictactoe'), ...apps] });
```

It appears at `GET /apps`, its routes under `/app/tictactoe/…`, its tools as `app_tictactoe_…` in the
MCP tool list. No fork, no core edit. Handlers run in-process and follow the same rules as the rest of
LAWBOR: **no key, no signing, no funds.** See `apps/example.js` for a free app and a premium one.

## Make an app premium (the 5 USDC / month subscription)

Add `premium: true`. Its routes and tools now answer **HTTP 402** with an x402 payment pointer until
the caller holds an active subscription.

```
GET /app/vault/latest                         → 402 { accepts:[{ payTo:<wallet>, maxAmountRequired:"5000000", asset:USDC }] }
POST /x402/settle  { payment: <x402 payload> } → verifies the payment → records a 30-day subscription for the payer
GET /app/vault/latest   (x-lawbor-caller: 0x…) → 200 (subscribed)  |  402 (not)
```

- **The money goes straight to the operator's wallet** (`LAWBOR_PAY_TO`). LAWBOR **never holds a key
  or receives funds** — it only issues the 402 challenge and verifies a submitted proof. That is the
  same descriptor-only rule as everywhere else.
- **Verification is injected** (`x402verify` → an x402 facilitator / RPC read; that is network I/O, so
  it lives in the operator's wiring, not in `lib/`). **No verifier ⇒ fail closed:** a premium app is
  refused, never served free.
- Deploy the receiving wallet as the **MainStreet wallet** (`rakshasar.base.eth`): every subscription
  settles there.

Run a premium node:
```bash
LAWBOR_PAY_TO=0x…mainstreet-wallet  LAWBOR_PRICE=5  node server.js
# wire deps.x402verify to your x402 facilitator in code, or via a small adapter
```

## Honest limits (v1 — stated, not hidden)

- **Caller authentication is opt-in.** Wire `deps.verifyAuth` (same shape as the relay's `verifySig`)
  and a caller proves control of their address by signing a time-windowed challenge
  (`LAWBOR-AUTH:<addr>:<epoch-minute>`) in `x-lawbor-auth: <addr>:<sig>` — the minute window stops
  replay with no server state. Then a forged claim on a subscribed address is refused. **Without**
  `verifyAuth` wired, the gate falls back to an unauthenticated `x-lawbor-caller` header (dev/testing
  only). `/health` and `/apps` report `authenticatesCaller` and `verifies` so no one assumes a gate
  that isn't on. Run a real premium node with both `x402verify` and `verifyAuth` wired.
- **A subscription is 30 days from payment**, tracked on the node's own clock in an append-only ledger
  — no external subscription service.
- **Premium is only meaningful on a hosted node.** On a node someone self-hosts, they own the paywall;
  that's fine — the free node was always theirs. The product is the *operator's* hosted content.

## Where this goes

`help_wanted → bid → award` (jobs), the two-view messaging, the consent gate, and now apps + a paid
tier are all on one node. A game studio ships a `premium: true` game; a curator ships a `premium: true`
feed; both settle to the same wallet. The base stays free and federated; the premium is hosted content
anyone can add to and the operator charges for — which is the only thing here that a fork can't take.
