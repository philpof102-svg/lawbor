#!/usr/bin/env node
'use strict';
/**
 * LAWBOR signed-node launcher — an originating node whose PROCESS never holds the key.
 * ================================================================================================
 * One Railway service, TWO processes:
 *   - a child running examples/signer-endpoint.js, bound to 127.0.0.1 only, holding LAWBOR_SIGNER_KEY;
 *   - the node (server.js), which connects to that child over loopback and is given NO key at all.
 * The key lives in the endpoint child's memory. The node child's env has it stripped, so the promise
 * "the node holds no key" is kept even though both run on one box.
 *
 * This is the deployable shape of posture A (a public node that ORIGINATES with a throwaway identity).
 * Co-location means a HOST compromise takes both — accepted here precisely because the identity is
 * throwaway: a compromise costs a reputation rebuild, never money. For a fund-holding identity you would
 * NOT co-locate, and you would NOT hold the key in process at all (KMS/CDP) — see signer-endpoint.js.
 *
 *   REQUIRED:  LAWBOR_SIGNER_KEY=0x<throwaway 32-byte key>   LAWBOR_ADDR=0x<its address>
 *   USUAL:     PORT (node, public)   LAWBOR_MIN_SCORE   MAINSTREET_URL   LAWBOR_ADMIT=probation …
 *   Start it as the service command:  node bin/lawbor-signed-node.js
 *
 * The endpoint is loopback-only and bearer-gated with a per-boot random secret the node is handed
 * directly — it is never reachable from outside this service, so the key is never one network hop away.
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');

const KEY = process.env.LAWBOR_SIGNER_KEY;
const ROOT = path.join(__dirname, '..');
const SIGNER_PORT = 8787;                          // loopback only; never bound to a public interface

/* The node's environment, derived from the parent's — a PURE function so the one invariant that matters
 * can be tested without spawning anything: the node MUST NEVER see the key. If this ever stops deleting
 * LAWBOR_SIGNER_KEY, "the node holds no key" quietly becomes false and nothing else would notice — which
 * is exactly the class of silent drift this project keeps finding. */
function nodeEnvFrom(parentEnv, token, port) {
  const e = { ...parentEnv };
  delete e.LAWBOR_SIGNER_KEY;                        // THE NODE MUST NEVER SEE THE KEY. This is the point.
  e.LAWBOR_SIGNER = './examples/signer-remote.js';
  e.LAWBOR_SIGNER_URL = 'http://127.0.0.1:' + port + '/sign';
  e.LAWBOR_SIGNER_TOKEN = token;
  return e;
}

function main() {
  if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
    console.error('lawbor-signed-node: LAWBOR_SIGNER_KEY must be a 0x 32-byte throwaway key. Refusing to start.');
    process.exit(1);
  }
  if (!process.env.LAWBOR_ADDR) {
    console.error('lawbor-signed-node: set LAWBOR_ADDR to the address of that key (peers verify signer === from).');
    process.exit(1);
  }
  const TOKEN = crypto.randomBytes(24).toString('hex');   // per-boot secret, handed to the node directly

  // 1. the endpoint child: it ALONE gets the key.
  const endpoint = spawn(process.execPath, [path.join(ROOT, 'examples', 'signer-endpoint.js')], {
    env: { ...process.env, LAWBOR_SIGNER_PORT: String(SIGNER_PORT), LAWBOR_SIGNER_TOKEN: TOKEN, LAWBOR_SIGNER_ADDR: process.env.LAWBOR_ADDR },
    stdio: 'inherit',
  });
  endpoint.on('exit', (code) => { console.error('lawbor-signed-node: signer endpoint exited (' + code + ') — bringing the node down too, a node that cannot sign must not pretend to run.'); process.exit(code || 1); });

  const startNode = () => {
    const node = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: nodeEnvFrom(process.env, TOKEN, SIGNER_PORT), stdio: 'inherit' });
    node.on('exit', (code) => { endpoint.kill(); process.exit(code || 0); });
    console.log('lawbor-signed-node: node starting, signer isolated on 127.0.0.1:' + SIGNER_PORT + ' (key held ONLY by the endpoint child)');
  };

  // 2. wait for the endpoint to answer, then start the node with the key STRIPPED.
  const waitReady = (attempt = 0) => {
    const req = http.request({ host: '127.0.0.1', port: SIGNER_PORT, path: '/sign', method: 'POST', timeout: 1000 }, (res) => { res.resume(); startNode(); });
    req.on('error', () => { if (attempt > 50) { console.error('lawbor-signed-node: signer endpoint never came up'); process.exit(1); } setTimeout(() => waitReady(attempt + 1), 200); });
    req.on('timeout', () => { req.destroy(); if (attempt > 50) process.exit(1); setTimeout(() => waitReady(attempt + 1), 200); });
    req.end('{}');   // an empty body reaches the policy gate and is refused — but it proves the port answers
  };

  process.on('SIGTERM', () => { endpoint.kill(); process.exit(0); });
  process.on('SIGINT', () => { endpoint.kill(); process.exit(0); });
  waitReady();
}

module.exports = { nodeEnvFrom };
if (require.main === module) main();
