'use strict';
/* Demo launcher for the orggraph app: seeds a small graph that exercises every state and serves a
 * standalone node on :4830. Open http://localhost:4830/app/orggraph/ to see the live graph.
 * Run: node demo-orggraph.cjs   (writes an isolated scratch store, never the default one). */
const path = require('path'), fs = require('fs');
const DB = path.join(__dirname, 'data', 'demo-orggraph.jsonl');
process.env.LAWBOR_DB = DB;
process.env.LAWBOR_CONTROL = DB + '.control';
process.env.LAWBOR_BEAT = '0';
process.env.LAWBOR_ALLOW_UNAUTHENTICATED = '1';
fs.mkdirSync(path.dirname(DB), { recursive: true });
for (const f of [DB, DB + '.control', DB + '.subs']) { try { fs.unlinkSync(f); } catch {} }

const { createStore } = require('./lib/store');
const { buildWork } = require('./lib/work');
const store = createStore();
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), D = '0x' + 'd'.repeat(40);
let rx = 1000, id = 0;
const post = (from, to, kind, f) => store.record({ id: '0x' + String(++id).padStart(4, '0'), thread: 't-' + f.jobId, from, to, body: buildWork(kind, f), ts: 1 }, { origin: 'bot', dir: 'out', rxAt: rx += 10 });
// a graph with every state visible at once: build(awarded) → verify(awarded) → deploy(cancelled),
// then the rewritten fix path hotfix(ready) → deploy2(blocked)
post(A, B, 'help_wanted', { jobId: 'build', task: 'build the feature' });
post(B, A, 'bid', { jobId: 'build', price: '10' });
post(A, B, 'award', { jobId: 'build', worker: B, price: '10' });
post(A, C, 'help_wanted', { jobId: 'verify', task: 'verify the build', dependsOn: ['build'] });
post(C, A, 'bid', { jobId: 'verify', price: '8' });
post(A, C, 'award', { jobId: 'verify', worker: C, price: '8' });
post(A, D, 'help_wanted', { jobId: 'deploy', task: 'ship it', dependsOn: ['verify'] });
post(A, D, 'cancel', { jobId: 'deploy', reason: 'verify failed' });
post(A, B, 'help_wanted', { jobId: 'hotfix', task: 'fix the null deref', dependsOn: ['build'] });
post(A, D, 'help_wanted', { jobId: 'deploy2', task: 'ship the fixed build', dependsOn: ['hotfix'] });

const { build } = require('./server');
const { server } = build({ apps: [require('./apps/orggraph'), require('./apps/standup'), require('./apps/tictactoe')], allowUnauthenticated: true });
server.listen(4830, () => console.log('demo on http://localhost:4830/app/orggraph/ · /app/standup/ · POST /app/tictactoe/move'));
