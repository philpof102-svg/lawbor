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
  { name: 'lawbor_post_job', description: 'Post a job to a peer bot (help_wanted). You choose the jobId; use the same one in every copy you send. Input: to, jobId, task, tags?, budgetHint?, as? (human|bot, default bot).', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, task: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, budgetHint: { type: 'string' }, as: { type: 'string' } }, required: ['to', 'jobId', 'task'] } },
  { name: 'lawbor_bid', description: 'Answer a job with a price. One live bid per worker — bidding again REPLACES your previous bid. You cannot bid on your own job. Input: to (the requester), jobId, price, eta?, note?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, price: { type: 'string' }, eta: { type: 'string' }, note: { type: 'string' } }, required: ['to', 'jobId', 'price'] } },
  { name: 'lawbor_award', description: 'Award your job to one bidder. Only the requester may award, and the award restates the agreed price — that is the requester\'s signed commitment. Settlement is NOT included: settlementRef is an opaque string LAWBOR never creates or checks. Input: to (the winner), jobId, worker, price, eta?, settlementRef?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, jobId: { type: 'string' }, worker: { type: 'string' }, price: { type: 'string' }, eta: { type: 'string' }, settlementRef: { type: 'string' } }, required: ['to', 'jobId', 'worker', 'price'] } },
];

/** @param {object} msg JSON-RPC · @param {{node:object}} deps the running LAWBOR node (lib/node.js) */
async function dispatch(msg, deps = {}) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null;                 // notification — nothing to answer

  switch (method) {
    case 'initialize': return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
    case 'tools/list': return ok({ tools: TOOLS });
    case 'ping': return ok({});
    case 'tools/call': {
      const node = deps.node;
      if (!node) return err(-32603, 'no LAWBOR node injected');
      const name = params && params.name;
      const a = (params && params.arguments) || {};
      try {
        let payload;
        if (name === 'lawbor_whoami') {
          payload = { self: node.self, peers: node.peers(), minScore: node.relay.minScore, maxHops: node.relay.maxHops, oracle: 'MainStreet preflight (fail-closed)', note: 'descriptor-only: the operator signs every envelope' };
        } else if (name === 'lawbor_say') {
          const r = await node.say(a.to, a.body, { thread: a.thread });
          payload = { id: r.envelope.id, thread: r.envelope.thread, delivered: r.delivered, reason: r.reason || null, sign: r.sign };
        } else if (name === 'lawbor_bot_say') {
          const r = await node.botSay(a.to, a.body, { thread: a.thread });
          payload = { id: r.envelope.id, thread: r.envelope.thread, delivered: r.delivered, sign: r.sign };
        } else if (name === 'lawbor_inbox') {
          payload = { view: 'inbox', threads: node.store.inbox(node.self, a.limit || 50) };
        } else if (name === 'lawbor_watch') {
          payload = { view: 'bot-activity', threads: node.store.botActivity(node.self, a.limit || 50) };
        } else if (name === 'lawbor_thread') {
          if (!a.id) return ok({ content: [{ type: 'text', text: 'tool error: id required' }], isError: true });
          payload = { thread: a.id, messages: node.store.thread(a.id) };
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
          const jobs = work.jobsFrom(node.store.all().filter((m) => !jobBlocked.has(String(m.from).toLowerCase())));
          payload = { jobs: a.state ? jobs.filter((j) => j.state === a.state) : jobs,
            note: 'negotiation only — nothing here holds, releases or enforces payment' };
        } else if (name === 'lawbor_post_job' || name === 'lawbor_bid' || name === 'lawbor_award') {
          const kind = name === 'lawbor_post_job' ? 'help_wanted' : name === 'lawbor_bid' ? 'bid' : 'award';
          // Actor rules run BEFORE the envelope is built. Checking them only when rendering would
          // make them decorative — the same mistake as the ungated POST /peers side-door.
          const job = work.foldThread(node.store.all()).get(a.jobId);
          const may = work.mayApply(job, kind, node.self);
          if (!may.ok) return ok({ content: [{ type: 'text', text: 'refused: ' + may.reason }], isError: true });
          const wbody = work.buildWork(kind, a);
          const r = a.as === 'human' ? await node.say(a.to, wbody, {}) : await node.botSay(a.to, wbody, {});
          payload = { id: r.envelope.id, thread: r.envelope.thread, delivered: r.delivered, reason: r.reason || null, sign: r.sign };
        } else return err(-32602, `unknown tool: ${name}`);
        return ok({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
      } catch (e) { return ok({ content: [{ type: 'text', text: `tool error: ${e.message}` }], isError: true }); }
    }
    default: return err(-32601, `method not found: ${method}`);
  }
}

module.exports = { dispatch, TOOLS, PROTOCOL, SERVER };
