#!/usr/bin/env node
'use strict';
/**
 * LAWBOR — stdio MCP entry point (the classic distribution: `claude mcp add lawbor`)
 * ===================================================================================
 * LAWBOR is DECENTRALIZED: every person runs their own bot, with their own address, peers and inbox.
 * So the distribution is a PACKAGE you run locally (stdio MCP), not one hosted endpoint everybody shares —
 * a single remote node would re-centralize the network it exists to decentralize.
 *
 * Usage (any MCP client — openclaude, Claude Code, …):
 *   claude mcp add lawbor -- npx -y -p lawbor-bot lawbor-mcp
 * Env:
 *   LAWBOR_ADDR       your bot's 0x address (required to send; read-only tools work without it)
 *   LAWBOR_HUMAN      your handle, travels as `viaHuman` provenance (optional)
 *   LAWBOR_MIN_SCORE  reputation floor for accepting peer traffic (default 40)
 *   LAWBOR_DB         where this node stores its conversations (default ./data/messages.jsonl)
 *   MAINSTREET_URL    reputation oracle base url (default the public MainStreet)
 *   LAWBOR_PEERS      comma-separated addr=url pairs to start with
 *
 * 🛑 This process never holds a key, never signs, never moves funds. lawbor_say returns an EIP-712
 *   descriptor with signed:false; your wallet/operator signs it. Inbound peer traffic is reputation-gated.
 */
const readline = require('readline');
const { dispatch } = require('../mcp');
const { createNode } = require('../lib/node');
const { createStore } = require('../lib/store');

const SELF = process.env.LAWBOR_ADDR || '0x0000000000000000000000000000000000000000';
const MAINSTREET_URL = (process.env.MAINSTREET_URL || 'https://avisradar-production.up.railway.app').replace(/\/$/, '');
const MIN_SCORE = Number(process.env.LAWBOR_MIN_SCORE || 40);

// peer routing table from env: "0xabc...=https://bot-a.example,0xdef...=https://bot-b.example"
const peerUrls = new Map();
(process.env.LAWBOR_PEERS || '').split(',').map((p) => p.trim()).filter(Boolean).forEach((pair) => {
  const [addr, url] = pair.split('=');
  if (addr && url) peerUrls.set(addr.trim().toLowerCase(), url.trim());
});

async function preflight(addr) {
  const r = await fetch(MAINSTREET_URL + '/api/agent/preflight/' + encodeURIComponent(addr));
  if (!r.ok) throw new Error('preflight HTTP ' + r.status);
  return r.json();
}

// transport: POST the envelope to the peer's /lawbor/accept. Unknown peer → no-op (dedup makes resend safe).
async function send(toAddr, env) {
  const url = peerUrls.get(String(toAddr).toLowerCase());
  if (!url) return;
  try {
    await fetch(url.replace(/\/$/, '') + '/lawbor/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: env }),
    });
  } catch { /* transport retriable */ }
}

const node = createNode({
  self: SELF, human: process.env.LAWBOR_HUMAN || null,
  preflight, minScore: MIN_SCORE, send,
  peers: [...peerUrls.keys()],
  store: createStore(process.env.LAWBOR_DB),
});

// ── stdio JSON-RPC loop (one JSON message per line) ────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch {
    return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
  }
  try {
    const res = await dispatch(msg, { node });
    if (res) process.stdout.write(JSON.stringify(res) + '\n');   // notifications answer null → stay silent
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32603, message: e.message } }) + '\n');
  }
});

process.stderr.write(`lawbor mcp (stdio) — self ${SELF} · peers ${peerUrls.size} · min score ${MIN_SCORE} · descriptor-only\n`);
