'use strict';
// LAWBOR apps + x402 paywall — the extensibility layer and the premium subscription, offline.
// Run: node test/apps.test.js
const assert = require('node:assert');
/* unique par CONSTRUCTION: un pid n est pas un id de run (Windows les recycle), et un nom
 * reutilise fait heriter le store du run precedent. Voir test/consent.test.js pour l enquete. */
const LAWBOR_TMP = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lawbor-t-"));
const fs = require('node:fs');
const path = require('node:path');
const { createApps } = require('../lib/apps');
const { createPaywall, USDC_BASE } = require('../lib/paywall');

let pass = 0, fail = 0;
const t = (n, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + n); }, (e) => { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); });

const WALLET = '0x' + '99'.repeat(20), PAYER = '0x' + 'b1'.repeat(20), OTHER = '0x' + 'cc'.repeat(20);
const nodeStub = { self: '0x' + 'a1'.repeat(20) };

// in-memory subscription ledger for tests
function memSubs() { const m = new Map(); return { record: (p, u) => m.set(p.toLowerCase(), u), until: (p) => m.get(p.toLowerCase()) || 0 }; }
const freeApp = { name: 'hello', description: 'free', routes: [{ method: 'GET', path: '/', handle: () => ({ body: { ok: true } }) }], tools: [{ name: 'ping', description: 'p', handle: () => ({ ok: true }) }] };
const premApp = { name: 'vault', description: 'premium', premium: true, routes: [{ method: 'GET', path: '/x', handle: () => ({ body: { secret: 42 } }) }], tools: [{ name: 'read', description: 'r', handle: () => ({ secret: 42 }) }] };

(async () => {
  console.log('LAWBOR apps + x402 paywall:');

  // ---- createApps validation + free dispatch --------------------------------------------------
  await t('createApps rejects a bad app name and a duplicate', () => {
    assert.throws(() => createApps([{ name: 'Bad Name', routes: [] }]), /kebab-case/);
    assert.throws(() => createApps([freeApp, freeApp]), /duplicate app/);
  });

  await t('a free app serves its route + tool, namespaced under /app/<name> and app_<name>_<tool>', async () => {
    const apps = createApps([freeApp]);
    const r = await apps.http('GET', '/app/hello/', {});
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
    const tools = apps.mcpTools().map((x) => x.name);
    assert.ok(tools.includes('app_hello_ping'));
    const tr = await apps.tool('app_hello_ping', {}, { node: nodeStub });
    assert.equal(tr.isError, false); assert.deepEqual(tr.payload, { ok: true });
    assert.equal(await apps.http('GET', '/app/nope/x', {}), null, 'an unowned path returns null so the core 404s');
  });

  // ---- premium gating -------------------------------------------------------------------------
  await t('FAIL CLOSED: a premium app with no paywall is refused, never served free', async () => {
    const apps = createApps([premApp]);                    // no paywall injected
    const r = await apps.http('GET', '/app/vault/x', {});
    assert.equal(r.status, 503);
    assert.match(r.body.error, /fail closed/i);
  });

  await t('a premium app with an unpaid caller returns the x402 402 challenge', async () => {
    let now = 1_000_000;
    const paywall = createPaywall({ payTo: WALLET, price: '5', subs: memSubs(), clock: () => now, verify: async (p) => ({ ok: true, payer: p.payer, amountUsdc: 5 }) });
    const apps = createApps([premApp], { paywall });
    const r = await apps.http('GET', '/app/vault/x', { caller: PAYER });
    assert.equal(r.status, 402);
    assert.ok(r.headers['payment-required'], 'the x402 header is present');
    assert.equal(r.body.accepts[0].payTo, WALLET, 'payment goes to the operator wallet, not LAWBOR');
    assert.equal(r.body.accepts[0].asset, USDC_BASE);
    assert.equal(r.body.accepts[0].maxAmountRequired, '5000000', '5 USDC in 6-decimal micro units');
  });

  await t('after settling a verified 5-USDC payment, the payer (and only the payer) is served', async () => {
    let now = 1_000_000;
    const subs = memSubs();
    const paywall = createPaywall({ payTo: WALLET, price: '5', periodDays: 30, subs, clock: () => now, verify: async (p) => ({ ok: true, payer: p.payer, amountUsdc: 5 }) });
    const apps = createApps([premApp], { paywall });
    const s = await paywall.settle({ payer: PAYER });
    assert.equal(s.ok, true); assert.equal(s.payer, PAYER.toLowerCase());
    assert.equal((await apps.http('GET', '/app/vault/x', { caller: PAYER })).status, 200, 'subscribed payer served');
    assert.equal((await apps.http('GET', '/app/vault/x', { caller: OTHER })).status, 402, 'a different address is still gated');
  });

  await t('a subscription EXPIRES on our clock — access ends after the period', async () => {
    let now = 1_000_000;
    const subs = memSubs();
    const paywall = createPaywall({ payTo: WALLET, price: '5', periodDays: 30, subs, clock: () => now, verify: async (p) => ({ ok: true, payer: p.payer, amountUsdc: 5 }) });
    const apps = createApps([premApp], { paywall });
    await paywall.settle({ payer: PAYER });
    assert.equal((await apps.http('GET', '/app/vault/x', { caller: PAYER })).status, 200);
    now += 31 * 24 * 3600 * 1000;                          // 31 days later
    assert.equal((await apps.http('GET', '/app/vault/x', { caller: PAYER })).status, 402, 'expired → gated again');
  });

  // ---- paywall fail-closed cases --------------------------------------------------------------
  await t('paywall FAIL CLOSED: no verifier, a throwing verifier, and underpayment all refuse', async () => {
    const subs = memSubs();
    assert.match((await createPaywall({ payTo: WALLET, subs }).settle({ payer: PAYER })).reason, /FAIL CLOSED/);
    assert.match((await createPaywall({ payTo: WALLET, subs, verify: async () => { throw new Error('rpc'); } }).settle({ payer: PAYER })).reason, /FAIL CLOSED/);
    assert.match((await createPaywall({ payTo: WALLET, price: '5', subs, verify: async (p) => ({ ok: true, payer: p.payer, amountUsdc: 1 }) }).settle({ payer: PAYER })).reason, /underpaid/);
    const noSigner = await createPaywall({ payTo: WALLET, subs, verify: async () => ({ ok: true }) }).settle({ payer: PAYER });  // ok but no payer addr
    assert.equal(noSigner.ok, false);
  });

  await t('createPaywall requires the operator wallet — a subscription without a payee is nonsense', () => {
    assert.throws(() => createPaywall({ subs: memSubs() }), /payTo must be the operator wallet/);
  });

  // ---- honesty guards -------------------------------------------------------------------------
  await t('paywall + apps hold no key, sign nothing, and never receive funds themselves', () => {
    for (const f of ['../lib/paywall.js', '../lib/apps.js']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.ok(!/privateKey|mnemonic|eth_sendTransaction|personal_sign|\.transfer\(|sendTransaction/i.test(code), f + ' must hold no key / move no funds');
    }
    // the money always goes to payTo (the operator wallet), verification is injected — LAWBOR only issues the challenge.
    const pw = createPaywall({ payTo: WALLET, subs: memSubs(), verify: async () => ({ ok: false }) });
    assert.equal(pw.payTo, WALLET);
    assert.equal(pw.challenge().body.accepts[0].payTo, WALLET);
  });

  // ---- raw contentType passthrough (an app ships a UI, not just JSON) + the built-in orggraph app ----
  await t('an app route may serve a raw contentType body (HTML/SVG), not only JSON', async () => {
    const apps = createApps([{ name: 'page', description: 'x', routes: [
      { method: 'GET', path: '/', handle: () => ({ contentType: 'text/html', body: '<h1>hi</h1>' }) },
      { method: 'GET', path: '/json', handle: () => ({ body: { ok: true } }) },
    ] }], {});
    const html = await apps.http('GET', '/app/page/', {});
    assert.equal(html.contentType, 'text/html'); assert.equal(html.body, '<h1>hi</h1>');
    const j = await apps.http('GET', '/app/page/json', {});
    assert.equal(j.contentType, undefined, 'a normal JSON route carries no contentType'); assert.deepEqual(j.body, { ok: true });
  });

  await t('the built-in orggraph app serves an HTML page and a /data graph fold of the node store', async () => {
    const { createStore } = require('../lib/store');
    const { buildWork } = require('../lib/work');
    const base = path.join(LAWBOR_TMP, 'orggraph-test');
    const store = createStore(base + '.jsonl', base + '.control');
    const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
    store.record({ id: '0x1', thread: 't', from: A, to: B, body: buildWork('help_wanted', { jobId: 'build', task: 'b' }), ts: 1 }, { origin: 'bot', dir: 'out', rxAt: 1 });
    store.record({ id: '0x2', thread: 't', from: A, to: B, body: buildWork('help_wanted', { jobId: 'deploy', task: 'd', dependsOn: ['build'] }), ts: 1 }, { origin: 'bot', dir: 'out', rxAt: 2 });
    const apps = createApps([require('../apps/orggraph')], {});
    const page = await apps.http('GET', '/app/orggraph/', { store });
    assert.ok(/text\/html/.test(page.contentType) && page.body.includes('<svg'), 'serves an HTML page with an svg');
    const data = await apps.http('GET', '/app/orggraph/data', { store });
    assert.deepEqual(data.body.ready, ['build'], 'ready frontier = the un-blocked root');
    assert.deepEqual(data.body.edges, [{ from: 'deploy', dependsOn: 'build' }], 'the dependency edge is exposed');
    assert.equal(apps.apps()[0].name, 'orggraph');
  });

  // ---- shipped apps: a stateless game + a node digest -----------------------------------------
  await t('tictactoe: a full game plays to a win, and illegal moves are rejected (pure, stateless)', async () => {
    const ttt = require('../apps/tictactoe');
    const { move } = ttt._game;
    // X wins the top row: X0 O3 X1 O4 X2
    let b = move(undefined, 0).board;              // X @0 (mark inferred)
    b = move(b, 3).board;                          // O @3
    b = move(b, 1).board;                          // X @1
    b = move(b, 4).board;                          // O @4
    const win = move(b, 2);                        // X @2 -> win
    assert.equal(win.status, 'X'); assert.equal(win.turn, null);
    assert.throws(() => move(win.board, 5), /game is over/, 'no moves after a win');
    assert.throws(() => move('X........', 0), /taken/, 'cannot play a taken cell');
    assert.throws(() => move(undefined, 9), /0\.\.8/, 'cell out of range');
    assert.throws(() => move('X........', 1, 'X'), /not X's turn/, 'X cannot move twice in a row');
    // a draw
    let d = 'XXOOOXXXO';                            // full board, no line -> draw
    assert.equal(ttt._game.statusOf(d), 'draw');
    // via the MCP tool dispatch
    const apps = createApps([ttt], {});
    const r = await apps.tool('app_tictactoe_move', { cell: 4 }, {});
    assert.equal(r.isError, false); assert.equal(r.payload.board, '....X....'); assert.equal(r.payload.turn, 'O');
  });

  await t('standup: the digest folds the node store (message + job-graph counts) and serves an HTML page', async () => {
    const { createStore } = require('../lib/store');
    const { buildWork } = require('../lib/work');
    const base = path.join(LAWBOR_TMP, 'standup-test');
    const store = createStore(base + '.jsonl', base + '.control');
    const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
    store.record({ id: '0x1', thread: 't', from: A, to: B, body: buildWork('help_wanted', { jobId: 'build', task: 'b' }), ts: 1 }, { origin: 'bot', dir: 'out', rxAt: 1 });
    store.record({ id: '0x2', thread: 't', from: A, to: B, body: buildWork('help_wanted', { jobId: 'deploy', task: 'd', dependsOn: ['build'] }), ts: 1 }, { origin: 'bot', dir: 'out', rxAt: 2 });
    const apps = createApps([require('../apps/standup')], {});
    const ctx = { node: { self: A }, store };
    const data = await apps.http('GET', '/app/standup/data', ctx);
    assert.equal(data.body.messages, 2);
    assert.equal(data.body.jobs.total, 2);
    assert.deepEqual(data.body.readyFrontier, ['build'], 'ready frontier = the un-blocked root');
    assert.equal(data.body.jobs.blocked, 1, 'deploy is blocked by build');
    const page = await apps.http('GET', '/app/standup/', ctx);
    assert.ok(/text\/html/.test(page.contentType) && page.body.includes('standup'), 'serves an HTML dashboard');
    // the MCP tool returns the same report
    const tool = await apps.tool('app_standup_report', {}, ctx);
    assert.equal(tool.payload.messages, 2);
  });

  // ---- the real premium app: the operator's curated feed, gated by x402 ------------------------
  await t('premium-feed: 402 until subscribed, content after — and an empty feed is honest, not invented', async () => {
    const os = require('node:os');
    const dir = path.join(LAWBOR_TMP, 'premfeed-');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    process.env.LAWBOR_PREMIUM_DIR = dir;
    const feed = require('../apps/premium-feed');

    let now = 1_000_000_000_000;
    const subs = memSubs();
    const paywall = createPaywall({ payTo: WALLET, price: '5', periodDays: 30, subs, clock: () => now,
      verify: async (p) => ({ ok: true, payer: p.payer, amountUsdc: 5 }) });
    const apps = createApps([feed], { paywall });

    // 1. unsubscribed → the x402 challenge, never the content
    const denied = await apps.http('GET', '/app/premium-feed/latest', { caller: PAYER });
    assert.equal(denied.status, 402, 'unpaid caller gets the 402 payment challenge');
    const deniedTool = await apps.tool('app_premium-feed_latest', {}, { caller: PAYER });
    assert.equal(deniedTool.isError, true, 'the MCP tool is refused too');

    // 2. pay → served. Empty feed must say so honestly (no fabricated content).
    await paywall.settle({ payer: PAYER });
    const empty = await apps.http('GET', '/app/premium-feed/latest', { caller: PAYER });
    assert.equal(empty.status, 200, 'subscribed payer is served');
    assert.equal(empty.body.empty, true);
    assert.match(empty.body.note, /has not published/, 'an empty feed is stated, not invented');

    // 3. the operator publishes → the same subscriber now gets the real entry
    fs.writeFileSync(path.join(dir, 'week-1.md'), '# Week 1 — operator note\n\nreal curated content');
    const got = await apps.http('GET', '/app/premium-feed/latest', { caller: PAYER });
    assert.equal(got.body.title, 'Week 1 — operator note');
    assert.match(got.body.body, /real curated content/);
    const html = await apps.http('GET', '/app/premium-feed/', { caller: PAYER });
    assert.ok(/text\/html/.test(html.contentType) && html.body.includes('Week 1'), 'members page renders the entry');

    // 4. the subscription expires on our clock → back to 402, content withheld
    now += 31 * 86400000;
    assert.equal((await apps.http('GET', '/app/premium-feed/latest', { caller: PAYER })).status, 402, 'expired sub is refused again');

    delete process.env.LAWBOR_PREMIUM_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t('premium-feed FAILS CLOSED with no paywall wired — never served free', async () => {
    const apps = createApps([require('../apps/premium-feed')]);   // no paywall
    const r = await apps.http('GET', '/app/premium-feed/latest', { caller: PAYER });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /fail closed/i);
  });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
