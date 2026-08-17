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
/* ⛔ UNE FAUTE DE FRAPPE DANS LE PLANCHER L'AFFAIBLISSAIT EN SILENCE, ET LA BANNIERE NE NOMMAIT
 * AUCUN NOMBRE. `Number('8O' )` (la lettre O au lieu du zero) vaut NaN. Le relais est correctement
 * defendu — `Number.isFinite(cfg.minScore) ? cfg.minScore : 40` (lib/relay.js:40) — donc il retombe
 * a 40 et la comparaison `>= minScore` echoue FERMEE: aucun trou de securite. Mais l'operateur qui
 * VOULAIT 80 obtient 40, c'est-a-dire un plancher PLUS FAIBLE que son intention, et personne ne le
 * lui dit: la banniere de demarrage imprimait `min score NaN`.
 *
 * Mesure du 2026-08-16, quatre valeurs d'environnement:
 *   absent -> banniere 40, plancher 40      "80" -> 80, 80
 *   "8O"   -> banniere NaN, plancher 40     "abc" -> NaN, 40
 * (Et `LAWBOR_MIN_SCORE=0` marche: "0" est une chaine NON VIDE, donc `||` ne la remplace pas —
 * verifie, parce que c'est le seul moyen d'accepter tout le monde deliberement.)
 *
 * La decision etait juste, la DIVULGATION manquait. Ici on juge la valeur AU SOURCE, ou vit
 * l'intention de l'operateur, et on DIT ce qui a ete retenu. Le clamp du relais reste — defense en
 * profondeur, jamais remplacee par celle-ci. */
const PLANCHER_DEFAUT = 40;
const minScoreBrut = process.env.LAWBOR_MIN_SCORE;
const minScoreLu = (minScoreBrut === undefined || minScoreBrut === '') ? PLANCHER_DEFAUT : Number(minScoreBrut);
const minScoreIllisible = !Number.isFinite(minScoreLu);
const MIN_SCORE = minScoreIllisible ? PLANCHER_DEFAUT : minScoreLu;
if (minScoreIllisible) {
  process.stderr.write('lawbor mcp: ⚠️ LAWBOR_MIN_SCORE=' + JSON.stringify(String(minScoreBrut)).slice(0, 40)
    + ' n est pas un nombre lisible — plancher de reputation ramene a ' + PLANCHER_DEFAUT
    + '. Si vous vouliez un plancher PLUS STRICT, il n est PAS applique.\n');
}

// peer routing table from env: "0xabc...=https://bot-a.example,0xdef...=https://bot-b.example"
const peerUrls = new Map();
(process.env.LAWBOR_PEERS || '').split(',').map((p) => p.trim()).filter(Boolean).forEach((pair) => {
  const [addr, url] = pair.split('=');
  if (addr && url) peerUrls.set(addr.trim().toLowerCase(), url.trim());
});

async function preflight(addr) {
  // ?viewer=self: the oracle also returns its viewer-relative conservation block
  // (used by lawbor_vet). decision/score are unchanged — the gate reads the same.
  const viewer = SELF !== '0x0000000000000000000000000000000000000000' ? '?viewer=' + SELF : '';
  const r = await fetch(MAINSTREET_URL + '/api/agent/preflight/' + encodeURIComponent(addr) + viewer);
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
    const res = await dispatch(msg, { node, preflight });
    if (res) process.stdout.write(JSON.stringify(res) + '\n');   // notifications answer null → stay silent
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32603, message: e.message } }) + '\n');
  }
});

process.stderr.write(`lawbor mcp (stdio) — self ${SELF} · peers ${peerUrls.size} · min score ${MIN_SCORE} · descriptor-only\n`);
