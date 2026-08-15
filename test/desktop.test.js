'use strict';
// LAWBOR desktop pod — geometry, config and view-mapping guards. Fully offline: no Electron, no
// display, no network. The Electron-only wiring lives in main.cjs/preload.cjs; everything with a
// decision in it lives in desktop/lib/* and is pinned here.
// Run: node test/desktop.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fitOnScreen, collapsed, expanded, firstPosition } = require('../desktop/lib/win.cjs');
const { resolveConfig, resolveSize, DEFAULT_PORT } = require('../desktop/lib/config.cjs');
const V = require('../desktop/lib/view.cjs');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const WA = { x: 0, y: 0, width: 1920, height: 1040 };   // a typical work area (taskbar taken out)
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);

console.log('LAWBOR desktop — the floating pod:');

// --- geometry: the stranded-window class of bug ------------------------------------------------
t('collapse anchors the mini object on the pod\'s bottom-right corner', () => {
  const b = { x: 1540, y: 480, width: 360, height: 540 };
  const c = collapsed(b, 108, WA);
  assert.deepEqual([c.width, c.height], [108, 108]);
  assert.equal(c.x + c.width, b.x + b.width);
  assert.equal(c.y + c.height, b.y + b.height);
});

t('expand from a collapsed pod restores the same corner', () => {
  const b = { x: 1792, y: 912, width: 108, height: 108 };
  const e = expanded(b, 360, 540, WA);
  assert.equal(e.x + e.width, b.x + b.width);
  assert.equal(e.y + e.height, b.y + b.height);
});

t('expanding near the TOP edge never pushes the header off-screen (the stranded-pod bug)', () => {
  // Collapsed at the very top-left: the naive corner math gives a negative y → the drag handle
  // would sit above the screen and the window becomes unmovable and unclosable.
  const b = { x: 0, y: 0, width: 108, height: 108 };
  const e = expanded(b, 360, 540, WA);
  assert.ok(e.x >= WA.x, 'x clamped into the work area');
  assert.ok(e.y >= WA.y, 'y clamped into the work area');
  assert.ok(e.x + e.width <= WA.x + WA.width && e.y + e.height <= WA.y + WA.height, 'fully on-screen');
});

t('fitOnScreen keeps the whole window inside a non-zero-origin display (second monitor)', () => {
  const wa = { x: -1920, y: 120, width: 1920, height: 1000 };
  const f = fitOnScreen({ x: -3000, y: 90, width: 360, height: 540 }, wa);
  assert.equal(f.x, -1920);
  assert.equal(f.y, 120);
});

t('first position is bottom-right with a gap, on-screen', () => {
  const p = firstPosition(360, 540, WA);
  assert.equal(p.x, 1920 - 360 - 20);
  assert.equal(p.y, 1040 - 540 - 20);
});

// --- config: attach vs spawn -------------------------------------------------------------------
t('no env → spawns its own node on the default port', () => {
  const c = resolveConfig({});
  assert.equal(c.spawn, true);
  assert.equal(c.port, DEFAULT_PORT);
  assert.equal(c.base, 'http://127.0.0.1:' + DEFAULT_PORT);
});

t('LAWBOR_NODE_URL → ATTACHES, never spawns a second node onto the same log', () => {
  const c = resolveConfig({ LAWBOR_NODE_URL: 'http://127.0.0.1:9999/' });
  assert.equal(c.spawn, false, 'must not spawn — two processes appending to one JSONL');
  assert.equal(c.base, 'http://127.0.0.1:9999', 'trailing slash stripped');
});

t('size presets clamp so the pod can never become unusable', () => {
  assert.deepEqual(resolveSize({ LAWBOR_SIZE: 'small' }), [300, 420]);
  assert.deepEqual(resolveSize({ LAWBOR_W: '10', LAWBOR_H: '10' }), [260, 360]);
  assert.deepEqual(resolveSize({ LAWBOR_W: '99999', LAWBOR_H: '99999' }), [900, 1000]);
});

// --- view mapping: the two-view contract --------------------------------------------------------
t('counterparty is the OTHER peer, never our own address', () => {
  assert.equal(V.counterparty({ peers: [A, B] }, A), V.shortAddr(B));
  assert.equal(V.counterparty({ peers: [A] }, A), '—', 'self-only thread shows no fake counterparty');
});

t('threadRow marks the bot feed as autonomous (a human did NOT write this)', () => {
  const now = 1_784_379_335_000;   // a real "now" in ms; 1e12-ish fixtures straddle the s/ms threshold
  const row = V.threadRow({ thread: 't1', peers: [A, B], last: 'hello  there', messages: 3, lastTs: now - 7200e3 }, A, 'bot', now);
  assert.equal(row.autonomous, true);
  assert.equal(row.when, '2h');
  assert.equal(row.preview, 'hello there', 'whitespace collapsed for a one-line preview');
  assert.equal(V.threadRow({ thread: 't1', peers: [A, B], last: '', messages: 1, lastTs: now }, A, 'inbox', now).autonomous, false);
});

t('relTime reads UNIX-SECONDS envelope timestamps (regression: two live nodes showed "20000d")', () => {
  // A real envelope from a running node: ts is uint64 SECONDS, the panel's clock is milliseconds.
  const tsSeconds = 1784379335;
  const now = tsSeconds * 1000 + 7200e3;                 // two hours later, in ms
  assert.equal(V.relTime(tsSeconds, now), '2h');
  assert.equal(V.relTime(tsSeconds * 1000, now), '2h', 'a ms timestamp still works');
  assert.equal(V.threadRow({ thread: 't', peers: [A, B], last: 'x', messages: 1, lastTs: tsSeconds }, A, 'inbox', now).when, '2h');
});

t('relTime degrades gracefully instead of printing NaN', () => {
  assert.equal(V.relTime(undefined, Date.now()), '');
  assert.equal(V.relTime(1000, undefined), '');
  assert.equal(V.relTime(Date.now() + 5000, Date.now()), 'now', 'clock skew never yields a negative age');
});

t('bubble carries origin + provenance so a bot message can never look human-authored', () => {
  const b = V.bubble({ id: 'm1', from: B, to: A, body: 'gm', origin: 'bot', viaHuman: null, senderScore: 71, ts: 1 }, A);
  assert.equal(b.side, 'in');
  assert.equal(b.origin, 'bot');
  assert.equal(b.score, 71);
  const mine = V.bubble({ id: 'm2', from: A, to: B, body: 'yo', origin: 'human', viaHuman: 'phil', ts: 2 }, A);
  assert.equal(mine.side, 'out');
  assert.equal(mine.who, 'you');
  assert.equal(mine.viaHuman, 'phil');
  assert.equal(mine.score, null, 'a missing score is null, not 0 — 0 would read as "untrusted"');
});


t('jobRow never lets an award read as a payment', () => {
  const now = 1_784_379_335_000;
  const awarded = V.jobRow({ jobId: 'j1', state: 'awarded', requester: A, task: 'index a contract',
    bids: [{ worker: B, price: '15 USDC' }], award: { worker: B, price: '15 USDC', corroborated: true }, at: now - 60_000 }, A, now);
  assert.equal(awarded.state, 'awarded');
  assert.equal(awarded.winner, V.shortAddr(B));
  assert.match(awarded.settlement, /no funds held or released/,
    'every row carries the caveat — an award is an agreement, not a settlement');
  assert.equal(awarded.unconfirmed, false);
  const uncorroborated = V.jobRow({ jobId: 'j2', state: 'awarded', requester: A, task: 'x', bids: [],
    award: { worker: B, price: '1', corroborated: false }, at: now }, A, now);
  assert.equal(uncorroborated.unconfirmed, true, 'an award whose bid we never saw is flagged, not equated');
});

t('jobRow marks MY jobs so the panel knows who may award', () => {
  const now = 1_784_379_335_000;
  assert.equal(V.jobRow({ jobId: 'j', state: 'open', requester: A, task: 't', bids: [], at: now }, A, now).mine, true);
  assert.equal(V.jobRow({ jobId: 'j', state: 'open', requester: B, task: 't', bids: [], at: now }, A, now).mine, false);
});

t('the pod can open on a chosen tab, and only on a real one', () => {
  assert.equal(resolveConfig({ LAWBOR_VIEW: 'jobs' }).startView, 'jobs');
  assert.equal(resolveConfig({ LAWBOR_VIEW: 'requests' }).startView, 'requests', 'the requests tab must be openable (regression: it was missing from the allowlist)');
  assert.equal(resolveConfig({ LAWBOR_VIEW: 'nonsense' }).startView, 'inbox', 'garbage falls back, never breaks the panel');
  assert.equal(resolveConfig({}).startView, 'inbox');
});


t('requestRow exposes the RAW peer address so the panel can block/accept them', () => {
  const now = 1_784_379_335_000;
  const row = V.requestRow({ thread: 't1', peers: [A, B], last: 'gm  we have not met', messages: 1, lastAt: now - 120000 }, A, now);
  assert.equal(row.withAddr, B, 'raw address, not shortened — block/accept need it');
  assert.equal(row.with, V.shortAddr(B), 'display is still shortened');
  assert.equal(row.preview, 'gm we have not met');
  assert.equal(row.when, '2m');
  assert.equal(V.requestRow({ thread: 't', peers: [A], last: 'x', messages: 1, lastAt: now }, A, now).withAddr, null, 'self-only → no block target');
});

t('requestRow orders on lastAt (our clock), never a spoofed sender ts', () => {
  const now = 1_784_379_335_000;
  // even if the row also carries a wild lastTs, the panel time uses lastAt
  const row = V.requestRow({ thread: 't', peers: [A, B], last: 'x', messages: 1, lastAt: now - 3600000, lastTs: 9999999999 }, A, now);
  assert.equal(row.when, '1h', 'display follows our receive clock, not the sender ts');
});

// --- safety posture: the pod must not become a signing surface ----------------------------------
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'index.html'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.cjs'), 'utf8');

t('the panel never injects message bodies as HTML (stored-XSS closed by construction)', () => {
  // Match the USE, not the word: the panel documents that it avoids innerHTML, and a naive
  // /innerHTML/ would flag its own comment.
  assert.ok(!/\.(inner|outer)HTML\s*\+?=/.test(PANEL), 'nothing is ever assigned as HTML');
  assert.ok(!/insertAdjacentHTML|document\.write/.test(PANEL), 'no HTML-parsing sinks');
  assert.ok(/textContent/.test(PANEL), 'user data goes through textContent');
});

t('the panel SURFACES a damaged store instead of showing a silently short list', () => {
  /* ⛔ LE DERNIER KILOMETRE. `lib/store.js` calcule cinq etats et son en-tete nomme le prejudice qu'il
   * existe pour eviter — « the user concludes nobody wrote to them ». `server.js` les publie a /health
   * sous `logs`. Mesure du 2026-08-15: ce panneau lisait `h.self` et `h.peers`, et RIEN d'autre —
   * zero occurrence de `logs`/`damaged`/`unreadable` dans tout desktop/. Le producteur faisait le
   * travail, le transport le portait, la seule surface qu'un humain regarde le jetait.
   * 💎 Et ce n'est pas « inbox vide »: mesure sur un log a 2 lignes dont 1 corrompue, `all()` rend 1.
   * La liste est SILENCIEUSEMENT AMPUTEE, ce qu'aucun utilisateur ne peut deviner. */
  assert.ok(/h\.logs|logs\.ok/.test(PANEL), 'le panneau doit LIRE l etat du journal publie par /health');
  assert.ok(/corruptLines/.test(PANEL), 'et nommer le nombre de lignes perdues, pas seulement « erreur »');
  /* ⚖️ Cas oppose: rien ne doit s afficher quand tout va bien — un bandeau permanent apprend a etre
   * ignore. La condition doit donc etre sur `ok === false`, jamais sur la simple presence de `logs`. */
  assert.ok(/logs\.ok === false/.test(PANEL),
    'l avertissement est conditionne a ok===false: `absent` et `empty` sont des etats NORMAUX');
  /* Le bandeau doit SURVIVRE au changement de vue: `show()` remplace tout le contenu de `main`, donc un
   * message pousse dedans disparaitrait au premier clic — pendant qu on parcourt une liste amputee. */
  assert.ok(/insertBefore\(n, main\)/.test(PANEL), 'l avertissement vit HORS de main, sinon show() l efface');
});

t('the renderer cannot aim a request at another host (base url pinned in the preload)', () => {
  assert.ok(!/\bfetch\s*\(/.test(PANEL), 'the panel has no raw fetch — only the bridged api');
  assert.ok(/CFG\.base \+ pathname/.test(PRELOAD), 'the preload prefixes every call with our own node');
});

t('the pod holds no key and exposes no signing path', () => {
  for (const src of [PANEL, PRELOAD]) {
    assert.ok(!/privateKey|PRIVATE_KEY|mnemonic|eth_sendTransaction|personal_sign/i.test(src));
  }
});

t('preload keeps contextIsolation guarantees: no node globals handed to the renderer', () => {
  assert.ok(!/exposeInMainWorld\([^)]*require/.test(PRELOAD));
  assert.ok(/contextBridge\.exposeInMainWorld/.test(PRELOAD));
});

// --- navigation: la fenetre elle-meme ne doit pas pouvoir quitter le panneau --------------------
// `setWindowOpenHandler` ne couvre que window.open et target=_blank; une navigation de la fenetre
// (location.href, un lien sans target, un formulaire) n'etait controlee par rien. Une page distante
// chargee ici heriterait du MEME preload — donc de say(), accept(), block(), win('quit').
// ⚖️ Ce n'etait pas un trou ouvert: toute donnee de pair passe par textContent (asserte plus haut),
// donc aucun chemin connu n'y menait. C'est de la defense en profondeur, et la regle est desormais
// dans desktop/lib/ comme le veut la convention annoncee en tete de ce fichier.
const { decideNavigation } = require('../desktop/lib/nav.cjs');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
const PANNEAU = 'file:///C:/x/desktop/index.html';

t('le panneau lui-meme reste chargeable — sinon le rechargement apres crash casserait', () => {
  assert.equal(decideNavigation(PANNEAU, PANNEAU), 'allow');
  assert.equal(decideNavigation(PANNEAU + '#inbox', PANNEAU), 'allow', 'une ancre reste le panneau');
  assert.equal(decideNavigation(PANNEAU + '?v=jobs', PANNEAU), 'allow');
});

t('toute autre destination est refusee au pod, https part au navigateur du systeme', () => {
  assert.equal(decideNavigation('https://basescan.org/tx/0x1', PANNEAU), 'external');
  for (const u of [
    'http://evil.invalid/p',            // http en clair: pas d ouverture externe non plus
    'file:///C:/Windows/System32/x',    // un autre fichier local n est pas le panneau
    'file:///C:/x/desktop/index.html.evil', // prefixe du panneau SANS separateur: doit etre refuse
    'data:text/html,<script>1</script>',
    'javascript:alert(1)',
    'HTTPS://evil.invalid',             // regle sensible a la casse, comme l originale
    '', null, undefined, 42,
  ]) {
    assert.equal(decideNavigation(u, PANNEAU), 'deny', 'doit refuser: ' + String(u));
  }
});

t('main.cjs cable la regle sur les DEUX portes, pas seulement window.open', () => {
  assert.ok(/setWindowOpenHandler/.test(MAIN), 'la porte window.open existe toujours');
  assert.ok(/on\('will-navigate'/.test(MAIN), 'la navigation de la fenetre est interceptee');
  const usages = MAIN.match(/decideNavigation\(/g) || [];
  assert.ok(usages.length >= 2, 'les deux portes passent par la MEME regle, vu ' + usages.length);
});

t('main.cjs garde la frontiere qui rend tout le reste applicable', () => {
  // Les assertions de posture ci-dessus lisent index.html et preload.cjs — jamais main.cjs. Or c est
  // la que la frontiere est DECIDEE: avec nodeIntegration:true le renderer aurait require() quoi que
  // le preload expose, et chacune de ces assertions resterait verte.
  assert.ok(/contextIsolation:\s*true/.test(MAIN), 'contextIsolation doit rester ON');
  assert.ok(/nodeIntegration:\s*false/.test(MAIN), 'nodeIntegration doit rester OFF');
  assert.ok(/preload:\s*path\.join\(__dirname, 'preload\.cjs'\)/.test(MAIN), 'le preload est bien le notre');
  assert.ok(!/loadURL\s*\(/.test(MAIN), 'le pod charge un FICHIER local, jamais une URL distante');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
