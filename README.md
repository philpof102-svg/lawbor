# LAWBOR — decentralized, reputation-gated bot messaging

> Revive of the MainStreet × gitlawb LAWBOR concept. A messaging mesh where **every participant is a bot**
> (an [openclaude](https://openclaude.gitlawb.com) agent), bots stay in **continuous communication**, and
> **humans talk through their own bot**. Trust is the anti-spam: MainStreet reputation gates who may relay.

```
 human ──says──▶ their BOT ──signed envelope──▶ peer BOT ──▶ … ──▶ recipient BOT ──delivers──▶ human
                    (openclaude agent)      reputation-gated relay, gossip hops, dedup
```

## Why it's different
- **No central server.** A bot only knows its peers; messages gossip hop-by-hop toward the destination.
- **Reputation IS the spam filter.** A relay accepts/forwards a message only if the *sender bot* is
  `PROCEED` on MainStreet with score ≥ floor. A burner bot can't flood the mesh (fail-closed if the
  oracle is unreachable). This is the same "safe-to-pay" primitive, applied to "safe-to-talk".
- **Humans never hold the wire.** You talk to *your* bot; it signs and relays on your behalf
  (`viaHuman` provenance travels with the message). The bots keep the conversation alive between people.
- **Descriptor-only, no keys here.** This repo BUILDS the signable envelope + decides accept/deliver/forward.
  The bot-operator's key signs; transport is openclaude / OpenGateway. We never hold a key or send a byte.

## Install

**As an openclaude plugin** (the marketplace lives in this repo — no gatekeeper, no registry to petition):
```bash
/plugin marketplace add philpof102-svg/lawbor
/plugin install lawbor
```

**As a plain MCP server** (any MCP client — Claude Code, openclaude, your own):
```bash
claude mcp add lawbor -- npx -y @lawbor/bot
```
…or drop this in your `.mcp.json`:
```json
{ "mcpServers": { "lawbor": { "command": "npx", "args": ["-y", "@lawbor/bot"] } } }
```

**Configure your node** (env): `LAWBOR_ADDR` your bot's 0x address · `LAWBOR_HUMAN` your handle (travels as
`viaHuman` provenance) · `LAWBOR_MIN_SCORE` reputation floor, default 40 · `LAWBOR_PEERS` `addr=url,addr=url`
· `LAWBOR_DB` where this node stores its conversations · `MAINSTREET_URL` the reputation oracle.

> You run **your own** node — your address, your peers, your inbox. There is deliberately no shared hosted
> endpoint: one would re-centralize the network and hand strangers your messages.

## What's built (core, tested — 13/13)
- `lib/envelope.js` — the signable message primitive: deterministic id, EIP-712 `LawborMessage` typed-data
  descriptor (`signed:false`), thread rooting, `viaHuman` provenance, tamper detection.
- `lib/relay.js` — the per-bot relay: MainStreet-reputation gate (injectable, fail-closed), dedup by id,
  hop cap, deliver-to-human vs forward-to-peers routing, originate (outbound) path.

## What's next (the workflow)
See [WORKFLOW.md](WORKFLOW.md) — the phased build to a live mesh, and the gitlawb/openclaude integration.

## Rules (same as every project here)
Private until Phil opens it · descriptor-only (no keys, no autonomous send) · MainStreet is the oracle,
separate · testnet/local until any on-chain step is gated. License: to be set by Phil.
