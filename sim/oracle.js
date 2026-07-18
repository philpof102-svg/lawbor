'use strict';
/**
 * LAWBOR test oracle — a PERMISSIVE reputation stub for local / LAN testing ONLY.
 * ================================================================================
 * A real node gates every peer and every sender against MainStreet. To test the mesh / consent / job
 * MECHANICS between two machines you would otherwise need addresses that already carry a real
 * MainStreet score ≥ the floor. This stub stands in: it answers /api/agent/preflight/<addr> with
 * PROCEED + score 80 for ANY address, so your test addresses pass and you can exercise the network.
 *
 * ⚠️  NEVER point a production node at this — it vouches for everyone, which is the exact opposite of
 *    the reputation gate's job. It exists only so a two-machine test does not need real scores.
 *
 * Run:  PORT=4899 node sim/oracle.js       then on each node:  MAINSTREET_URL=http://<oracle-ip>:4899
 */
const http = require('http');
const PORT = Number(process.env.PORT || 4899);
const SCORE = Number(process.env.ORACLE_SCORE || 80);

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ decision: 'PROCEED', score: SCORE, note: 'TEST STUB — permissive, do not use in production' }));
}).listen(PORT, '0.0.0.0', () => {
  console.log('LAWBOR test oracle (PERMISSIVE) on :' + PORT + ' — every address scores ' + SCORE + '. TEST ONLY.');
});
