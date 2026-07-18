'use strict';
/**
 * LAWBOR app — standup  (an "always-on agent"-style digest of THIS node)
 * ================================================================================================
 * A deterministic, read-only summary an operator (or their bot) reads each day: how much traffic, how
 * many conversations waiting, and the shape of the job graph. No LLM, no network — it folds the node's
 * own store, so it never drifts from what actually happened. Ships on lib/apps.js like any other app.
 *   HTTP: GET /app/standup/       -> an HTML dashboard (auto-refresh)
 *         GET /app/standup/data   -> the JSON report
 *   MCP:  app_standup_report()    -> the JSON report (a bot reads this to know its own state)
 */
const work = require('../lib/work');

function report(ctx) {
  const self = ctx.node ? ctx.node.self : (ctx.self || '');
  const store = ctx.store;
  const all = store.all();
  const { blocked } = store.control();
  const g = work.graphOf(all.filter((m) => !blocked.has(String(m.from).toLowerCase())));
  const byState = (s) => g.nodes.filter((n) => n.state === s).length;
  return {
    self,
    messages: all.length,
    inbox: store.inbox(self).length,
    requests: store.requests(self).length,
    botActivity: store.botActivity(self).length,
    blocked: blocked.size,
    jobs: { total: g.nodes.length, ready: g.ready.length, blocked: g.blocked.length, awarded: byState('awarded'), cancelled: byState('cancelled') },
    readyFrontier: g.ready.slice(0, 12),
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LAWBOR · standup</title>
<style>
  :root{ --bg:#0b0e14; --panel:#121722; --line:#1e2735; --ink:#e6edf3; --dim:#8b98a9; --accent:#3b82f6; --good:#22c55e; --warn:#a1751f }
  @media (prefers-color-scheme:light){ :root{ --bg:#f6f8fa; --panel:#fff; --line:#d7dee6; --ink:#0b0e14; --dim:#5a6675 } }
  *{ box-sizing:border-box } body{ margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
  header{ padding:16px 20px; border-bottom:1px solid var(--line) } header b{ font-size:15px } header .sub{ color:var(--dim); margin-left:10px }
  .grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; padding:20px }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px }
  .card .n{ font-size:26px; font-weight:600 } .card .l{ color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.4px }
  .card.jobs .row{ display:flex; justify-content:space-between; font-size:13px; padding:2px 0 } .card.jobs .row b{ font-variant-numeric:tabular-nums }
  .frontier{ padding:0 20px 20px } .frontier .l{ color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.4px; margin-bottom:6px }
  .chip{ display:inline-block; background:var(--panel); border:1px solid var(--accent); color:var(--accent); border-radius:20px; padding:3px 12px; margin:3px; font-size:12px }
  .muted{ color:var(--dim) }
</style></head><body>
<header><b>LAWBOR · standup</b><span class="sub" id="self"></span></header>
<div class="grid" id="grid"></div>
<div class="frontier"><div class="l">ready job frontier (claimable now)</div><div id="frontier"></div></div>
<script>
function card(n,l){ return '<div class="card"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }
async function tick(){
  try{ const r=await fetch('/app/standup/data',{cache:'no-store'}); const d=await r.json();
    document.getElementById('self').textContent = d.self;
    const j=d.jobs;
    document.getElementById('grid').innerHTML =
      card(d.messages,'messages')+card(d.inbox,'inbox')+card(d.requests,'requests')+
      card(d.botActivity,'bot activity')+card(d.blocked,'blocked addrs')+
      '<div class="card jobs"><div class="l">jobs</div>'+
        '<div class="row"><span>total</span><b>'+j.total+'</b></div>'+
        '<div class="row"><span style="color:var(--accent)">ready</span><b>'+j.ready+'</b></div>'+
        '<div class="row"><span style="color:var(--warn)">blocked</span><b>'+j.blocked+'</b></div>'+
        '<div class="row"><span style="color:var(--good)">awarded</span><b>'+j.awarded+'</b></div>'+
        '<div class="row"><span class="muted">cancelled</span><b>'+j.cancelled+'</b></div></div>';
    document.getElementById('frontier').innerHTML = d.readyFrontier.length
      ? d.readyFrontier.map(function(x){ return '<span class="chip">'+x+'</span>'; }).join('')
      : '<span class="muted">nothing ready — no open job whose dependencies are all met</span>';
  }catch(e){}
}
tick(); setInterval(tick, 3000);
</script></body></html>`;

module.exports = {
  name: 'standup',
  description: 'a read-only daily digest of this node — traffic, waiting conversations, and the job-graph shape',
  _report: report,
  routes: [
    { method: 'GET', path: '/', handle: () => ({ contentType: 'text/html; charset=utf-8', body: PAGE }) },
    { method: 'GET', path: '/data', handle: (ctx) => ({ body: report(ctx) }) },
  ],
  tools: [
    { name: 'report', description: 'READ-ONLY: a digest of this node — message/inbox/requests/bot-activity counts, blocked-address count, the job graph (total/ready/blocked/awarded/cancelled), and the ready job frontier. A bot reads this to know its own state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handle: (_args, ctx) => report(ctx) },
  ],
};
