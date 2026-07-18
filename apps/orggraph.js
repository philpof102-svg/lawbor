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
 * INTERACTION (and the bug it exists to avoid): the page is EXPLORABLE — drag to pan, wheel to zoom,
 * click a node to trace its dependency chain (everything it waits on, and everything waiting on it).
 * The naive version of this re-rendered the whole SVG every 2s, which would wipe your zoom and selection
 * mid-gesture. So camera + selection live OUTSIDE the render, and the DOM is only rebuilt when the graph
 * DATA actually changed (hash compare) — the live refresh never fights the person reading it.
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
  body{ background:var(--bg); color:var(--ink); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; overflow:hidden }
  header{ padding:14px 18px; border-bottom:1px solid var(--line); display:flex; gap:18px; align-items:baseline; flex-wrap:wrap }
  header b{ font-size:15px; letter-spacing:.3px } header .sub{ color:var(--dim) }
  .counts{ margin-left:auto; display:flex; gap:14px; flex-wrap:wrap }
  .counts span{ color:var(--dim) } .counts b{ color:var(--ink) }
  .dot{ display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle }
  .wrap{ position:relative; height:calc(100% - 108px); overflow:hidden; cursor:grab }
  .wrap.panning{ cursor:grabbing } svg{ display:block; width:100%; height:100%; touch-action:none }
  .legend{ padding:8px 18px; border-top:1px solid var(--line); color:var(--dim); display:flex; gap:16px; flex-wrap:wrap; font-size:12px; align-items:center }
  rect.node{ rx:7 } text{ font:12px ui-monospace,monospace; fill:var(--ink) } text.meta{ fill:var(--dim); font-size:10px }
  g.node{ cursor:pointer }
  .dimmed{ opacity:.16 } .traced rect.node{ stroke-width:3 }
  .pulse{ animation:p .6s ease } @keyframes p{ from{ opacity:.35 } to{ opacity:1 } }
  .empty{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--dim); padding:20px; text-align:center }
  /* a class selector beats the UA [hidden]{display:none}, so display:flex above would keep the empty
     state VISIBLE behind a drawn graph. Caught by looking at the page, not by asserting el.hidden. */
  .empty[hidden]{ display:none }
  #panel{ position:absolute; right:14px; top:14px; width:250px; background:var(--panel); border:1px solid var(--line);
          border-radius:10px; padding:12px 14px; font-size:12px; display:none }
  #panel h3{ margin:0 0 6px; font-size:13px } #panel .row{ display:flex; justify-content:space-between; gap:10px; padding:2px 0; color:var(--dim) }
  #panel .row b{ color:var(--ink); font-weight:600; text-align:right; word-break:break-all }
  #panel .close{ position:absolute; right:10px; top:8px; cursor:pointer; color:var(--dim) }
  button.ctl{ background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:3px 10px; cursor:pointer; font:inherit; font-size:11px }
  @media (prefers-reduced-motion:reduce){ .pulse{ animation:none } }
</style></head><body>
<header>
  <b>LAWBOR · agent-org graph</b>
  <span class="sub">live view of this node — a dependency is satisfied when its upstream is <i>awarded</i>, not delivered</span>
  <div class="counts" id="counts"></div>
</header>
<div class="wrap" id="wrap">
  <svg id="g" xmlns="http://www.w3.org/2000/svg"><g id="cam"></g></svg>
  <div class="empty" id="empty" hidden>No jobs yet. Post one (help_wanted) and it appears here.</div>
  <div id="panel"><span class="close" id="pclose">✕</span><h3 id="ptitle"></h3><div id="pbody"></div></div>
</div>
<div class="legend">
  <span><i class="dot" style="background:var(--ready)"></i>ready (claimable frontier)</span>
  <span><i class="dot" style="background:var(--awarded)"></i>awarded</span>
  <span><i class="dot" style="background:var(--blocked)"></i>blocked (waiting on a dependency)</span>
  <span><i class="dot" style="background:var(--cancel)"></i>cancelled</span>
  <button class="ctl" id="reset">reset view</button>
  <span style="margin-left:auto">drag to pan · wheel to zoom · click a node to trace its chain · auto-refresh 2s</span>
</div>
<script>
var SVGNS='http://www.w3.org/2000/svg';
var COLW=210, ROWH=76, NW=170, NH=48, PADX=30, PADY=30;
// camera + selection live OUTSIDE render() so a 2s data refresh never wipes an in-progress gesture
var cam={x:0,y:0,k:1}, selected=null, lastHash='', lastGraph={nodes:[],edges:[]}, pos={};
var svg=document.getElementById('g'), camEl=document.getElementById('cam'), wrap=document.getElementById('wrap');

function depthOf(id, map, memo, stack){
  if(memo.has(id)) return memo.get(id);
  var n=map.get(id); if(!n||!n.dependsOn||!n.dependsOn.length){ memo.set(id,0); return 0; }
  if(stack.has(id)) return 0;                 // cycle guard — a mutual dep gets depth 0, never loops
  stack.add(id); var d=0;
  for(var i=0;i<n.dependsOn.length;i++){ var up=n.dependsOn[i]; if(map.has(up)) d=Math.max(d,1+depthOf(up,map,memo,stack)); }
  stack.delete(id); memo.set(id,d); return d;
}
function colorOf(n){
  if(n.state==='cancelled') return 'var(--cancel)';
  if(n.state==='awarded') return 'var(--awarded)';
  return n.ready ? 'var(--ready)' : 'var(--blocked)';
}
function applyCam(){ camEl.setAttribute('transform','translate('+cam.x+','+cam.y+') scale('+cam.k+')'); }

// the traced set = everything this node waits on (transitively) + everything waiting on it. Cycle-safe.
function chainOf(id, g){
  var deps={}, dependents={}, i;
  for(i=0;i<g.nodes.length;i++) deps[g.nodes[i].jobId]=g.nodes[i].dependsOn||[];
  for(var k in deps){ for(i=0;i<deps[k].length;i++){ (dependents[deps[k][i]]=dependents[deps[k][i]]||[]).push(k); } }
  var seen={}; seen[id]=true;
  function walk(cur, map){ var q=[cur]; while(q.length){ var c=q.pop(); var nx=map[c]||[]; for(var j=0;j<nx.length;j++){ if(!seen[nx[j]]){ seen[nx[j]]=true; q.push(nx[j]); } } } }
  walk(id, deps); walk(id, dependents);
  return seen;
}
function applySelection(){
  var g=lastGraph, traced=selected? chainOf(selected,g) : null;
  var groups=camEl.querySelectorAll('g.node'), lines=camEl.querySelectorAll('line.edge'), i;
  for(i=0;i<groups.length;i++){
    var id=groups[i].getAttribute('data-id');
    groups[i].classList.toggle('dimmed', !!traced && !traced[id]);
    groups[i].classList.toggle('traced', !!traced && !!traced[id]);
  }
  for(i=0;i<lines.length;i++){
    var a=lines[i].getAttribute('data-from'), b=lines[i].getAttribute('data-to');
    lines[i].classList.toggle('dimmed', !!traced && !(traced[a] && traced[b]));
  }
  var panel=document.getElementById('panel');
  if(!selected){ panel.style.display='none'; return; }
  var n=null; for(i=0;i<g.nodes.length;i++) if(g.nodes[i].jobId===selected) n=g.nodes[i];
  if(!n){ panel.style.display='none'; return; }
  var st = n.state==='open' ? (n.ready?'ready':'blocked') : n.state;
  document.getElementById('ptitle').textContent=n.jobId;
  document.getElementById('pbody').innerHTML=
    row('state', st) + row('requester', (n.requester||'').slice(0,10)+'…') + row('bids', n.bids||0) +
    row('depends on', (n.dependsOn&&n.dependsOn.length)? n.dependsOn.join(', ') : '—') +
    row('blocked by', (n.blockedBy&&n.blockedBy.length)? n.blockedBy.join(', ') : '—');
  panel.style.display='block';
}
function row(l,v){ return '<div class="row"><span>'+l+'</span><b>'+String(v)+'</b></div>'; }

function render(g){
  lastGraph=g;
  var empty=document.getElementById('empty'), nodes=g.nodes||[];
  while(camEl.firstChild) camEl.removeChild(camEl.firstChild);
  empty.hidden = nodes.length>0;
  if(!nodes.length) return;
  var map=new Map(), memo=new Map(), i;
  for(i=0;i<nodes.length;i++) map.set(nodes[i].jobId, nodes[i]);
  var col={}; pos={};
  for(i=0;i<nodes.length;i++){
    var d=depthOf(nodes[i].jobId,map,memo,new Set()); col[d]=col[d]||0;
    pos[nodes[i].jobId]={ x:PADX+d*COLW, y:PADY+col[d]*ROWH }; col[d]++;
  }
  var defs=document.createElementNS(SVGNS,'defs');
  defs.innerHTML='<marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--edge)"/></marker>';
  camEl.appendChild(defs);
  var edges=g.edges||[];
  for(i=0;i<edges.length;i++){
    var a=pos[edges[i].from], b=pos[edges[i].dependsOn]; if(!a||!b) continue;
    var l=document.createElementNS(SVGNS,'line'); l.setAttribute('class','edge');
    l.setAttribute('data-from',edges[i].from); l.setAttribute('data-to',edges[i].dependsOn);
    l.setAttribute('x1',a.x); l.setAttribute('y1',a.y+NH/2);
    l.setAttribute('x2',b.x+NW); l.setAttribute('y2',b.y+NH/2);
    l.setAttribute('stroke','var(--edge)'); l.setAttribute('stroke-width','1.5'); l.setAttribute('marker-end','url(#arw)');
    camEl.appendChild(l);
  }
  for(i=0;i<nodes.length;i++){
    var n=nodes[i], p=pos[n.jobId], c=colorOf(n);
    var gEl=document.createElementNS(SVGNS,'g'); gEl.setAttribute('class','node'); gEl.setAttribute('data-id',n.jobId);
    var rect=document.createElementNS(SVGNS,'rect'); rect.setAttribute('class','node');
    rect.setAttribute('x',p.x); rect.setAttribute('y',p.y); rect.setAttribute('width',NW); rect.setAttribute('height',NH);
    rect.setAttribute('rx','7'); rect.setAttribute('fill','var(--panel)'); rect.setAttribute('stroke',c); rect.setAttribute('stroke-width','2');
    gEl.appendChild(rect);
    var bar=document.createElementNS(SVGNS,'rect'); bar.setAttribute('x',p.x); bar.setAttribute('y',p.y);
    bar.setAttribute('width','5'); bar.setAttribute('height',NH); bar.setAttribute('fill',c); bar.setAttribute('rx','2'); gEl.appendChild(bar);
    var t1=document.createElementNS(SVGNS,'text'); t1.setAttribute('x',p.x+14); t1.setAttribute('y',p.y+20);
    t1.textContent=n.jobId; if(n.state==='cancelled') t1.setAttribute('text-decoration','line-through'); gEl.appendChild(t1);
    var t2=document.createElementNS(SVGNS,'text'); t2.setAttribute('class','meta'); t2.setAttribute('x',p.x+14); t2.setAttribute('y',p.y+36);
    var st = n.state==='open' ? (n.ready?'ready':'blocked') : n.state;
    t2.textContent = st+' · '+(n.bids||0)+' bid'+((n.bids===1)?'':'s')+((n.blockedBy&&n.blockedBy.length)?(' · ⤳ '+n.blockedBy.join(',')):'');
    gEl.appendChild(t2);
    gEl.addEventListener('click', (function(id){ return function(ev){ ev.stopPropagation(); selected=(selected===id)?null:id; applySelection(); }; })(n.jobId));
    camEl.appendChild(gEl);
  }
  applySelection();
}
function counts(g){
  var n=g.nodes||[]; function by(s){ var c=0; for(var i=0;i<n.length;i++) if(n[i].state===s) c++; return c; }
  document.getElementById('counts').innerHTML =
    '<span><b>'+n.length+'</b> jobs</span>'+
    '<span><i class="dot" style="background:var(--ready)"></i><b>'+((g.ready||[]).length)+'</b> ready</span>'+
    '<span><i class="dot" style="background:var(--blocked)"></i><b>'+((g.blocked||[]).length)+'</b> blocked</span>'+
    '<span><i class="dot" style="background:var(--awarded)"></i><b>'+by('awarded')+'</b> awarded</span>'+
    '<span><i class="dot" style="background:var(--cancel)"></i><b>'+by('cancelled')+'</b> cancelled</span>';
}
// ---- pan / zoom (camera only — never triggers a re-render) ----
var drag=null;
wrap.addEventListener('mousedown', function(e){ drag={x:e.clientX,y:e.clientY,ox:cam.x,oy:cam.y}; wrap.classList.add('panning'); });
window.addEventListener('mousemove', function(e){ if(!drag) return; cam.x=drag.ox+(e.clientX-drag.x); cam.y=drag.oy+(e.clientY-drag.y); applyCam(); });
window.addEventListener('mouseup', function(){ drag=null; wrap.classList.remove('panning'); });
wrap.addEventListener('click', function(){ if(selected){ selected=null; applySelection(); } });
wrap.addEventListener('wheel', function(e){
  e.preventDefault();
  var r=wrap.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
  var f=e.deltaY<0?1.12:1/1.12, nk=Math.max(0.25,Math.min(3,cam.k*f)); f=nk/cam.k;
  cam.x=mx-(mx-cam.x)*f; cam.y=my-(my-cam.y)*f; cam.k=nk; applyCam();   // zoom anchored at the cursor
},{passive:false});
document.getElementById('reset').addEventListener('click', function(){ cam={x:0,y:0,k:1}; applyCam(); });
document.getElementById('pclose').addEventListener('click', function(){ selected=null; applySelection(); });
window.addEventListener('keydown', function(e){ if(e.key==='Escape'&&selected){ selected=null; applySelection(); } });

async function tick(){
  try{
    var r=await fetch('/app/orggraph/data',{cache:'no-store'}); var g=await r.json();
    var h=JSON.stringify(g.nodes)+'|'+JSON.stringify(g.edges);
    if(h!==lastHash){ lastHash=h; render(g); }   // rebuild ONLY on real change — never fight the reader
    else { lastGraph=g; }
    counts(g);
    var c=document.getElementById('counts'); c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse');
  }catch(e){ /* node unreachable — keep the last frame */ }
}
applyCam(); tick(); setInterval(tick, 2000);
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
