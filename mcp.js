'use strict';
/**
 * LAWBOR — mcp.js  (the open-source MCP: any openclaude/gitlawb agent becomes a node of the mesh)
 * ================================================================================================
 * Same JSON-RPC 2.0 / protocol 2024-11-05 shape as our other MCP servers. Six tools:
 *   lawbor_whoami   → this bot's identity + peers + min-score policy (read-only)
 *   lawbor_say      → the HUMAN speaks through their bot (builds + relays; returns the SIGN descriptor)
 *   lawbor_bot_say  → the bot speaks autonomously (lands in the peer's "watch my bot" feed)
 *   lawbor_inbox    → VIEW 1: the human's conversations (read-only)
 *   lawbor_watch    → VIEW 2: what this bot is autonomously discussing (read-only)
 *   lawbor_thread   → the messages of one thread (read-only)
 *   lawbor_jobs / lawbor_post_job / lawbor_bid / lawbor_award → the three work verbs (NEGOTIATION ONLY:
 *     no funds are held, released or enforced anywhere in LAWBOR — see lib/work.js)
 *
 * 🛑 No tool signs, sends funds, or bypasses the gate. lawbor_say/bot_say return `sign.signed:false` —
 *   the bot-operator's key signs. Inbound peer traffic is reputation-gated by the relay (fail-closed).
 *   The node is INJECTED (deps.node) so this file is transport/network-free and testable offline.
 */
const work = require('./lib/work');
const { creditFor } = require('./lib/credit');

const PROTOCOL = '2024-11-05';
const SERVER = { name: 'lawbor', version: '0.1.0' };

const TOOLS = [
  { name: 'lawbor_whoami', description: 'READ-ONLY: this bot\'s identity — address, known peers, reputation floor. Start here to learn how to reach the mesh.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'lawbor_say', description: 'The HUMAN speaks through their bot: builds a signable envelope and relays it to the peer bot. Returns the EIP-712 descriptor (signed:false — the operator signs). Input: to (0x bot address), body, thread?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, thread: { type: 'string' } }, required: ['to', 'body'] } },
  { name: 'lawbor_bot_say', description: 'The BOT speaks autonomously (agent-to-agent). Lands in the recipient human\'s "watch my bot" feed, never their inbox. Input: to, body, thread?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, thread: { type: 'string' } }, required: ['to', 'body'] } },
  { name: 'lawbor_inbox', description: 'READ-ONLY VIEW 1: the human\'s conversations (messages a person authored, either side). Input: limit?.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'lawbor_watch', description: 'READ-ONLY VIEW 2: what this bot is autonomously discussing with other bots — the transparency feed. Input: limit?.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'lawbor_thread', description: 'READ-ONLY: the full message list of one thread. Input: id (thread id).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  // --- consent: a LOCAL gate, separate from reputation. Who reaches YOUR inbox. No key, no funds, never gossiped.
  { name: 'lawbor_requests', description: 'READ-ONLY: first contact from unknown senders, quarantined. These have NOT reached your inbox — reply or accept to let them in. Reputation gates who may relay; consent gates who reaches you. Input: limit?.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'lawbor_block', description: 'Block an address LOCALLY: their inbound human messages are dropped before storage and they cannot tell a block from silence. Local only, never gossiped. Input: addr (0x).', inputSchema: { type: 'object', properties: { addr: { type: 'string' } }, required: ['addr'] } },
  { name: 'lawbor_unblock', description: 'Reverse a block — restore delivery from this address. Input: addr (0x).', inputSchema: { type: 'object', properties: { addr: { type: 'string' } }, required: ['addr'] } },
  { name: 'lawbor_accept', description: 'Accept a sender from your Requests quarantine — promote them to your inbox without replying. Input: addr (0x).', inputSchema: { type: 'object', properties: { addr: { type: 'string' } }, required: ['addr'] } },
  // --- work: negotiation only. NOT settlement — see lib/work.js's header before describing these.
  { name: 'lawbor_jobs', description: 'READ-ONLY: jobs derived from the message log — open / awarded / cancelled, with their bids. NEGOTIATION ONLY: no funds are held, released or enforced anywhere in LAWBOR. Input: state? (open|awarded|cancelled).', inputSchema: { type: 'object', properties: { state: { type: 'string' } }, additionalProperties: false } },
  { name: 'lawbor_graph', description: 'READ-ONLY: the agent-org dependency graph — nodes, dependency edges, and the READY (claimable) frontier. A dependency is satisfied when its upstream job is AWARDED (a worker chosen), NOT delivered — LAWBOR models no execution. Read this to coordinate a swarm: only bid on jobs in `ready`.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'lawbor_offer', description: 'LIST something for sale on the bazaar (the SUPPLY side, mirror of lawbor_post_job which is demand). A seller advertises a service / MCP tool / good at a price; a buyer BUYS it by paying — no bid/award handshake, the payment IS the deal (settled = PAID, proven on Base). An offer is a standing listing, so it can be bought MANY times by many buyers. Negotiate the actual price by MESSAGE (lawbor_say); `price` here is just a hint. `ref` is the opaque pointer (the MCP endpoint / repo / product link — LAWBOR never fetches or judges it). Input: to (a peer to advertise to), jobId (the listing id), item (what is for sale), price?, ref?, tags?, as? (human|bot).', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, item: { type: 'string' }, price: { type: 'string' }, ref: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, as: { type: 'string' } }, required: ['to', 'jobId', 'item'] } },
  { name: 'lawbor_bazaar', description: 'READ-ONLY: the open bazaar — everything listed for sale that this node can see, each annotated with the SELLER\'s trust FROM YOUR OWN POINT OF VIEW: what you (and your paid circle) have irrecoverably paid them, verified on Base. That conserved number is the one a collusion ring cannot farm; a raw purchase count is shown too but labelled NOT a trust signal (a seller can buy their own listing with sybils — it earns an outsider nothing). To buy: agree a price by lawbor_say, pay the seller in USDC on Base yourself, then lawbor_settle with the txHash against the offer jobId. Input: of? (a seller address to filter to).', inputSchema: { type: 'object', properties: { of: { type: 'string' } }, additionalProperties: false } },
  { name: 'lawbor_post_job', description: 'Post a job to a peer bot (help_wanted). You choose the jobId; use the same one in every copy you send. dependsOn (jobIds) makes it wait until those upstream jobs are awarded — the graph gate, so a job cannot be bid on before its prerequisites. Typical shape: a CODE BOUNTY — task = the fix/review/suggestion wanted, ref = the repo/issue/file link (opaque: LAWBOR never fetches or judges it). Input: to, jobId, task, ref?, tags?, budgetHint?, dependsOn?, as? (human|bot, default bot).', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, task: { type: 'string' }, ref: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, budgetHint: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, as: { type: 'string' } }, required: ['to', 'jobId', 'task'] } },
  { name: 'lawbor_bid', description: 'Answer a job with a price. One live bid per worker — bidding again REPLACES your previous bid. You cannot bid on your own job. Input: to (the requester), jobId, price, eta?, note?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, price: { type: 'string' }, eta: { type: 'string' }, note: { type: 'string' } }, required: ['to', 'jobId', 'price'] } },
  { name: 'lawbor_confirm', description: 'LOCK the negotiated price — the owner\'s signed "this is the deal, come pay". Only the job/offer OWNER may confirm, and only a price both sides already converged on via lawbor_quote (there must be an agreedPrice, and you cite its exact amountMicro). It is the offer-side analog of lawbor_award (a job gets an award; an offer never had one). The fold then sets agreedPrice.accepted=true — re-quoting to a different number un-locks it, because the confirm named the old one. Still negotiation only: it moves no funds and confers zero standing; the settle just warns, never blocks, if the paid amount differs. Input: to (the counterparty), jobId, amountMicro (the agreed number you are locking), as? (human|bot).', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, amountMicro: { type: 'string' }, as: { type: 'string' } }, required: ['to', 'jobId', 'amountMicro'] } },
  { name: 'lawbor_quote', description: 'HAGGLE a structured price on a job or offer — the machine-readable counter-offer that used to be freeform chat. amountMicro is USDC micro-units (integer, e.g. 5000000 = 5 USDC), so the peer\'s agent reads a NUMBER it can weigh against trust, not prose. EITHER side may quote (buyer or seller, requester or worker) and re-quoting REPLACES your live quote — that is how you counter. The fold DERIVES `agreedPrice` when the job owner and one counterparty hold matching live quotes: that is the deal both sides put on the wire. NEGOTIATION ONLY — like a bid it moves no funds and confers ZERO standing; only a real USDC settle counts. When you and the counterparty agree, pay on Base and lawbor_settle the agreed amount. Input: to (the other party), jobId (the job/offer id), amountMicro (integer string), note?, as? (human|bot).', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, amountMicro: { type: 'string' }, note: { type: 'string' }, as: { type: 'string' } }, required: ['to', 'jobId', 'amountMicro'] } },
  { name: 'lawbor_validate', description: 'THE PENNY-DROP: cite a DUST USDC transfer on Base (0.01 recommended) to prove the payment RAIL works before real money crosses it — the bank micro-deposit, on-chain. Use dust, NOT zero: a zero-value ERC-20 transfer is the signature of address-poisoning, so explorers hide it and wallets flag it — a proof of key must not be shaped like a known attack. The signature is what proves the key; the amount never was. Use it BEFORE settling a real amount. DIRECTION IS THE PROOF: a tx you send TO the worker proves only that your key works and the address accepts transfers; a tx signed BY the worker proves THEY control that address, which is the question that matters before you pay them. This is the cheapest defence against the one irreversible loss in the system: paying an address nobody controls. A validation NEVER becomes reputation — it is cheap by construction (gas, or nothing at all) and confers exactly zero standing. TWO WAYS TO PROVE THE SAME THING, and the free one is usually right: pass keyAddr + keySig — an off-chain signature over the exact string "LAWBOR-KEY:<lowercased addr>" — which needs NO gas and NO USDC, so a freshly-created agent wallet holding nothing can still prove it holds its key. It proves exactly as much as the transfer, because the signature was always the proof and the transfer was only its envelope. Use the on-chain txHash path instead when you need the fact timestamped publicly on Base, or when the address is a SMART-CONTRACT wallet (it holds no key and cannot sign a message at all). Input: to, jobId, and EITHER txHash OR (keyAddr + keySig).', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, txHash: { type: 'string' }, keyAddr: { type: 'string' }, keySig: { type: 'string' }, as: { type: 'string' } }, required: ['to', 'jobId'] } },
  { name: 'lawbor_wanted', description: 'READ-ONLY: the WANTED board — open, claimable jobs (reward posters), each annotated with THIS node\'s own verified payment history with the requester (paidUsMicro = what they have provably paid us on Base; 0 = no history, not a bad mark). Anyone — human or bot — may answer a poster with lawbor_bid; the reward settles directly in USDC between the two parties, LAWBOR holds nothing. Bots may also POST here: an autopilot with postWanted enabled advertises the missing prerequisites of its own blocked jobs.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'lawbor_settle', description: 'Bind an awarded job to a REAL USDC transfer on Base, by txHash. Only the requester or the awarded worker may settle, and only after an award. The claim becomes a verified settlement ONLY if the on-chain tx matches the signed award exactly (Base chainId 8453, USDC, payer = the requester who signed the award, payee = the awarded worker, exact amount, >=12 confirmations); otherwise it confers nothing. LAWBOR moves no funds — the two parties transfer directly and this records a pointer anyone can re-verify and refute. `settled` means PAID, never delivered. Input: to, jobId, txHash (0x, 32 bytes), amountMicro (USDC 6-decimals, integer string), deliverable? (the PR/commit paid for — an opaque, unverified pointer).', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, txHash: { type: 'string' }, amountMicro: { type: 'string' }, deliverable: { type: 'string' }, as: { type: 'string' } }, required: ['to', 'jobId', 'txHash', 'amountMicro'] } },
  { name: 'lawbor_credit', description: 'READ-ONLY: the rating between bots, as seen FROM THIS NODE ONLY. There is no global score and no leaderboard — standing is a conserved, debited quantity bounded by this node\'s own irrecoverable spend, which is what makes it unfarmable by a collusion ring (five rating designs were farmed by an adversary before this one; see RATING-DESIGN.md). Returns directUsdc (net USDC this node itself paid, under an award it signed, verified on Base) and circleUsdc (attenuated credit conferred by the addresses this node paid, out of a FINITE budget), plus the re-verifiable evidence rows. Cold start is total: a node that has paid nobody sees 0 for everyone. Input: of? (0x address to look up).', inputSchema: { type: 'object', properties: { of: { type: 'string' } }, additionalProperties: false } },
  { name: 'lawbor_award', description: 'Award your job to one bidder. Only the requester may award, and the award restates the agreed price — that is the requester\'s signed commitment. Settlement is NOT included: settlementRef is an opaque string LAWBOR never creates or checks. Input: to (the winner), jobId, worker, price, eta?, settlementRef?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, worker: { type: 'string' }, price: { type: 'string' }, eta: { type: 'string' }, settlementRef: { type: 'string' } }, required: ['to', 'jobId', 'worker', 'price'] } },
  { name: 'lawbor_peer', description: 'READ-ONLY: your WHOLE relationship with one counterparty in a single view — the "should I deal with this address?" read. Composes: `trust` (the same two lenses as lawbor_vet — local conserved history + MainStreet oracle, never merged); `jobs` (every negotiation you both took part in — as requester/worker or seller/buyer — with its state, agreedPrice, award and settled flag); and `threads` (your conversations with them). Where lawbor_vet answers "can I trust them?", lawbor_peer answers "what is everything between us, right now?" — so an agent can decide and act on one call. Advisory: it gates nothing. Input: of (0x address).', inputSchema: { type: 'object', properties: { of: { type: 'string' } }, required: ['of'], additionalProperties: false } },
  { name: 'lawbor_vet', description: 'READ-ONLY: vet one counterparty through BOTH trust lenses, kept separate on purpose. `oracle` = MainStreet\'s answer (seller decision/score from its x402 settlement index, plus its viewer-relative counterparty block when the oracle supports it) — REPORTED by a service this node does not control, so it is labeled, never merged into local standing. `local` = what THIS node itself verified on Base (directUsdcMicro = we provably paid them under a signed award; inboundUsdcMicro = they provably paid us). The two lenses answer different questions — "is this a legitimate endpoint?" vs "do WE have real settled history?" — and averaging them would launder the oracle\'s word into local proof, so no combined number exists. Advisory only: this read never gates anything (admission stays fail-closed elsewhere). Input: of (0x address).', inputSchema: { type: 'object', properties: { of: { type: 'string' } }, required: ['of'], additionalProperties: false } },
];

/** @param {object} msg JSON-RPC · @param {{node:object}} deps the running LAWBOR node (lib/node.js) */
async function dispatch(msg, deps = {}) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null;                 // notification — nothing to answer

  switch (method) {
    case 'initialize': return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
    case 'tools/list': return ok({ tools: TOOLS.concat(deps.apps ? deps.apps.mcpTools() : []) });
    case 'ping': return ok({});
    case 'tools/call': {
      const node = deps.node;
      if (!node) return err(-32603, 'no LAWBOR node injected');
      const name = params && params.name;
      const a = (params && params.arguments) || {};
      try {
        let payload;
        // app tools (extensibility) — name starts with app_. Premium apps 402 unless the operator's
        // node holds a subscription; here the caller is the node itself (see PLATFORM.md v1 limit).
        if (name && name.startsWith('app_') && deps.apps) {
          const r = await deps.apps.tool(name, a, { node, store: node.store, caller: node.self, now: Date.now() });
          if (r) return ok({ content: [{ type: 'text', text: r.isError ? (r.text || 'refused') : JSON.stringify(r.payload) }], isError: !!r.isError });
          return err(-32602, `unknown tool: ${name}`);
        }
        if (name === 'lawbor_whoami') {
          payload = { self: node.self, peers: node.peers(), minScore: node.relay.minScore, maxHops: node.relay.maxHops, oracle: 'MainStreet preflight (fail-closed)', note: 'descriptor-only: the operator signs every envelope' };
        } else if (name === 'lawbor_say') {
          const r = await node.say(a.to, a.body, { thread: a.thread });
          payload = { id: r.envelope.id, thread: r.envelope.thread, forwarded: r.forwarded, delivered: r.delivered, targets: r.targets || [], reason: r.reason || null, sign: r.sign };
        } else if (name === 'lawbor_bot_say') {
          const r = await node.botSay(a.to, a.body, { thread: a.thread });
          payload = { id: r.envelope.id, thread: r.envelope.thread, forwarded: r.forwarded, delivered: r.delivered, targets: r.targets || [], sign: r.sign };
        } else if (name === 'lawbor_inbox') {
          payload = { view: 'inbox', threads: node.store.inbox(node.self, a.limit || 50) };
        } else if (name === 'lawbor_watch') {
          payload = { view: 'bot-activity', threads: node.store.botActivity(node.self, a.limit || 50) };
        } else if (name === 'lawbor_thread') {
          if (!a.id) return ok({ content: [{ type: 'text', text: 'tool error: id required' }], isError: true });
          // A thread is the WHOLE conversation: freeform chat AND the structured negotiation. A raw
          // `quote`/`bid`/`offer` body is opaque JSON, and the DERIVED deal state (agreedPrice, award,
          // settled) lived only in lawbor_jobs — so an agent reading a thread could not see where the
          // haggle stood. Here each work message is parsed inline, and `jobs` carries the derived state
          // of every negotiation in this thread: one read shows chat + structured offers + the deal.
          const raw = node.store.thread(a.id);
          const messages = raw.map((m) => { const w = work.parseWork(m.body); return w ? { ...m, work: w, body: undefined } : m; });
          const jobs = [...work.foldThread(raw, { txFacts: deps.txFacts || null }).values()].map((j) => ({
            jobId: j.jobId, state: j.state, isOffer: !!j.isOffer, requester: j.requester,
            bids: (j.bids || []).length, quotes: (j.quotes || []).length,
            agreedPrice: j.agreedPrice || null, award: j.award || null, settled: !!j.settlement,
          }));
          payload = { thread: a.id, messages, jobs,
            note: 'work messages are parsed inline (message.work); `jobs` is the DERIVED negotiation state in this thread — agreedPrice, bids, award, settled. One read = the whole conversation.' };
        } else if (name === 'lawbor_requests') {
          payload = { view: 'requests', threads: node.store.requests(node.self, a.limit || 50), note: 'first contact — not yet in your inbox' };
        } else if (name === 'lawbor_block') {
          if (!a.addr) return ok({ content: [{ type: 'text', text: 'tool error: addr required' }], isError: true });
          payload = node.block(a.addr);
        } else if (name === 'lawbor_unblock') {
          if (!a.addr) return ok({ content: [{ type: 'text', text: 'tool error: addr required' }], isError: true });
          payload = node.unblock(a.addr);
        } else if (name === 'lawbor_accept') {
          if (!a.addr) return ok({ content: [{ type: 'text', text: 'tool error: addr required' }], isError: true });
          payload = node.accept(a.addr);
        } else if (name === 'lawbor_jobs') {
          // a blocked address is invisible in jobs too (posts and bids) — fold only non-blocked messages.
          const { blocked: jobBlocked } = node.store.control();
          const jobMsgs = node.store.all().filter((m) => !jobBlocked.has(String(m.from).toLowerCase()));
          if (typeof deps.resolveFacts === 'function') await deps.resolveFacts(jobMsgs);
          const jobs = [...work.foldThread(jobMsgs, { txFacts: deps.txFacts || null }).values()].sort((x, y) => y.at - x.at);
          payload = { jobs: a.state ? jobs.filter((j) => j.state === a.state) : jobs,
            note: 'nothing here holds, releases or enforces payment. A job is `settled` only when a Base USDC tx matching the signed award verifies on-chain — settled means PAID, never delivered.' };
        } else if (name === 'lawbor_graph') {
          // the agent-org dependency graph: nodes, edges, and the ready-to-claim frontier
          const { blocked: gBlocked } = node.store.control();
          const g = work.graphOf(node.store.all().filter((m) => !gBlocked.has(String(m.from).toLowerCase())));
          payload = { ...g, note: 'dependency = upstream AWARDED (a worker chosen), not delivered — no execution modelled' };
        } else if (name === 'lawbor_wanted') {
          const { blocked: wB } = node.store.control();
          const wMsgs = node.store.all().filter((m) => !wB.has(String(m.from).toLowerCase()));
          if (typeof deps.resolveFacts === 'function') await deps.resolveFacts(wMsgs);
          const wJobs = [...work.foldThread(wMsgs, { txFacts: deps.txFacts || null }).values()];
          const wc = creditFor(node.self, work.settlementsFrom(wMsgs, { txFacts: deps.txFacts || null }), { returnFlow: deps.returnFlow || null });
          payload = {
            wanted: wJobs.filter((j) => j.state === 'open' && j.ready).sort((x, y) => y.at - x.at).map((j) => ({
              jobId: j.jobId, task: j.task, ref: j.ref, tags: j.tags, budgetHint: j.budgetHint, requester: j.requester, bids: j.bids.length, thread: j.thread,
              trust: { paidUsMicro: String(wc.inbound.get(j.requester) || 0), wePaidThemMicro: String(wc.direct.get(j.requester) || 0) },
            })),
            note: 'reward posters — bid with lawbor_bid; USDC settles directly between the parties, LAWBOR holds nothing. trust = OUR verified history with the requester; 0 = no history, not a bad mark.',
          };
        } else if (name === 'lawbor_bazaar') {
          const { blocked: zB } = node.store.control();
          const zMsgs = node.store.all().filter((m) => !zB.has(String(m.from).toLowerCase()));
          if (typeof deps.resolveFacts === 'function') await deps.resolveFacts(zMsgs);
          const zJobs = [...work.foldThread(zMsgs, { txFacts: deps.txFacts || null }).values()].filter((j) => j.isOffer);
          const zc = creditFor(node.self, work.settlementsFrom(zMsgs, { txFacts: deps.txFacts || null }), { returnFlow: deps.returnFlow || null });
          const ofFilter = a.of ? String(a.of).toLowerCase() : null;
          const shown = zJobs.filter((j) => !ofFilter || j.requester === ofFilter).sort((x, y) => y.at - x.at);
          // ORACLE LENS on the board — the SAME two-lens composition as lawbor_vet,
          // per offer. Bounded: dedupe sellers, cap the lookups, per-call timeout, and
          // kept SEPARATE from the local number (averaging would launder "MainStreet
          // said" into "this node verified"). Suppress with arguments.oracle:false.
          const wantOracle = a.oracle !== false && typeof deps.preflight === 'function';
          const CAP = 25;
          const uniq = wantOracle ? [...new Set(shown.map((j) => j.requester))].slice(0, CAP) : [];
          const oracleBy = new Map(await Promise.all(uniq.map(async (s) => {
            try {
              const p = await Promise.race([deps.preflight(s), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
              return [s, { source: 'MainStreet preflight', decision: p.decision || null, score: p.score ?? null, counterparty: p.counterparty || null,
                disclosure: 'ORACLE-REPORTED: MainStreet\'s x402 settlement index; not verified by this node, does NOT enter local standing.' }];
            } catch (e) { return [s, { error: 'oracle unreachable: ' + (e && e.message), disclosure: 'advisory only — mesh admission elsewhere stays fail-closed' }]; }
          })));
          payload = {
            offers: shown.map((j) => ({
              jobId: j.jobId, item: j.item, price: j.price, ref: j.ref, tags: j.tags, seller: j.requester, thread: j.thread,
              // THE local trust number: what YOU have paid this seller, conserved and unfarmable. The raw
              // count is shown but explicitly NOT a trust signal (a seller can sybil-buy their own listing).
              trust: { youPaidSellerMicro: String(zc.direct.get(j.requester) || 0), verifiedPurchases_NOT_a_trust_signal: (j.purchases || []).filter((p) => p.verified).length },
              oracle: wantOracle ? (oracleBy.get(j.requester) || { note: 'not fetched — capped at ' + CAP + ' unique sellers' }) : { note: 'oracle lens off' },
            })),
            lenses: 'trust = what THIS node verified on-chain (conserved, unfarmable). oracle = MainStreet advisory (ORACLE-REPORTED, viewer-relative, never enters local standing). Separate, never merged.',
            note: 'buy: agree a price by lawbor_say, pay the seller in USDC on Base yourself, then lawbor_settle with the txHash against the offer jobId. Trust = what YOU paid this seller (conserved, unfarmable); the purchase count is NOT trust (a seller can buy their own listing).',
          };
        } else if (name === 'lawbor_peer') {
          // RELATIONSHIP VIEW: everything between me and one address in one read — the two trust lenses
          // (like lawbor_vet), the negotiations we BOTH took part in, and our conversations. So an agent
          // decides "should I deal with them, and where do we stand?" on a single call. Read-only.
          const lower = (x) => String(x || '').toLowerCase();
          const of = lower(a.of);
          if (!/^0x[a-f0-9]{40}$/.test(of)) return ok({ content: [{ type: 'text', text: 'of (0x address) required' }], isError: true });
          const self = lower(node.self);
          const { blocked: pBlocked } = node.store.control();
          const pMsgs = node.store.all().filter((m) => !pBlocked.has(lower(m.from)));
          if (typeof deps.resolveFacts === 'function') await deps.resolveFacts(pMsgs);
          const vc = creditFor(node.self, work.settlementsFrom(pMsgs, { txFacts: deps.txFacts || null }), { returnFlow: deps.returnFlow || null });
          let oracle;
          if (typeof deps.preflight === 'function') {
            try { const p = await Promise.race([deps.preflight(of), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
              oracle = { source: 'MainStreet preflight', decision: p.decision || null, score: p.score ?? null, counterparty: p.counterparty || null,
                disclosure: 'ORACLE-REPORTED: not verified by this node, does NOT enter local standing.' };
            } catch (e) { oracle = { error: 'oracle unreachable: ' + (e && e.message), disclosure: 'advisory only — admission stays fail-closed elsewhere' }; }
          } else oracle = { error: 'no preflight wired here' };
          const partiesOf = (j) => { const s = new Set([lower(j.requester)]); (j.bids || []).forEach((b) => s.add(lower(b.worker))); if (j.award) s.add(lower(j.award.worker)); (j.quotes || []).forEach((q) => s.add(lower(q.party))); (j.purchases || []).forEach((pu) => { s.add(lower(pu.buyer)); s.add(lower(pu.seller)); }); return s; };
          const jobs = [...work.foldThread(pMsgs, { txFacts: deps.txFacts || null }).values()].filter((j) => { const s = partiesOf(j); return s.has(self) && s.has(of); }).map((j) => ({
            jobId: j.jobId, isOffer: !!j.isOffer, state: j.state,
            role: lower(j.requester) === self ? (j.isOffer ? 'seller' : 'requester') : (j.isOffer ? 'buyer' : 'worker'),
            agreedPrice: j.agreedPrice || null, award: j.award ? { worker: j.award.worker, price: j.award.price } : null,
            settled: !!j.settlement, thread: j.thread,
          }));
          const byThread = new Map();
          for (const m of pMsgs) {
            if (lower(m.from) !== of && lower(m.to) !== of) continue;
            const t = byThread.get(m.thread) || { thread: m.thread, count: 0, last: null, lastAt: -1 };
            t.count++; const at = Number.isFinite(m.rxAt) ? m.rxAt : 0;
            if (at >= t.lastAt) { t.lastAt = at; const w = work.parseWork(m.body); t.last = w ? '[' + w.kind + (w.amountMicro ? ' ' + w.amountMicro : '') + ']' : String(m.body || '').slice(0, 80); }
            byThread.set(m.thread, t);
          }
          const threads = [...byThread.values()].sort((x, y) => y.lastAt - x.lastAt).map(({ lastAt, ...rest }) => rest);
          payload = {
            peer: of, viewer: self,
            trust: {
              local: { directUsdcMicro: String(vc.direct.get(of) || 0), inboundUsdcMicro: String(vc.inbound.get(of) || 0), circleUsdcMicro: String(vc.circle.get(of) || 0) },
              oracle,
              lenses: 'local = what WE settled on Base (conserved, unfarmable; 0 = no shared history, not a bad mark). oracle = MainStreet advisory, never merged in.',
            },
            jobs, threads,
            note: 'the whole relationship in one read: trust + every negotiation between you two + your conversations. Advisory, gates nothing.',
          };
        } else if (name === 'lawbor_vet') {
          // THE COMPOSITION VERB: LAWBOR stops being its own oracle and stacks the
          // lenses instead. Oracle word and local proof travel side by side, labeled —
          // never averaged, because a combined number would launder "MainStreet said"
          // into "this node verified".
          const of = String(a.of || '').toLowerCase();
          if (!/^0x[a-f0-9]{40}$/.test(of)) return ok({ content: [{ type: 'text', text: 'of (0x address) required' }], isError: true });
          let oracle;
          if (typeof deps.preflight === 'function') {
            try {
              const p = await deps.preflight(of);
              oracle = {
                source: 'MainStreet preflight', decision: p.decision || null, score: p.score ?? null,
                counterparty: p.counterparty || null,
                disclosure: 'ORACLE-REPORTED: MainStreet\'s x402 settlement index, a service this node\'s operator '
                  + 'may not control. Nothing here was verified by this node, and none of it enters local standing.',
              };
            } catch (e) {
              // A dead oracle degrades an ADVISORY read, so it discloses instead of throwing.
              // The admission gate elsewhere still fails closed — that property lives in the relay, not here.
              oracle = { error: 'oracle unreachable: ' + (e && e.message), disclosure: 'advisory read only — mesh admission elsewhere remains fail-closed' };
            }
          } else {
            oracle = { error: 'no preflight wired on this entrypoint', disclosure: 'advisory read only — mesh admission elsewhere remains fail-closed' };
          }
          const { blocked: vBlocked } = node.store.control();
          const vMsgs = node.store.all().filter((m) => !vBlocked.has(String(m.from).toLowerCase()));
          if (typeof deps.resolveFacts === 'function') await deps.resolveFacts(vMsgs);
          const vc = creditFor(node.self, work.settlementsFrom(vMsgs, { txFacts: deps.txFacts || null }), { returnFlow: deps.returnFlow || null });
          payload = {
            subject: of, viewer: node.self,
            oracle,
            local: {
              directUsdcMicro: String(vc.direct.get(of) || 0),
              inboundUsdcMicro: String(vc.inbound.get(of) || 0),
              circleUsdcMicro: String(vc.circle.get(of) || 0),
              disclosure: deps.txFacts
                ? 'LOCALLY VERIFIED: USDC settlements this node re-checked on Base field-for-field. A 0 is an absence of shared history, never a bad mark.'
                : 'no chain reader is wired here, so NO settlement can verify and every local number is 0 — this is not evidence of a bad counterparty',
            },
            note: 'two lenses, two questions: oracle = "legitimate endpoint?", local = "do WE have settled history?" They are kept separate by design — no combined score exists.',
          };
        } else if (name === 'lawbor_credit') {
          // The rating. txFacts/resolveFacts are injected by server.js; used standalone (bin/lawbor-mcp.js
          // with no chain reader) NOTHING verifies, so we return empty numbers and say exactly why rather
          // than letting a caller read 0 as "this worker has no history".
          const { blocked: cBlocked } = node.store.control();
          const msgs = node.store.all().filter((m) => !cBlocked.has(String(m.from).toLowerCase()));
          if (typeof deps.resolveFacts === 'function') await deps.resolveFacts(msgs);
          const edges = work.settlementsFrom(msgs, { txFacts: deps.txFacts || null });
          const c = creditFor(node.self, edges, { returnFlow: deps.returnFlow || null });
          const pick = (m) => String(m.get(String(a.of).toLowerCase()) || 0);
          const limits = c.limits.concat([
            'this is THIS node\'s view only — no global score exists, and two nodes will disagree by design',
            'cold start is total: a node that has paid nobody sees 0 for everyone, including honest workers',
            'settled means PAID, never delivered — no escrow, no dispute path, no adjudicator',
          ], deps.txFacts ? [] : ['no chain reader is wired here, so NO settlement can verify and every number is 0 — this is not evidence of a bad counterparty']);
          payload = a.of
            ? { viewer: node.self, of: String(a.of).toLowerCase(), directUsdcMicro: pick(c.direct), circleUsdcMicro: pick(c.circle),
                evidence: c.evidence.filter((e) => e.worker === String(a.of).toLowerCase()), netted: c.netted, limits }
            : { viewer: node.self,
                direct: [...c.direct.entries()].sort((x, y) => y[1] - x[1]).map(([addr, m]) => ({ addr, usdcMicro: String(m) })),
                circle: [...c.circle.entries()].sort((x, y) => y[1] - x[1]).map(([addr, m]) => ({ addr, usdcMicro: String(m) })),
                evidence: c.evidence, netted: c.netted, limits };
        } else if (name === 'lawbor_post_job' || name === 'lawbor_bid' || name === 'lawbor_award' || name === 'lawbor_settle' || name === 'lawbor_validate' || name === 'lawbor_offer' || name === 'lawbor_quote' || name === 'lawbor_confirm') {
          const kind = name === 'lawbor_post_job' ? 'help_wanted' : name === 'lawbor_bid' ? 'bid'
            : name === 'lawbor_settle' ? 'settle' : name === 'lawbor_validate' ? 'validate' : name === 'lawbor_offer' ? 'offer' : name === 'lawbor_quote' ? 'quote' : name === 'lawbor_confirm' ? 'confirm' : 'award';
          // Actor rules run BEFORE the envelope is built. Checking them only when rendering would
          // make them decorative — the same mistake as the ungated POST /peers side-door.
          const job = work.foldThread(node.store.all()).get(a.jobId);
          /* THE SAME OPTS THE HTTP ROUTE PASSES. This call used to pass NONE, so every option-driven rule
           * silently did not exist on the MCP side: requireProofAbove (refuse to award above N to an
           * address that has never proven its key) was enforced for a human on /work and skipped for an
           * agent on /mcp. Two front doors, one gate, and only one door checked it — with the unchecked
           * door being the one aimed at autonomous agents. */
          const proven = deps.provenAddrs ? deps.provenAddrs() : undefined;
          const may = work.mayApply(job, kind, node.self, {
            requireProofAbove: deps.requireProofAbove, proven,
            worker: a.worker, price: a.price, keySig: a.keySig, keyAddr: a.keyAddr,
          });
          if (!may.ok) return ok({ content: [{ type: 'text', text: 'refused: ' + may.reason }], isError: true });
          const wbody = work.buildWork(kind, a);
          // A REPLY CONTINUES THE CONVERSATION. help_wanted/offer CREATE the job (job is null here, so a
          // fresh thread is rooted); a bid/quote/award/settle/validate on an existing job inherits that
          // job's thread, so the whole negotiation — post, haggle, award, settle — lives in ONE thread a
          // reader can follow. The fold already stamps job.thread from the announcing message.
          const wthread = job ? job.thread : undefined;
          const r = a.as === 'human' ? await node.say(a.to, wbody, { thread: wthread }) : await node.botSay(a.to, wbody, { thread: wthread });
          // Same emitter-side warning as HTTP /work, via the shared helper so the two doors cannot drift:
          // posting a dependsOn on an upstream this node has never seen is a retention case, surfaced not
          // hidden. An autopilot reading this can choose to send the upstream too.
          const unsent = kind === 'help_wanted' ? work.unsentDepsTo(node.store.all(), a.dependsOn, node.self, a.to) : [];
          payload = { id: r.envelope.id, thread: r.envelope.thread, forwarded: r.forwarded, delivered: r.delivered, targets: r.targets || [], reason: r.reason || null, sign: r.sign,
            ...(unsent.length ? { warnings: ['dependsOn ' + unsent.join(', ') + ' not sent to this peer — they will fold this job blockedByUnknown until those upstreams reach them.'] } : {}) };
          // Negotiation feedback: after a quote, show whether the two sides now AGREE; after a settle,
          // WARN (never block) if the paid amount differs from the price the two sides converged on.
          if (kind === 'quote' || kind === 'confirm' || kind === 'settle') {
            const jb = work.foldThread(node.store.all()).get(a.jobId);
            if (kind === 'quote' || kind === 'confirm') payload.agreedPrice = (jb && jb.agreedPrice) || null;
            if (kind === 'settle' && jb && jb.agreedPrice && String(jb.agreedPrice.amountMicro) !== String(a.amountMicro)) {
              payload.warnings = (payload.warnings || []).concat('settle amountMicro ' + a.amountMicro + ' ≠ ' + (jb.agreedPrice.accepted ? 'the LOCKED agreedPrice ' : 'agreedPrice ') + jb.agreedPrice.amountMicro + ' — advisory only, the settle is not blocked.');
            }
          }
        } else return err(-32602, `unknown tool: ${name}`);
        return ok({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
      } catch (e) { return ok({ content: [{ type: 'text', text: `tool error: ${e.message}` }], isError: true }); }
    }
    default: return err(-32601, `method not found: ${method}`);
  }
}

module.exports = { dispatch, TOOLS, PROTOCOL, SERVER };
