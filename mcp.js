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
 *
 * 🛑 No tool signs, sends funds, or bypasses the gate. lawbor_say/bot_say return `sign.signed:false` —
 *   the bot-operator's key signs. Inbound peer traffic is reputation-gated by the relay (fail-closed).
 *   The node is INJECTED (deps.node) so this file is transport/network-free and testable offline.
 */
const PROTOCOL = '2024-11-05';
const SERVER = { name: 'lawbor', version: '0.1.0' };

const TOOLS = [
  { name: 'lawbor_whoami', description: 'READ-ONLY: this bot\'s identity — address, known peers, reputation floor. Start here to learn how to reach the mesh.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'lawbor_say', description: 'The HUMAN speaks through their bot: builds a signable envelope and relays it to the peer bot. Returns the EIP-712 descriptor (signed:false — the operator signs). Input: to (0x bot address), body, thread?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, thread: { type: 'string' } }, required: ['to', 'body'] } },
  { name: 'lawbor_bot_say', description: 'The BOT speaks autonomously (agent-to-agent). Lands in the recipient human\'s "watch my bot" feed, never their inbox. Input: to, body, thread?.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, thread: { type: 'string' } }, required: ['to', 'body'] } },
  { name: 'lawbor_inbox', description: 'READ-ONLY VIEW 1: the human\'s conversations (messages a person authored, either side). Input: limit?.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'lawbor_watch', description: 'READ-ONLY VIEW 2: what this bot is autonomously discussing with other bots — the transparency feed. Input: limit?.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'lawbor_thread', description: 'READ-ONLY: the full message list of one thread. Input: id (thread id).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
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
        } else return err(-32602, `unknown tool: ${name}`);
        return ok({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
      } catch (e) { return ok({ content: [{ type: 'text', text: `tool error: ${e.message}` }], isError: true }); }
    }
    default: return err(-32601, `method not found: ${method}`);
  }
}

module.exports = { dispatch, TOOLS, PROTOCOL, SERVER };
