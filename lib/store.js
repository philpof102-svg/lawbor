'use strict';
/**
 * LAWBOR — store.js  (the conversation log behind the human-facing views + the LOCAL consent log)
 * ================================================================================================
 * Phil's correction: LAWBOR is not invisible bot-to-bot plumbing. Each human has a messaging app
 * (Telegram-shaped, richer): (1) their OWN conversations, (2) a live VIEW of what their bot is
 * autonomously discussing, and (3) a REQUESTS quarantine for first contact from strangers. Every
 * message is tagged with its ORIGIN:
 *   - origin 'human'  → the user wrote it (inbox / requests, split by consent)
 *   - origin 'bot'    → their bot said it autonomously (the "watch my bot" feed — never quarantined)
 * Append-only JSONL (last write wins per message id), LAWBOR_DB-overridable, zero network here.
 *
 * CONSENT is LOCAL and lives in a SEPARATE append-only control log (LAWBOR_CONTROL, a sibling of the
 * messages file), folded on read (lib/consent.js). It is never gossiped and never leaves the node.
 * The inbox/requests split is derived at READ time from that log + who you've written to — no new
 * field on the message row, the append-only message log is untouched.
 *
 * ═══ AN UNREADABLE LOG AND AN EMPTY ONE ARE NOT THE SAME ANSWER ═══
 * Five reads here used to swallow their own failure and return `[]` — and compact() returned a neutral
 * zero — so a brand-new node (no messages, perfectly normal) and a node whose journal is CORRUPTED gave
 * the same answer. On a messaging node that is the worst confusion available: the user concludes nobody
 * wrote to them. Not theoretical here either — a full volume has already corrupted a database in this
 * project, and a half-written tail is its signature.
 *
 * The fix deliberately keeps every RETURN VALUE the same shape: `all()` is still an array, and the ~30
 * call sites that filter it without asking are untouched. The distinction is ADDED next to them, via
 * `health()`, so it becomes visible without anything that works today changing behaviour. Same
 * three-state discipline as the sibling repo's `funder-history.js` (absent / unreadable / loaded),
 * adapted to a log that — unlike a JSON database — can also be half-written.
 */
const fs = require('fs');
const path = require('path');
const { foldControl, decideInbound } = require('./consent');

const FILE = process.env.LAWBOR_DB || path.join(__dirname, '..', 'data', 'messages.jsonl');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

const lower = (a) => String(a || '').toLowerCase();

/**
 * ONE reader for every log this store keeps. It answers TWO questions where the old code answered one:
 * what is in the file, AND whether the file could be read at all.
 *
 * The states are separate because each calls for a DIFFERENT operator action:
 *   'absent'      no file. The NORMAL state of a fresh node — nothing is wrong, nothing to do.
 *   'empty'       the file exists and holds zero bytes (see the caveat below).
 *   'ok'          read and parsed whole.
 *   'damaged'     read, but N lines did not parse, so those messages are LOST. A half-written tail is
 *                 exactly this shape — this is the state that catches the incident already seen here.
 *   'unreadable'  the read itself failed (EACCES, EISDIR, EBUSY…). Something broke; go look.
 *
 * ⚠️ WHY 'empty' ASSERTS NOTHING, unlike the sibling repo. There, a zero-byte observation database is
 * flatly a corruption signature. Here it is NOT: compact() legitimately writes a zero-byte log when it
 * keeps no rows (see its writeFileSync below). So this reader reports the byte count and refuses to
 * call it — structure, not intent. 'damaged' is the state that carries actual evidence of loss.
 */
function readLog(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    const code = e && e.code ? String(e.code) : null;
    if (code === 'ENOENT') {
      return { rows: [], state: 'absent', bytes: 0, lines: 0, corruptLines: 0, code,
        detail: 'no log at this path — the NORMAL state of a fresh node, not a failure' };
    }
    /* Callers deliberately do NOT cache this one: the file may be repaired a second later, and caching
     * a failure makes the failure last. (Same rule as funder-history.js's loadRegistry.) */
    return { rows: [], state: 'unreadable', bytes: null, lines: 0, corruptLines: 0, code,
      detail: 'the log exists but could not be read' + (code ? ' (' + code + ')' : '')
        + ' — this is NOT a cold start, something broke' };
  }
  const rows = [];
  let lines = 0, corruptLines = 0;
  for (const l of raw.split(/\r?\n/)) {
    if (!l.trim()) continue;
    lines++;
    let m; try { m = JSON.parse(l); } catch { corruptLines++; continue; }
    rows.push(m);
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes === 0) {
    return { rows, state: 'empty', bytes, lines, corruptLines, code: null,
      detail: 'the log exists and holds zero bytes — reachable BOTH by a compact that kept nothing and '
        + 'by a truncation, so it is not by itself proof of either' };
  }
  if (corruptLines > 0) {
    return { rows, state: 'damaged', bytes, lines, corruptLines, code: null,
      detail: corruptLines + ' of ' + lines + ' lines did not parse and were SKIPPED — those messages are '
        + 'lost, and a half-written tail is what a full volume leaves behind' };
  }
  return { rows, state: 'ok', bytes, lines, corruptLines, code: null, detail: null };
}

/* ONE fold, used by BOTH the cold read and the warm index. These were two copies of the same tombstone
 * rule held together by a "kept in lockstep with it" comment — and reworking the read path is exactly
 * when that kind of pair drifts, so they are now a single function.
 * A delete is an append: {id, deleted:true}. It rides the same last-write-wins-by-id rule as any other
 * row, so the log stays append-only (nothing is mutated in place). The tombstone is STICKY — once an id
 * is retired, an identical envelope redelivered afterwards stays hidden, so a harasser cannot un-delete
 * their message by resending it (envelopeId is deterministic → same id). */
function foldMessages(rows, tombstoned = new Set()) {
  const byId = new Map();
  for (const m of rows) {
    if (m.deleted) { tombstoned.add(m.id); byId.delete(m.id); continue; }
    if (tombstoned.has(m.id)) continue;
    byId.set(m.id, m);
  }
  return byId;
}

function readAll(file = FILE) { return [...foldMessages(readLog(file).rows).values()]; }

// control rows are EVENTS, not id-keyed — read them all in order; foldControl resolves last-write-wins.
function readControlRows(file) { return readLog(file).rows; }

function createStore(file = FILE, controlFile, opts = {}) {
  const ctrlFile = controlFile || process.env.LAWBOR_CONTROL || (file + '.control');
  const subsFile = process.env.LAWBOR_SUBS || (file + '.subs');

  /* Retention — bound how much history one node keeps. Before this, the log grew forever; and once the
   * in-memory index landed (below), "forever" meant unbounded RAM too, not just disk. Compaction is the
   * ONLY operation that rewrites the file; it drops tombstoned + superseded rows and anything past the
   * cap. 0 = unbounded (the default, so nothing changes for a node that doesn't opt in). */
  const maxMessages = Number.isFinite(opts.maxMessages) ? opts.maxMessages : 0;   // keep newest N live msgs
  const maxAgeMs    = Number.isFinite(opts.maxAgeMs)    ? opts.maxAgeMs    : 0;    // drop msgs older than this
  const compactEvery = Number.isFinite(opts.compactEvery) ? opts.compactEvery : 0; // auto-compact every N records
  let sinceCompact = 0;

  /* FOLD MEMO. The store index made READS O(1), but callers still fold the WHOLE message set on every
   * jobs/credit/peer/bazaar read — O(N) per request, ~0.5s at 80k messages (a rendezvous hub's wall).
   * `_mut` bumps on every mutation (message append/delete/compact AND control writes, since the blocked
   * filter depends on the control log); a caller memoizes an expensive derivation on `mutations()` +
   * whatever else its input depends on (e.g. resolved-fact count), so identical reads between two writes
   * fold once, not once each. Single-entry: the whole-store fold has ONE shape, so successive jobs/peer/
   * bazaar reads share it; a differently-keyed read (a per-thread fold) simply misses and recomputes. */
  let _mut = 0;
  let _memo = { key: null, val: undefined };

  /* In-memory message index, loaded once and kept in sync by record(). Before this, every
   * inbox/requests/jobs/thread call re-read AND re-parsed the WHOLE JSONL — so a flooder amplified
   * their cost into O(n) work on every read (the DoS surface named in SECURITY.md). Now the file is
   * parsed once; record() appends to disk AND to the index, so reads are O(1) amortized.
   * Single-writer assumption: two node processes on one LAWBOR_DB would desync (already warned against
   * — DESKTOP.md). The read path falls back to the file if the cache was never primed. */
  let msgCache = null;
  let msgHealth = null;           // verdict on the messages log from the last prime — surfaced by health()
  const deletedIds = new Set();   // ids retired by a tombstone — keeps warm reads sticky, same as readAll
  const primeCache = () => {
    // One pass that builds the live index AND remembers tombstoned ids, so record() can refuse to
    // re-admit a redelivered-after-delete envelope to the warm cache exactly as readAll hides it on a
    // cold read — now literally the same fold as the cold path (foldMessages), not a copy of it.
    const read = readLog(file);
    msgHealth = read;
    /* An UNREADABLE log is not cached: the file may be repaired a second later, and caching a failure
     * makes it last — so the next read retries. Reads still serve [], the ANSWER is unchanged; health()
     * is what now says why it is empty. A 'damaged' log IS cached: it was read, re-reading would only
     * lose the same lines again, and msgHealth carries the count proving messages went missing. */
    if (read.state === 'unreadable') { msgCache = null; return new Map(); }
    msgCache = foldMessages(read.rows, deletedIds);
    return msgCache;
  };
  const readMsgs = () => [...(msgCache || primeCache()).values()];

  /* Physically shrink the on-disk log to the retention bounds and rebuild the index. This is the only
   * place the file is rewritten, so it is the only place tombstoned bodies actually leave the disk.
   * Written to a temp file then renamed — libuv's rename passes MOVEFILE_REPLACE_EXISTING, an atomic
   * overwrite on Windows and POSIX, so a crash mid-compact leaves the old log intact, never a half-file.
   * Single-writer only (same as record()): running this while another process appends would drop that
   * process's writes — a node must compact its OWN store, in-process. */
  function compact({ now } = {}) {
    const clock = typeof now === 'function' ? now : Date.now;
    /* ⛔ THE MOST EXPENSIVE OF THE FIVE SWALLOWED READS. Any read failure used to be answered with
     * `{ totalBefore: 0, kept: 0, removed: 0 }`, and a neutral value is not a neutral statement:
     * "removed: 0" READS AS "I looked, there was nothing to remove" — a claim about the log — when the
     * truth was "I could not read the log at all". Nulls say the second thing and `state` names it, so
     * a caller can finally tell a no-op apart from a blind one. */
    const read = readLog(file);
    if (read.state === 'unreadable') {
      return { totalBefore: null, kept: null, removed: null,
        state: read.state, detail: read.detail, code: read.code };
    }
    /* A fresh node has nothing to compact — and compaction must not CREATE a log that does not exist,
     * which is exactly what falling through to the writeFileSync below would do. */
    if (read.state === 'absent') {
      return { totalBefore: 0, kept: 0, removed: 0, state: read.state, detail: read.detail };
    }
    const rawCount = read.lines;                                // every non-empty line, corrupt ones included
    let rows = [...foldMessages(read.rows).values()];           // live msgs, tombstones already resolved away
    rows.sort((a, b) => orderOf(a) - orderOf(b));               // oldest → newest
    // Thread-ATOMIC retention. The fold's unit of meaning is the thread, not the message: a job's opening
    // `help_wanted`/`offer` seeds it and every later bid/quote/settle is dropped by the fold if that seed
    // is missing (work.js: "a bid for a job we have not seen: ignore"). So BOTH bounds — age and count —
    // retain whole threads, never a partial one: cutting a live thread in half lets the newest replies
    // survive while the seed is gone, and the WHOLE negotiation silently vanishes on read (no crash, no
    // trace). Exactly the failure that only appears at scale.
    if (maxAgeMs > 0 || (maxMessages > 0 && rows.length > maxMessages)) {
      const byThread = new Map();
      for (const m of rows) {
        const k = m.thread || m.id;                            // a thread-less message is its own unit
        let g = byThread.get(k);
        if (!g) { g = { msgs: [], last: -Infinity }; byThread.set(k, g); }
        g.msgs.push(m);
        const o = orderOf(m); if (o > g.last) g.last = o;      // thread's most-recent activity
      }
      let threads = [...byThread.values()];
      // AGE — drop a thread only when its NEWEST activity is past the floor (a stale thread), never an
      // old seed that still has live replies. "No activity in N days", not "old individual messages".
      if (maxAgeMs > 0) { const floor = clock() - maxAgeMs; threads = threads.filter((t) => t.last >= floor); }
      threads.sort((a, b) => b.last - a.last);                 // newest-active first
      // COUNT — keep whole threads until the next would overflow; always keep the newest thread even if
      // it alone exceeds the cap (a live thread's tail is never orphaned to honour a soft bound).
      if (maxMessages > 0) {
        const kept = []; let keptMsgs = 0;
        for (const t of threads) {
          if (keptMsgs && keptMsgs + t.msgs.length > maxMessages) break;
          kept.push(t); keptMsgs += t.msgs.length;
        }
        threads = kept;
      }
      rows = threads.flatMap((t) => t.msgs).sort((a, b) => orderOf(a) - orderOf(b));
    }
    const tmp = file + '.compact.' + process.pid;
    const body = rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
    fs.writeFileSync(tmp, body);
    /* ⛔ UN APPEND FAIT PENDANT CETTE COMPACTION ETAIT SILENCIEUSEMENT ECRASE PAR LE RENAME.
     * La sequence est: readLog(file) -> fold/retention -> writeFileSync(tmp) -> renameSync(tmp, file).
     * Tout ce qu'un AUTRE processus appende entre la LECTURE et le RENAME atterrit dans le fichier que
     * le rename remplace. record() a rendu sa ligne sans erreur: l'appelant croit le message stocke.
     *
     * MESURE DU 2026-08-16, deux PROCESSUS sur le meme store, un ecrivain (une ligne toutes les 2 ms)
     * et un compacteur:
     *     log de     60 lignes (compaction < 1 ms)  ->   0 perdu sur 60
     *     log de 40 000 lignes (compaction 269 ms)  ->  49 PERDUS sur 60   (82 %)
     * Le premier chiffre est la lecon: un zero obtenu sur un log minuscule ne dit pas que la course
     * n'existe pas, il dit qu'on ne l'a pas ATTEINTE. La fenetre est proportionnelle a la TAILLE du
     * log — elle s'ouvre donc exactement quand le noeud devient occupe.
     *
     * ⚖️ QUAND C'EST VIVANT: pas par defaut (retention a 0), mais des qu'un operateur active
     * LAWBOR_MAX_MESSAGES / LAWBOR_MAX_AGE_DAYS (compaction au demarrage ET auto toutes les N
     * ecritures), et a CHAQUE scrub (node.js compacte apres une suppression). Le second processus est
     * precisement celui que desktop/lib/config.cjs decrit: « spawning a second one on the same
     * LAWBOR_DB would give them two processes appending to one JSONL ».
     *
     * ⚖️ CE CORRECTIF NE PREND PAS DE VERROU. Un verrou change le modele operationnel (verrou perime,
     * reprise apres crash) et c'est un arbitrage d'operateur. On fait ici le minimum indiscutable:
     * DETECTER la course et RENONCER. La compaction est une optimisation; perdre des messages ne l'est
     * pas. Le log reste INTACT et l'incident sort dans la valeur de retour — que ce module traite deja
     * comme porteuse (« A caller that discards that value discards the incident »). */
    let tailleAuRename = null;
    try { tailleAuRename = fs.statSync(file).size; } catch (e) { tailleAuRename = null; }
    if (tailleAuRename !== read.bytes) {
      try { fs.unlinkSync(tmp); } catch (e) { /* le tmp porte notre pid: personne d'autre ne l'attend */ }
      return { totalBefore: rawCount, kept: null, removed: 0, state: 'raced',
        detail: 'the log went from ' + read.bytes + ' to ' + tailleAuRename + ' bytes while this '
          + 'compaction was building its replacement — renaming would have DROPPED everything appended '
          + 'in between. Compaction ABORTED, the log is untouched. Another process is writing to this '
          + 'store; compaction is safe only while this node is the sole writer.' };
    }
    fs.renameSync(tmp, file);
    msgCache = new Map(rows.map((r) => [r.id, r]));             // rebuild the index from the compacted set
    /* The verdict has to follow the file: what is on disk is now exactly what we just wrote, so any
     * damage was physically dropped by this rewrite and the log really is clean again. The LOSS is not
     * erased — it rides out in this call's return value, which after this point is the only thing that
     * still knows it happened. A caller that discards that value discards the incident. */
    msgHealth = { state: body.length ? 'ok' : 'empty', bytes: Buffer.byteLength(body, 'utf8'),
      lines: rows.length, corruptLines: 0, code: null,
      detail: body.length ? null : 'zero rows survived compaction — a zero-byte log here is by design' };
    // Compaction physically removes the tombstones, so it also forgets the deletions — the body is gone,
    // which was the whole point. A still-active harasser should be BLOCKED (permanent in the control
    // log); delete is for scrubbing a stored body, block is for stopping a sender.
    deletedIds.clear();
    sinceCompact = 0;
    _mut++;   // the live message set changed shape
    /* `state` and `corruptLines` ride the SUCCESS path too, because compaction REWRITES the file: a
     * damaged log has just had its unparseable lines dropped for good. That is what compaction here has
     * always done — reporting it is the whole difference between a loss and a silent loss. */
    return { totalBefore: rawCount, kept: rows.length, removed: rawCount - rows.length,
      state: read.state, corruptLines: read.corruptLines };
  }

  const readControl = () => foldControl(readControlRows(ctrlFile));
  // addrs this node has an OUTBOUND human message to — replying is implicit consent.
  const knownContactsOf = (selfAddr) => {
    const self = lower(selfAddr);
    const set = new Set();
    for (const m of readMsgs()) if (m.origin === 'human' && m.dir === 'out' && lower(m.from) === self) set.add(lower(m.to));
    return set;
  };
  // human threads whose peer falls in a given consent bucket ('inbox' | 'requests')
  const humanThreads = (selfAddr, bucketWanted, limit) => {
    const self = lower(selfAddr);
    const { blocked, accepted } = readControl();
    const known = knownContactsOf(self);
    const rows = readMsgs().filter((m) => m.origin === 'human' && (lower(m.from) === self || lower(m.to) === self));
    return groupThreads(rows).filter((t) => bucketForThread(t, self, blocked, accepted, known) === bucketWanted).slice(0, limit);
  };

  return {
    /** Record a message. @param {object} env envelope · @param {{origin:'human'|'bot', dir:'in'|'out', senderScore?:number}} meta */
    record(env, meta = {}) {
      const row = { id: env.id, thread: env.thread, from: env.from, to: env.to, body: env.body,
        ts: env.ts, viaHuman: env.viaHuman || null,
        origin: meta.origin === 'bot' ? 'bot' : 'human', dir: meta.dir === 'out' ? 'out' : 'in',
        senderScore: Number.isFinite(meta.senderScore) ? meta.senderScore : null,
        // false = `from` was claimed, not proven. Recorded so the distinction survives to the UI.
        authenticated: meta.authenticated === true,
        // true = admitted under the opt-in probation policy, NOT vouched for by the oracle. Persisted
        // so no read view can quietly render a newcomer as a peer in good standing.
        probation: meta.probation === true,
        /* rxAt — OUR clock, not the sender's. `env.ts` is chosen by whoever built the envelope and
         * nothing validates it, so ordering threads by it let a stranger date a message ten years
         * ahead and pin their spam to the top of a human's inbox permanently (proven). Display may
         * still show env.ts; ordering must never trust it. */
        rxAt: Number.isFinite(meta.rxAt) ? meta.rxAt : Date.now() };
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      // A redelivered envelope whose id a tombstone already retired stays out of the warm cache, so
      // warm reads agree with readAll's cold path (the delete is sticky, not undone by a resend).
      if (msgCache && !deletedIds.has(row.id)) msgCache.set(row.id, row);
      _mut++;   // any fold memo is now stale
      // Auto-compact keeps a busy node bounded without a separate scheduler; off unless a cap is set.
      if (compactEvery > 0 && (maxMessages > 0 || maxAgeMs > 0) && ++sinceCompact >= compactEvery) compact();
      return row;
    },

    /** Local delete: retire a stored message by id (appends a sticky tombstone; body leaves disk on the
     *  next compact). Gives a harassment victim the "remove an already-stored body" the store lacked. */
    deleteMsg(id) {
      if (!id) return { ok: false, reason: 'no id' };
      fs.appendFileSync(file, JSON.stringify({ id, deleted: true, at: Date.now() }) + '\n');
      deletedIds.add(id);              // so a redelivery is refused on the warm path, sticky like readAll
      if (msgCache) msgCache.delete(id);
      _mut++;
      return { ok: true, id };
    },
    /** Physically shrink the log to the retention bounds; drops tombstoned + over-cap rows from disk. */
    compact,

    /** How many INBOUND messages we've stored from `addr` since `sinceMs` (our clock). Feeds the
     *  receive-time rate-limit — bounds how fast one sender can fill your store, even a reputable one. */
    countRecentFrom(addr, sinceMs) {
      const a = lower(addr); let n = 0;
      for (const m of readMsgs()) if (m.dir === 'in' && lower(m.from) === a && Number(m.rxAt) >= sinceMs) n++;
      return n;
    },

    /* ---- LOCAL consent control log (block / unblock / accept) — never gossiped, holds no key ---- */
    appendControl(type, addr) {
      if (!['block', 'unblock', 'accept'].includes(type)) throw new Error('bad control type: ' + type);
      fs.mkdirSync(path.dirname(ctrlFile), { recursive: true });
      const row = { type, addr: lower(addr), at: Date.now() };
      fs.appendFileSync(ctrlFile, JSON.stringify(row) + '\n');
      _mut++;   // the blocked filter changed, so any fold memo built on it is stale
      return row;
    },
    /** The single source of block/accept truth (folded from the control log). */
    control() { return readControl(); },

    /** Could each log this node keeps actually be READ — the question the reads themselves still refuse
     *  to answer (they return arrays, unchanged, so no caller breaks; see the header note).
     *  'absent' / 'empty' / 'ok' are benign. 'damaged' / 'unreadable' mean rows are missing and someone
     *  should look — `ok` is the rollup of exactly that.
     *  The CONTROL log matters as much as the messages one: it holds the blocks, so a journal that
     *  silently half-reads is a blocked harasser silently reappearing.
     *  ⚠️ HONEST LIMIT — the messages verdict dates from when this process LOADED the log, not from now.
     *  The index is primed once and kept warm by record(); re-reading an 80k-row journal on every
     *  /health poll is precisely the O(n)-per-request cost that index exists to remove. Corruption
     *  arriving AFTER boot is therefore not seen until something re-primes. The control and subs logs
     *  have no index and are re-read per call anyway, so those two are live. */
    health() {
      if (!msgCache) primeCache();                 // a node that has not read yet still gets a verdict
      const strip = (h) => ({ state: h.state, bytes: h.bytes, lines: h.lines,
        corruptLines: h.corruptLines, code: h.code, detail: h.detail });
      const messages = strip(msgHealth), control = strip(readLog(ctrlFile)), subs = strip(readLog(subsFile));
      const needsLook = (h) => h.state === 'damaged' || h.state === 'unreadable';
      return { ok: !needsLook(messages) && !needsLook(control) && !needsLook(subs),
        checkedAt: Date.now(), messages, control, subs };
    },
    /** Monotonic mutation counter — bumps on every message/tombstone/compact and control write. A caller
     *  memoizes an expensive fold on `mutations()` (+ its own extra inputs) so identical reads between two
     *  writes recompute nothing. */
    mutations() { return _mut; },
    /** Single-entry fold memo. `compute()` runs only when `key` differs from the last call. */
    foldMemo(key, compute) { if (_memo.key === key) return _memo.val; const val = compute(); _memo = { key, val }; return val; },

    /* ---- x402 subscription ledger (premium tier) — append-only, folded to the max expiry per payer.
       Records that a payer paid; the paywall (lib/paywall.js) decides. Never gossiped, holds no key. */
    appendSub(payer, until) {
      fs.mkdirSync(path.dirname(subsFile), { recursive: true });
      const row = { payer: lower(payer), until: Number(until) || 0, at: Date.now() };
      fs.appendFileSync(subsFile, JSON.stringify(row) + '\n');
      return row;
    },
    /** The latest expiry timestamp for a payer (0 if never paid). */
    subUntil(payer) {
      const p = lower(payer); let until = 0;
      for (const l of readControlRows(subsFile)) if (lower(l.payer) === p && Number(l.until) > until) until = Number(l.until);
      return until;
    },
    /** Addrs this node has written to (outbound human) — supplies "replying = consent". */
    knownContacts(selfAddr) { return knownContactsOf(selfAddr); },

    /** VIEW 1 — inbox: known/accepted human conversations only (Requests and blocked are excluded). */
    inbox(selfAddr, limit = 50) { return humanThreads(selfAddr, 'inbox', limit); },
    /** VIEW 3 — requests: first contact from an unknown, un-blocked sender, awaiting reply/accept. */
    requests(selfAddr, limit = 50) { return humanThreads(selfAddr, 'requests', limit); },
    /** VIEW 2 — watch my bot: the autonomous conversations this user's bot is having with other bots. */
    botActivity(selfAddr, limit = 50) {
      const self = lower(selfAddr);
      const rows = readMsgs().filter((m) => m.origin === 'bot' && (lower(m.from) === self || lower(m.to) === self));
      return groupThreads(rows).slice(0, limit);
    },
    thread(threadId, limit = 200) {
      return readMsgs().filter((m) => m.thread === threadId).sort((a, b) => orderOf(a) - orderOf(b)).slice(0, limit);
    },
    all() { return readMsgs(); },
  };
}

// Ordering runs on rxAt (our clock). Rows written before rxAt existed fall back to ts, which is the
// only place a sender-chosen value is still trusted — and only for already-stored history.
const orderOf = (m) => (Number.isFinite(m.rxAt) ? m.rxAt : Number(m.ts) * 1000);

// The peer of a human thread → the bucket that thread belongs in. A self-only note has no peer → inbox.
function bucketForThread(thread, self, blocked, accepted, known) {
  const peer = (thread.peers || []).map(lower).find((p) => p !== self);
  if (!peer) return 'inbox';
  return decideInbound({ from: peer, self, origin: 'human', blocked, accepted, hasOutboundTo: (a) => known.has(lower(a)) }).bucket;
}

function groupThreads(rows) {
  const t = new Map();
  for (const m of rows) {
    const g = t.get(m.thread) || { thread: m.thread, messages: 0, lastTs: 0, lastAt: -Infinity, last: '', peers: new Set() };
    g.messages++;
    const at = orderOf(m);
    if (at >= g.lastAt) { g.lastAt = at; g.lastTs = m.ts; g.last = m.body.slice(0, 80); }
    g.peers.add(m.from); g.peers.add(m.to);
    t.set(m.thread, g);
  }
  return [...t.values()].map((g) => ({ ...g, peers: [...g.peers] })).sort((a, b) => b.lastAt - a.lastAt);
}

module.exports = { createStore, FILE };
