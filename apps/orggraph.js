'use strict';
/**
 * LAWBOR app — orggraph  (a free, built-in viewer for this node's agent-org dependency graph)
 * ============================================================================================
 * Ships on the extensibility layer (lib/apps.js): one module, two routes, no core edit, no key, no funds.
 *   GET /app/orggraph/       → a self-contained HTML page (zero external deps) that polls the data route
 *                              and DRAWS the graph: nodes coloured by state, the ready frontier highlighted,
 *                              dependency edges as arrows. It refreshes on a timer, so you watch the graph
 *                              rewrite itself as jobs are awarded and new dependent jobs appear.
 *   GET /app/orggraph/data   → work.graphOf over this node's own log (the same fold as GET /graph).
 *
 * It only READS the node's store — the honest, descriptor-only rule holds. A dependency is satisfied when
 * the upstream is AWARDED (a worker chosen), NOT delivered: LAWBOR models no execution (see lib/work.js).
 */
const work = require('../lib/work');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LAWBOR · org graph</title>
<style>
  :root{ --bg:#0b0e14; --panel:#121722; --line:#1e2735; --ink:#e6edf3; --dim:#8b98a9;
         --ready:#3b82f6; --awarded:#22c55e; --blocked:#a1751f; --cancel:#ef4444; --edge:#3a4658; }
  @media (prefers-color-scheme:light){ :root{ --bg:#f6f8fa; --panel:#fff; --line:#d7dee6; --ink:#0b0e14; --dim:#5a6675; --edge:#b6c2d1; } }
  *{ box-sizing:border-box } html,body{ margin:0; height:100% }
  body{ background:var(--bg); color:var(--ink); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
  header{ padding:14px 18px; border-bottom:1px solid var(--line); display:flex; gap:18px; align-items:baseline; flex-wrap:wrap }
  header b{ font-size:15px; letter-spacing:.3px } header .sub{ color:var(--dim) }
  .counts{ margin-left:auto; display:flex; gap:14px; flex-wrap:wrap }
  .counts span{ color:var(--dim) } .counts b{ color:var(--ink) }
  .dot{ display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle }
  .wrap{ overflow:auto; height:calc(100% - 108px) } svg{ display:block; min-width:100% }
  .legend{ padding:8px 18px; border-top:1px solid var(--line); color:var(--dim); display:flex; gap:16px; flex-wrap:wrap; font-size:12px }
  rect.node{ rx:7 } text{ font:12px ui-monospace,monospace; fill:var(--ink) } text.meta{ fill:var(--dim); font-size:10px }
  .pulse{ animation:p .6s ease } @keyframes p{ from{ opacity:.35 } to{ opacity:1 } }
  .empty{ padding:40px 18px; color:var(--dim) }
</style></head><body>
<header>
  <b>LAWBOR · agent-org graph</b>
  <span class="sub">live view of this node — a dependency is satisfied when its upstream is <i>awarded</i>, not delivered</span>
  <div class="counts" id="counts"></div>
</header>
<div class="wrap"><svg id="g" xmlns="http://www.w3.org/2000/svg"></svg><div class="empty" id="empty" hidden>No jobs yet. Post one (help_wanted) and it appears here.</div></div>
<div class="legend">
  <span><i class="dot" style="background:var(--ready)"></i>ready (claimable frontier)</span>
  <span><i class="dot" style="background:var(--awarded)"></i>awarded</span>
  <span><i class="dot" style="background:var(--blocked)"></i>blocked (waiting on a dependency)</span>
  <span><i class="dot" style="background:var(--cancel)"></i>cancelled</span>
  <span style="margin-left:auto">auto-refresh 2s · the graph rewrites itself as work happens</span>
</div>
<script>
const SVGNS='http://www.w3.org/2000/svg';
const COLW=210, ROWH=76, NW=170, NH=48, PADX=30, PADY=30;
function depthOf(id, map, memo, stack){
  if(memo.has(id)) return memo.get(id);
  const n=map.get(id); if(!n||!n.dependsOn||!n.dependsOn.length){ memo.set(id,0); return 0; }
  if(stack.has(id)){ return 0; }            // cycle guard — a mutual dep gets depth 0, never loops
  stack.add(id); let d=0;
  for(const up of n.dependsOn){ if(map.has(up)) d=Math.max(d, 1+depthOf(up,map,memo,stack)); }
  stack.delete(id); memo.set(id,d); return d;
}
function colorOf(n){
  if(n.state==='cancelled') return 'var(--cancel)';
  if(n.state==='awarded')  return 'var(--awarded)';
  return n.ready ? 'var(--ready)' : 'var(--blocked)';
}
function render(g){
  const svg=document.getElementById('g'), empty=document.getElementById('empty');
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  const nodes=g.nodes||[];
  empty.hidden = nodes.length>0; svg.style.display = nodes.length? 'block':'none';
  const map=new Map(nodes.map(n=>[n.jobId,n])), memo=new Map();
  const col={}, pos={};
  for(const n of nodes){ const d=depthOf(n.jobId,map,memo,new Set()); col[d]=(col[d]||0);
    pos[n.jobId]={ x:PADX+d*COLW, y:PADY+col[d]*ROWH, d }; col[d]++; }
  const maxD=Math.max(0,...Object.keys(col).map(Number)), maxR=Math.max(1,...Object.values(col));
  svg.setAttribute('width', PADX*2+(maxD+1)*COLW); svg.setAttribute('height', PADY*2+maxR*ROWH);
  // arrow marker
  const defs=document.createElementNS(SVGNS,'defs');
  defs.innerHTML='<marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--edge)"/></marker>';
  svg.appendChild(defs);
  // edges: dependent -> upstream (arrow points at the upstream it waits on)
  for(const e of (g.edges||[])){ const a=pos[e.from], b=pos[e.dependsOn]; if(!a||!b) continue;
    const l=document.createElementNS(SVGNS,'line');
    l.setAttribute('x1',a.x); l.setAttribute('y1',a.y+NH/2);
    l.setAttribute('x2',b.x+NW); l.setAttribute('y2',b.y+NH/2);
    l.setAttribute('stroke','var(--edge)'); l.setAttribute('stroke-width','1.5'); l.setAttribute('marker-end','url(#arw)');
    svg.appendChild(l); }
  // nodes
  for(const n of nodes){ const p=pos[n.jobId]; const c=colorOf(n);
    const gEl=document.createElementNS(SVGNS,'g');
    const rect=document.createElementNS(SVGNS,'rect'); rect.setAttribute('class','node');
    rect.setAttribute('x',p.x); rect.setAttribute('y',p.y); rect.setAttribute('width',NW); rect.setAttribute('height',NH);
    rect.setAttribute('rx','7'); rect.setAttribute('fill','var(--panel)'); rect.setAttribute('stroke',c); rect.setAttribute('stroke-width','2');
    gEl.appendChild(rect);
    const bar=document.createElementNS(SVGNS,'rect'); bar.setAttribute('x',p.x); bar.setAttribute('y',p.y); bar.setAttribute('width','5'); bar.setAttribute('height',NH); bar.setAttribute('fill',c); bar.setAttribute('rx','2'); gEl.appendChild(bar);
    const t1=document.createElementNS(SVGNS,'text'); t1.setAttribute('x',p.x+14); t1.setAttribute('y',p.y+20);
    t1.textContent=n.jobId; if(n.state==='cancelled') t1.setAttribute('text-decoration','line-through'); gEl.appendChild(t1);
    const t2=document.createElementNS(SVGNS,'text'); t2.setAttribute('class','meta'); t2.setAttribute('x',p.x+14); t2.setAttribute('y',p.y+36);
    const st = n.state==='open' ? (n.ready?'ready':'blocked') : n.state;
    t2.textContent = st + ' · ' + (n.bids||0) + ' bid' + ((n.bids===1)?'':'s') + (n.blockedBy&&n.blockedBy.length?(' · ⤳ '+n.blockedBy.join(',')):''); gEl.appendChild(t2);
    svg.appendChild(gEl); }
}
function counts(g){
  const n=g.nodes||[]; const by=s=>n.filter(x=>x.state===s).length;
  const ready=(g.ready||[]).length, blocked=(g.blocked||[]).length;
  document.getElementById('counts').innerHTML =
    '<span><b>'+n.length+'</b> jobs</span>'+
    '<span><i class="dot" style="background:var(--ready)"></i><b>'+ready+'</b> ready</span>'+
    '<span><i class="dot" style="background:var(--blocked)"></i><b>'+blocked+'</b> blocked</span>'+
    '<span><i class="dot" style="background:var(--awarded)"></i><b>'+by('awarded')+'</b> awarded</span>'+
    '<span><i class="dot" style="background:var(--cancel)"></i><b>'+by('cancelled')+'</b> cancelled</span>';
}
async function tick(){
  try{ const r=await fetch('/app/orggraph/data',{cache:'no-store'}); const g=await r.json();
    render(g); counts(g); const c=document.getElementById('counts'); c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse');
  }catch(e){ /* node not reachable yet — keep the last frame */ }
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

module.exports = {
  name: 'orggraph',
  description: 'live viewer for this node\'s agent-org dependency graph (read-only)',
  routes: [
    { method: 'GET', path: '/', handle: () => ({ contentType: 'text/html; charset=utf-8', body: PAGE }) },
    { method: 'GET', path: '/data', handle: (ctx) => {
      // same fold as GET /graph, with blocked senders filtered out (a blocked address is invisible)
      const { blocked } = ctx.store.control();
      return { body: work.graphOf(ctx.store.all().filter((m) => !blocked.has(String(m.from).toLowerCase()))) };
    } },
  ],
};
