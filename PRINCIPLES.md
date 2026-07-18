# LAWBOR — where it sits in the loop → swarm → org lineage

Three ideas are converging in agent engineering, and they stack:

- **A loop** makes one agent's *behaviour* programmable — it works, checks its own progress, and keeps
  going until a **verifiable** finish line, not a vibe.
- **A swarm** is many loops in parallel, each a **specialist** owning one stage of a pipeline, passing
  its output down the chain.
- **A dynamic agent org** is a swarm whose **dependency graph rewrites itself while the work happens**.

LAWBOR is the layer the third step needs that the tooling around loops and swarms skips: **trust and
coordination between agents that different people own.** A loop harness (Claude Code, Slate Programs,
etc.) coordinates *your* agents; it assumes they are all trusted because they are all yours. The moment
a maker and a checker belong to **different parties**, you need a substrate that answers "may this
stranger's agent take this job, and is its work worth building on?" — reputation + a shared, honest
job graph. That is LAWBOR.

## The five failure modes that kill agent systems — and where LAWBOR lands

A widely-shared field note lists five ways multi-agent systems fail. They are a good yardstick. LAWBOR
addresses the *coordination* ones by construction and is deliberately silent on the *domain* ones.

1. **Skipping the validator.** — *Out of scope, on purpose.* Whether a job's output is any good is
   domain logic (a backtest's Sharpe, a diff's tests). LAWBOR does not judge work quality; it carries
   the negotiation and the graph. It won't pretend to be your validator.
2. **No state persistence / re-doing rejected work.** — *Addressed.* State is an append-only log folded
   on read; nothing drifts. An agent does not have to *try and be refused* to learn a job isn't
   available — the graph publishes the **ready frontier** and, for every blocked job, exactly what it is
   `blockedBy`. You read what is claimable before you spend a bid.
3. **No maker ≠ checker split.** — *This is LAWBOR's core.* "The agent that generated the work is the
   worst judge of whether it is real." LAWBOR makes maker and checker **different reputable parties**:
   the relay authenticates `from` and reputation-gates who may act at all, and a dependent job unblocks
   on an **award** (an external signal) — never on the worker's own claim of "done". `dynamic-org` shows
   a checker failing a stage and the org's planner rewriting the live graph in response.
4. **One agent doing everything.** — *Addressed by the graph.* `dependsOn` turns a flat job list into a
   pipeline where each stage is a separate job a separate specialist claims. Specialisation is the
   default shape, not an add-on.
5. **No stopping condition checkable by something other than the agent's own claim.** — *Addressed.*
   Readiness is derived, not asserted: a dependency is satisfied only when its upstream is **awarded**
   by the requester — a signal from a different party, verifiable by anyone folding the same log. A
   worker announcing completion changes nothing on its own.

## The honesty line (same as everywhere else here)

- A dependency being satisfied means the upstream was **awarded** (a worker chosen), **not delivered**.
  LAWBOR models no execution or settlement, so it orders *negotiations*; it does not track completion.
  We do not add a third-party "attestation of done", because an attestation two colluding addresses can
  mint is a lie the graph would then trust (an adversarial panel killed that primitive already).
- The moat these notes keep circling is not the code — the loop, the graph, the formulas are all public.
  It is the **discipline around them**: verifiable stops, maker ≠ checker, killing what decays, proving a
  claim instead of asserting it. LAWBOR encodes the coordination half of that discipline. The rest is how
  you run your agents — see the field notes, not this repo, for the domain half.

*Provenance: distilled from the loop/swarm/quant field notes circulating mid-2026; the engineering
principles, not the products, are what carried over.*
