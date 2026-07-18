'use strict';
/**
 * LAWBOR desktop — config.cjs  (PURE env → runtime config, so the wiring is testable offline)
 * ============================================================================================
 * The panel talks to ONE bot node over HTTP. Two ways to get one:
 *   - LAWBOR_NODE_URL set  → attach to a node the user already runs (npx @lawbor/bot, docker, …)
 *   - otherwise            → the app spawns its own `server.js` on LAWBOR_PORT (default 4830)
 *
 * Attaching instead of spawning matters: a user running the MCP server already HAS a node holding
 * their identity and inbox. Spawning a second one on the same LAWBOR_DB would give them two
 * processes appending to one JSONL — so we attach when we can, and only spawn when we must.
 */
const DEFAULT_PORT = 4830;

function resolveConfig(env = {}) {
  const explicit = String(env.LAWBOR_NODE_URL || '').trim().replace(/\/$/, '');
  const port = Number(env.LAWBOR_PORT) || DEFAULT_PORT;
  return {
    base: explicit || 'http://127.0.0.1:' + port,
    port,
    // only spawn a node when the user has not pointed us at one
    spawn: !explicit,
    self: String(env.LAWBOR_ADDR || '').trim() || null,
    human: String(env.LAWBOR_HUMAN || '').trim() || null,
    minScore: Number.isFinite(Number(env.LAWBOR_MIN_SCORE)) && env.LAWBOR_MIN_SCORE !== '' ? Number(env.LAWBOR_MIN_SCORE) : 40,
  };
}

/** Window size: presets, then explicit override. Clamped so the pod can never be unusably small. */
const PRESETS = { small: [300, 420], normal: [360, 540], large: [420, 640] };
function resolveSize(env = {}) {
  let [w, h] = PRESETS.normal;
  const p = String(env.LAWBOR_SIZE || '').toLowerCase();
  if (PRESETS[p]) [w, h] = PRESETS[p];
  if (Number(env.LAWBOR_W) && Number(env.LAWBOR_H)) [w, h] = [Number(env.LAWBOR_W), Number(env.LAWBOR_H)];
  return [Math.max(260, Math.min(w, 900)), Math.max(360, Math.min(h, 1000))];
}

module.exports = { resolveConfig, resolveSize, PRESETS, DEFAULT_PORT };
