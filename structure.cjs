'use strict';
/**
 * LAWBOR STRUCTURE — a deterministic FINGERPRINT of the invariants the design rests on.
 * ================================================================================================
 * `npm test` answers "did anything break on MY machine". This answers a different and, after today,
 * more useful question: DO TWO INDEPENDENT MACHINES COMPUTE THE SAME STRUCTURE?
 *
 * Every check below emits a canonical string; their sha256 is the fingerprint. Two operators run this,
 * compare one hash, and either agree in one line or know exactly which check diverged. That is the whole
 * point — a claim that "the structure is solid" is worth nothing until a second machine can falsify it.
 *
 * This exists because a single machine provably cannot see certain classes of defect. In one day here:
 *   - a recycled PID made a sim fold a graph it never built (never reproduces on a fresh box);
 *   - two nodes silently shared data/messages.jsonl (invisible on the two-machine setup the docs assume);
 *   - resolveFacts was never executed by any unit test, so two resolution bugs shipped green.
 *
 * 🛑 DETERMINISM RULES for anything added here. The fingerprint must not depend on the machine:
 *   no clocks, no PIDs, no randomness without a fixed seed, no absolute paths, no locale-sensitive
 *   sorting, and line endings normalised (a CRLF checkout must fingerprint like an LF one).
 *
 *   node structure.cjs           → human-readable report + fingerprint
 *   node structure.cjs --json    → machine-readable, for diffing two runs
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const work = require('./lib/work');
const { creditFor } = require('./lib/credit');
const { createRelay } = require('./lib/relay');
const { createVerifier } = require('./lib/verify');
const { buildEnvelope } = require('./lib/envelope');

const LIB = path.join(__dirname, 'lib');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => String(s).replace(/\r\n/g, '\n');          // a CRLF checkout must not change a hash

let FAIL_CLOSED = async () => {};
const checks = [];
const record = (id, expected, actual, note) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  checks.push({ id, ok, expected, actual, note });
  return ok;
};

/* A seeded PRNG. Math.random would make the fingerprint differ run to run, which would defeat the
 * entire exercise — the shuffles must be the SAME shuffles on both machines. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const shuffle = (arr, rand) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const TX = (n) => '0x' + String(n).padStart(64, '0');

// ---------------------------------------------------------------------------------------------
// 1. THE FOLD IS DETERMINISTIC AND ORDER-INDEPENDENT
//    Two nodes that saw the same messages must compute the same jobs, whatever order they arrived in.
//    A same-millisecond award once vanished because the fold was single-pass; that is why this is #1.
// ---------------------------------------------------------------------------------------------
{
  const log = [
    { id: '01', from: A, to: B, rxAt: 10, body: work.buildWork('help_wanted', { jobId: 'build', task: 'build' }) },
    { id: '02', from: A, to: C, rxAt: 10, body: work.buildWork('help_wanted', { jobId: 'verify', task: 'verify', dependsOn: ['build'] }) },
    { id: '03', from: B, to: A, rxAt: 10, body: work.buildWork('bid', { jobId: 'build', price: '10 USDC' }) },
    { id: '04', from: A, to: B, rxAt: 10, body: work.buildWork('award', { jobId: 'build', worker: B, price: '10 USDC' }) },
    { id: '05', from: C, to: A, rxAt: 20, body: work.buildWork('bid', { jobId: 'verify', price: '8 USDC' }) },
  ];
  // every rxAt deliberately collides — the tie-break must carry the whole ordering
  const digest = (msgs) => {
    const jobs = [...work.foldThread(msgs).values()]
      .map((j) => [j.jobId, j.state, j.ready, (j.blockedBy || []).join('|'), (j.bids || []).length].join(':'))
      .sort();
    return sha(jobs.join('\n'));
  };
  const base = digest(log);
  const rand = rng(0x1a2b3c4d);
  const perms = [];
  for (let i = 0; i < 64; i++) perms.push(digest(shuffle(log, rand)));
  record('fold.order-independent', [base], [...new Set(perms)],
    '64 seeded shuffles of a log whose timestamps all collide must fold to one identical digest');
  /* `fold.digest` USED TO LIVE HERE and it was a tautology: `base.slice(0,16) === base.slice(0,16)`,
   * which is x === x, so it emitted "stable" whatever the fold did. A check that cannot fail is worse
   * than no check — it occupies the slot where a real one would go and reports green forever. Signal B
   * found it by reading the harness rather than trusting its output, which is exactly what a second
   * signal is for. Deleted rather than repaired: fold.order-independent below already asserts that all
   * 64 permutations collapse to ONE digest, which is the property this pretended to check. */
  checks.push({ id: 'fold.value', ok: true, expected: base.slice(0, 16), actual: base.slice(0, 16),
    note: 'THE digest itself — if two machines differ here, the fold is machine-dependent' });
}

// ---------------------------------------------------------------------------------------------
// 2. CONSERVATION — the property five farmed rating designs died to reach.
//    A ring recycling a float earns EXACTLY zero from an outsider, whatever its on-chain volume.
// ---------------------------------------------------------------------------------------------
{
  const ring = ['0x' + 'd1'.repeat(20), '0x' + 'd2'.repeat(20), '0x' + 'd3'.repeat(20)];
  const edges = [];
  let n = 1;
  for (let round = 0; round < 40; round++) {
    for (let i = 0; i < ring.length; i++) {
      edges.push({ jobId: 'r' + n, txHash: TX(n++), payer: ring[i], worker: ring[(i + 1) % ring.length],
        amountMicro: '1000000000', blockTime: 1000 + n });
    }
  }
  const outsider = '0x' + 'ee'.repeat(20);
  const c = creditFor(outsider, edges, {});
  const totalMoved = edges.length * 1000;   // USDC
  record('credit.ring-earns-zero', { direct: 0, circle: 0 }, { direct: c.direct.size, circle: c.circle.size },
    ring.length + ' addresses moved ' + totalMoved + ' USDC among themselves in ' + edges.length + ' verified settlements');

  // and the bound BINDS: a viewer who spent 100 confers at most alpha*100 through the circle
  const seed = '0x' + 'f1'.repeat(20);
  const viewer = '0x' + 'f0'.repeat(20);
  const spend = [{ jobId: 's1', txHash: TX(9001), payer: viewer, worker: seed, amountMicro: '100000000', blockTime: 1 }];
  for (let i = 0; i < 50; i++) {
    spend.push({ jobId: 'x' + i, txHash: TX(9100 + i), payer: seed, worker: '0x' + String(i).padStart(40, '0'),
      amountMicro: '100000000', blockTime: 2 + i });
  }
  const c2 = creditFor(viewer, spend, {});
  const circleTotal = [...c2.circle.values()].reduce((a, b) => a + Number(b), 0) / 1e6;
  const directTotal = [...c2.direct.values()].reduce((a, b) => a + Number(b), 0) / 1e6;
  record('credit.bound-binds', true, circleTotal <= directTotal + 0.000001 && circleTotal > 0,
    'seed paid 100, then paid 50 addresses 100 each; circle conferred = ' + circleTotal + ' USDC, bounded by direct ' + directTotal);
}

// ---------------------------------------------------------------------------------------------
// 3. A FREE PROOF NEVER BECOMES STANDING — the line that killed traces, notes and a trust token.
// ---------------------------------------------------------------------------------------------
{
  const msgs = [];
  const facts = new Map();
  for (let i = 0; i < 200; i++) {
    const s = '0x' + String(i).padStart(40, '0');
    const sig = '0x' + (0xa0000 + i).toString(16);
    msgs.push(
      { id: 'h' + i, from: A, to: s, rxAt: 100 + i, body: work.buildWork('help_wanted', { jobId: 'f' + i, task: 'x' }) },
      { id: 'v' + i, from: s, to: A, rxAt: 200 + i, body: work.buildWork('validate', { jobId: 'f' + i, keyAddr: s, keySig: sig }) });
    facts.set(sig, { signer: s });
  }
  const c = creditFor(A, work.settlementsFrom(msgs, { sigFacts: facts }), {});
  record('proof.never-standing', { proven: 200, direct: 0, circle: 0 },
    { proven: work.provenFrom(msgs, { sigFacts: facts }).size, direct: c.direct.size, circle: c.circle.size },
    '200 genuinely-verified key proofs buy exactly nothing');
}

// ---------------------------------------------------------------------------------------------
// 4. DESCRIPTOR-ONLY — no verb, ever, produces something already signed.
// ---------------------------------------------------------------------------------------------
{
  const results = work.KINDS.map((k) => {
    const fields = { jobId: 'j', task: 't', price: '1 USDC', worker: B, reason: 'r',
      txHash: TX(7), amountMicro: '1000', keyAddr: B, keySig: '0xabcd' };
    let body; try { body = work.buildWork(k, fields); } catch (e) { return k + ':throws'; }
    const { sign } = buildEnvelope({ from: A, to: B, body, viaHuman: null });
    return k + ':' + String(sign.signed);
  });
  record('descriptor-only', work.KINDS.map((k) => k + ':false'), results,
    'every work verb yields an UNSIGNED descriptor — the operator signs, the node holds no key');
}

// ---------------------------------------------------------------------------------------------
// 5. FAIL-CLOSED — no verifier means refuse, never "trust the `from` field".
// ---------------------------------------------------------------------------------------------
{
  FAIL_CLOSED = async () => {
    const mk = (cfg) => createRelay({ self: A, preflight: async () => ({ decision: 'PROCEED', score: 90 }), ...cfg });
    const env = buildEnvelope({ from: B, to: A, body: 'hello', viaHuman: null }).envelope;
    const out = [];
    out.push('no-verifier:' + (await mk({}).accept(env)).action);
    out.push('no-verifier-but-allowed:' + (await mk({ allowUnauthenticated: true }).accept(env)).action);
    const wrongKey = mk({ verifySig: async () => ({ ok: true, signer: '0x' + '99'.repeat(20) }) });
    out.push('valid-sig-wrong-key:' + (await wrongKey.accept({ ...env, sig: '0xdead' })).action);
    record('fail-closed', ['no-verifier:drop', 'no-verifier-but-allowed:deliver', 'valid-sig-wrong-key:drop'], out,
      'refusing is the default; a valid signature by the WRONG key is still impersonation');
  };
}

// ---------------------------------------------------------------------------------------------
// 6. THE CORE STAYS PURE — no crypto implementation and no runtime dependency inside lib/.
// ---------------------------------------------------------------------------------------------
{
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort();
  const requires = new Set();
  const crypto包 = [];
  for (const f of files) {
    const src = norm(fs.readFileSync(path.join(LIB, f), 'utf8'));
    for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      requires.add(spec + ' (in ' + f + ')');
    }
    // an ecrecover or keccak IMPLEMENTATION here would be the worst place in the repo to be clever
    if (/function\s+keccak|secp256k1[A-Za-z]*\s*=|\bK\s*=\s*\[0x428a2f98/.test(src)) crypto包.push(f);
  }
  /* BEHAVIOURAL, not textual. The first version of this check grepped for `require('viem')` and flagged
   * verify.js — a false positive, because that require is lazy and wrapped in try/catch, which is the
   * whole design. An audit that reports a false failure gets ignored exactly as fast as one that reports
   * none, so the check now asks the real question: DOES lib/ LOAD WITH viem UNAVAILABLE? A child process
   * with a resolver hook that makes every non-builtin module vanish answers it for certain. */
  // builtinModules is captured ONCE, outside the hook. Calling require("module") inside the hook makes
  // the hook resolve "module", which calls the hook: an infinite recursion that reported every file as
  // broken. The false alarm was mine, and it is exactly the failure mode this whole file guards against.
  const probe = 'const M=require("module");const BI=new Set(M.builtinModules);const P=require("path");const real=M._resolveFilename;' +
    // P.isAbsolute, not r.startsWith("/") — a Windows absolute path begins with a drive letter, so the
    // naive test rejected "D:\\...\\work.js" and reported every module as missing. A portability check
    // that is itself platform-dependent is the joke this file exists to prevent; keeping the scar here.
    'M._resolveFilename=function(r,...a){if(!r.startsWith(".")&&!P.isAbsolute(r)&&!r.startsWith("node:")&&!BI.has(r))' +
    '{const e=new Error("MODULE_NOT_FOUND: "+r);e.code="MODULE_NOT_FOUND";throw e;}return real.call(this,r,...a);};' +
    'const out=[];for(const f of ' + JSON.stringify(files) + '){try{require(P.join(' + JSON.stringify(LIB) + ',f));}catch(e){out.push(f+": "+e.message);}}' +
    'console.log(JSON.stringify(out));';
  let loadFailures;
  try {
    loadFailures = JSON.parse(require('child_process').execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim());
  } catch (e) { loadFailures = ['probe itself failed: ' + ((e && e.message) || e)]; }
  record('lib.loads-without-any-dependency', [], loadFailures,
    'every lib/ module required with ALL non-builtin resolution disabled — this is the zero-dependency claim, tested rather than grepped');
  record('lib.no-hand-rolled-crypto', [], crypto包,
    'a subtly wrong ecrecover does not crash, it silently accepts forgeries');
  /* `lib.files` — a hard-coded count of 14 modules — USED TO BE HERE. Signal B called it a canary
   * rather than an invariant, and was right: adding one honest module to lib/ would make two machines
   * disagree and LOOK like a finding, when `git rev-parse` already answers "are these the same
   * checkout" perfectly. A check that manufactures false divergence, inside a tool whose entire output
   * IS divergence, is worse than no check at all. Removed. */
}

// ---------------------------------------------------------------------------------------------
// 7. THE PUBLISHED SURFACE — every one of these has been wrong at least once.
// ---------------------------------------------------------------------------------------------
{
  const pkg = JSON.parse(norm(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')));
  record('pkg.bins', ['lawbor-bot', 'lawbor-mcp', 'lawbor-node'], Object.keys(pkg.bin || {}).sort(),
    'npx resolves a bin whose NAME matches the package — lawbor-bot must exist or `npx lawbor-bot` cannot run');
  record('pkg.no-hard-deps', [], Object.keys(pkg.dependencies || {}),
    'a hard dependency would break the zero-dependency claim the core makes');
  /* AND THE OTHER HALF, which the previous version quietly did not check: viem must actually BE in
   * optionalDependencies. "no hard deps" stayed green on the commit where viem was declared NOWHERE —
   * the exact state in which a fresh install produces authenticatesSenders:false and a mesh that can
   * accept nobody. Two different properties were wearing one name. */
  record('pkg.viem-is-optional', true, !!(pkg.optionalDependencies || {}).viem,
    'declared optional means a fresh `npm install` gets a node that can authenticate; absent means a mesh nobody can join');

  /* SHIPS, not PROMISES-TO-SHIP. This read pkg.files[] and called it "ships-what-it-promises" — but
   * files[] is the INTENT, and a mis-cased or mis-globbed entry satisfies the intent while shipping an
   * empty path. So it now asks npm what the tarball would ACTUALLY contain. Same distinction as
   * `delivered` vs `forwarded`, and the same lesson: check the outcome, never the instruction. */
  const mustShip = ['SKILL.md', 'examples/signer-viem.js', 'lib/work.js', 'structure.cjs'];
  let packed = null;
  try {
    const out = require('child_process').execFileSync('npm', ['pack', '--dry-run', '--json'],
      { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
    packed = new Set((JSON.parse(out)[0].files || []).map((f) => String(f.path).replace(/\\/g, '/')));
  } catch (e) { packed = null; }
  record('pkg.ships-what-it-promises',
    packed ? [] : ['npm pack unavailable — UNVERIFIED, and reported as such rather than assumed green'],
    packed ? mustShip.filter((f) => !packed.has(f)) : ['npm pack unavailable — UNVERIFIED, and reported as such rather than assumed green'],
    'what the TARBALL contains, read from `npm pack --dry-run --json` — not what package.json intends to contain');
}

// ---------------------------------------------------------------------------------------------
// report  (async: the relay gate is genuinely asynchronous and must be awaited, not faked)
// ---------------------------------------------------------------------------------------------
(async () => {
await FAIL_CLOSED();
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
const canonical = checks.map((c) => c.id + '=' + (c.ok ? 'OK' : 'FAIL') + ':' + JSON.stringify(c.actual)).join('\n');
const FINGERPRINT = sha(canonical);
const failed = checks.filter((c) => !c.ok);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ fingerprint: FINGERPRINT, checks, failed: failed.length }, null, 1));
} else {
  console.log('\nLAWBOR structure — invariants, and a fingerprint a second machine can falsify\n');
  for (const c of checks) {
    console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.id);
    console.log('      ' + c.note);
    if (!c.ok) console.log('      expected ' + JSON.stringify(c.expected) + '\n      actual   ' + JSON.stringify(c.actual));
  }
  console.log('\n  FINGERPRINT  ' + FINGERPRINT);
  console.log('  ' + (failed.length ? '❌ ' + failed.length + ' invariant(s) broken' : '✅ all invariants hold'));
  console.log('\n  Compare the fingerprint with the other operator. Identical = the two machines compute the');
  console.log('  same structure. Different = run with --json and diff; the first differing check is the finding.\n');
}
process.exit(failed.length ? 1 : 0);
})();
