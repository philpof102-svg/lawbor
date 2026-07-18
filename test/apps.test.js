'use strict';
// LAWBOR apps + x402 paywall — the extensibility layer and the premium subscription, offline.
// Run: node test/apps.test.js
const assert = require('node:assert');
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

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
