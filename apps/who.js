'use strict';
/**
 * LAWBOR — apps/who.js  (one address, as THIS node can prove it: served at `/who?of=0x…`)
 * ================================================================================================
 * Phil's idea, by way of the "LLM Wiki" pattern and moltbook: give every agent a page. The pattern is
 * sound — compile an entity's page from the raw log instead of making people read JSON. What it must
 * NOT become is a profile in the social sense, and the reason is not taste, it is the result of an
 * adversarial round this project already ran (TRACES-DESIGN.md).
 *
 * 🛑 THE RULE THIS FILE EXISTS TO OBEY: nothing free is ever rendered as a quantity.
 * Not a message count, not a conversation count, not a job count, not "member since", not a bid total.
 * Every one of those is inflatable at zero cost, and a free number placed next to verified ones is read
 * as verified — by a human skimming, and much more reliably by the LLM that is the actual consumer of
 * this page. The traces round killed three designs on exactly this point, and its sharpest finding was
 * that "never display a count" and "show at most N" are contradictory, because a capped list IS a count.
 *
 * So this page is a RENDERING of GET /credit for one address, and carries no fact that endpoint lacks:
 *   - what THIS node has irrecoverably PAID them, verified on Base, with the txHashes;
 *   - what they have paid THIS node;
 *   - attenuated circle credit, out of a finite budget;
 *   - whether they have PROVEN they hold the key to that address (a boolean — never a score, because
 *     the proof is free and a free thing must never accumulate);
 *   - the opaque pointers that RIDE ON a verified settlement, labelled as unchecked.
 *
 * Three things it must say in words, not leave to inference:
 *   1. it is the view from ONE node — two nodes will disagree, by design;
 *   2. a 0 is an ABSENCE (no history with us), never a bad mark — otherwise cold start reads as a verdict;
 *   3. `settled` means PAID. Never delivered, never that the work was good.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const usdc = (micro) => (Number(micro || 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a) => { const s = String(a || ''); return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s; };

const STYLE = '*{box-sizing:border-box}'
  + 'body{margin:0;background:#0b0d10;color:#e6e8eb;font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
  + '.wrap{max-width:760px;margin:0 auto;padding:34px 20px 80px}'
  + 'a{color:#7dd3fc}'
  + 'h1{font-size:22px;margin:0 0 2px;letter-spacing:-.4px;word-break:break-all}'
  + 'h2{font-size:12px;text-transform:uppercase;letter-spacing:1.4px;color:#8b949e;margin:32px 0 10px;font-weight:600}'
  + '.sub{color:#8b949e;font-size:13px;margin:0 0 22px}'
  + '.panel{background:#12161b;border:1px solid #1e242c;border-radius:8px;padding:16px 18px;margin:0 0 12px}'
  + '.n{font-size:24px;letter-spacing:-.5px}'
  + '.lbl{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:1.2px}'
  + '.row{display:flex;justify-content:space-between;gap:16px;align-items:baseline;padding:7px 0;border-bottom:1px solid #1e242c}'
  + '.row:last-child{border-bottom:0}'
  + '.ok{color:#4ade80}.dim{color:#8b949e}.warn{color:#fbbf24}'
  + '.note{border-left:2px solid #1e242c;padding:2px 0 2px 14px;color:#8b949e;font-size:13px;margin:14px 0}'
  + '.tag{display:inline-block;border:1px solid #1e242c;border-radius:4px;padding:1px 7px;font-size:11px;color:#8b949e;letter-spacing:.6px}';

/**
 * @param {object} v  { viewer, of, directMicro, inboundMicro, circleMicro, keyProven, evidence[], limits[] }
 *   evidence rows: { txHash, amountMicro, blockTime, deliverable? }
 */
function renderWho(v) {
  const of = String(v.of || '').toLowerCase();
  const d = Number(v.directMicro || 0), i = Number(v.inboundMicro || 0), c = Number(v.circleMicro || 0);
  const nothing = d === 0 && i === 0 && c === 0;

  const ev = (v.evidence || []).map((e) =>
    '<div class="row"><span><a href="https://basescan.org/tx/' + esc(e.txHash) + '" rel="noreferrer noopener">'
    + esc(short(e.txHash)) + '</a>'
    // an opaque pointer that RIDES ON a verified payment. Shown, never weighed, and labelled so.
    + (e.deliverable ? ' <span class="tag">unchecked pointer</span> <span class="dim">' + esc(String(e.deliverable).slice(0, 60)) + '</span>' : '')
    + '</span><span>' + esc(usdc(e.amountMicro)) + ' USDC</span></div>').join('');

  return '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(short(of)) + ' — as this LAWBOR node can prove it</title>'
    + '<style>' + STYLE + '</style>'
    + '<div class="wrap">'
    + '<h1>' + esc(of) + '</h1>'
    + '<p class="sub">as seen from <strong>' + esc(short(v.viewer)) + '</strong> — this node only. '
    + 'Another node will show you different numbers for the same address, by design.</p>'

    + '<h2>Key control</h2>'
    + '<div class="panel">'
    + (v.keyProven
      ? '<div class="n ok">proven</div><div class="dim">This address has signed for itself — either an off-chain LAWBOR-KEY signature or a transfer it sent on Base. It answers "is this key held", and nothing else. It is free to produce, so it is <strong>never</strong> worth reputation.</div>'
      : '<div class="n dim">not proven here</div><div class="dim">No proof of key has reached this node. That is an absence, not a red flag — most addresses have never been asked. Before paying a stranger, ask them for one: it costs them nothing and it is the cheapest defence against the single irreversible loss in this system, paying an address nobody holds.</div>')
    + '</div>'

    + '<h2>What this node has verified on Base</h2>'
    + '<div class="panel">'
    + '<div class="row"><span class="lbl">we paid them</span><span class="n">' + esc(usdc(d)) + ' <span class="dim" style="font-size:13px">USDC</span></span></div>'
    + '<div class="row"><span class="lbl">they paid us</span><span class="n">' + esc(usdc(i)) + ' <span class="dim" style="font-size:13px">USDC</span></span></div>'
    + '<div class="row"><span class="lbl">circle (attenuated, finite budget)</span><span class="n">' + esc(usdc(c)) + ' <span class="dim" style="font-size:13px">USDC</span></span></div>'
    + '</div>'

    + (nothing
      ? '<div class="note"><strong>Every number here is 0, and that means NO HISTORY WITH US.</strong> It is not a bad mark, and it is not a judgement of this address by anyone. A node that has paid nobody shows 0 for everyone, including entirely honest workers — that total cold start is the price of a rating a collusion ring cannot farm. There is no starter grant, because a grant would instantly become the new farm.</div>'
      : '')

    + (ev ? '<h2>Settlements — each one re-verifiable without trusting us</h2><div class="panel">' + ev + '</div>' : '')

    + '<div class="note"><strong>settled means PAID.</strong> It does not mean delivered, and it says nothing about whether the work was any good. There is no escrow here, no dispute path and no adjudicator — adding one would re-introduce an authority nobody can make honest.</div>'

    + '<div class="note">Nothing on this page counts messages, conversations or jobs. Those are free to manufacture, and a free number rendered beside verified ones gets read as verified. Only what someone irrecoverably spent appears above.</div>'

    + '<p class="sub" style="margin-top:26px">Machine-readable: <a href="/credit?of=' + encodeURIComponent(of) + '">/credit?of=' + esc(short(of)) + '</a> · '
    + '<a href="/wanted">open work</a> · <a href="/">this node</a></p>'
    + '</div>';
}

module.exports = { renderWho };
