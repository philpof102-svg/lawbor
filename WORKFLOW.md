# LAWBOR — build workflow (decentralized bot messaging on openclaude/gitlawb)

> The plan Phil asked to prepare. Anti-bloat, gated, tied to the moat (MainStreet reputation). Each phase
> ships something testable; nothing signs or sends until the phase that explicitly enables it.

## Phase 0 — core primitive ✅ DONE (this repo, 13/13)
Envelope (signable, tamper-evident) + reputation-gated relay (deliver/forward/dedup/hop-cap, fail-closed).
Pure logic, injectable preflight, zero network. This is the invariant layer everything else builds on.

## Phase 1 — the bot: an openclaude agent that runs a relay
Wrap the relay in an openclaude agent loop (like Toshi rides openclaude):
- `bin/lawbor.mjs` — `lawbor start` boots a bot: loads/creates a DID (0x address), reads peers, runs the relay.
- Human interface: `lawbor say <peer> "<msg>"` builds the envelope, the operator signs (wallet/openclaude
  signer), the relay originates it. `lawbor inbox` shows delivered messages.
- Transport adapter: inject `send(target, envelope)` — v1 = HTTP POST to a peer's `/lawbor/accept`; the relay
  stays transport-agnostic (the same `accept()`/`forward()` decisions drive any transport).
- Wire the reputation gate to the REAL MainStreet: `preflight(addr)` → `GET /api/agent/preflight/<addr>`
  (x-ms-monitor:1 while testing). This is where each relay decision becomes a MainStreet call → the metric.

## Phase 2 — the mesh: presence + peer discovery (`lib/mesh.js`)
- Heartbeat: each bot pings peers on an interval → "continuous communication" (the always-on layer).
- Peer gossip: exchange peer lists on contact so the mesh grows without a central directory.
- Route hint: prefer a direct peer when known, else gossip — already stubbed in `relay.accept`.
- OpenGateway tie-in: if a message needs an LLM step (a bot summarizing/triaging before delivery), route
  that paid call through OpenGateway with `requireMinScore(payTo, 60)` — the trust-gated routing idea.

## Phase 3 — gitlawb-native distribution
- Publish as an openclaude/gitlawb project (mirror to gitlawb via `gl`, same flow as Toshi — pending the
  human iCaptcha). A LAWBOR bot IS an openclaude agent, so it belongs on the gitlawb node.
- `/.well-known/lawbor.json` — a bot advertises its address + accept endpoint + min-score policy, so any
  agent can discover how to reach it (the agent-consumable pattern from XMoment/MainStreet).

## Phase 4 — the LAWBOR primitives on top of DMs (the original concept, revived)
Once messaging is live, the rest of LAWBOR are typed messages over the same mesh:
- `lawbor_help_wanted` / `lawbor_availability` — a bot broadcasts a task or "open for work".
- `lawbor_peer_review` / `lawbor_attestation` — a bot reviews another's work → an EIP-712 attestation that
  updates the MainStreet score (closes the reputation-work loop: better rep → reach more/higher bots).
- `lawbor_reward_pool` — settle a completed task in USDC (descriptor-only; a human signs; Loop-escrow-style).

## The moat (why only we can assemble this)
Messaging is commodity; **reputation-gated** messaging is not. We already hold the oracle (MainStreet),
the escrow pattern (Loop/RugRace), and the agent host (openclaude/gitlawb). LAWBOR is the human-and-bot
communication layer that ties them: talk safely, work, get attested, reach further. Anti-spam by trust,
not by captcha.

## Gates (Phil)
- No autonomous send/sign — the operator's key signs each envelope; the bot relays.
- Reputation floor + fail-closed are non-negotiable (that's the whole anti-spam thesis).
- Mainnet attestations/rewards behind the same audit+legal gate as Loop/RugRace.
- gitlawb mirror needs the human iCaptcha (never bypass).
