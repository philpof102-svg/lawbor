'use strict';
/**
 * LAWBOR app — messenger  (the PRODUCT's face: humans talking through their bots)
 * ================================================================================================
 * Everything else on this node is plumbing or a view of the plumbing. This is the thing itself: a
 * messaging app where a person writes, THEIR bot relays it, the receiving bot reputation-gates the
 * sender, and only then does it reach the other person. Three views, exactly as the store models them:
 *   INBOX     — conversations with people you've accepted or already written to
 *   REQUESTS  — first contact from a stranger, QUARANTINED until you accept or reply (the consent gate)
 *   WATCH     — what your bot is autonomously saying to other bots (the transparency feed)
 *
 * What makes it LAWBOR and not a chat app: every inbound message shows the sender's REPUTATION SCORE
 * and whether their address was cryptographically AUTHENTICATED. A sub-floor sender never arrives at
 * all (the relay drops them before storage) — so an empty Requests tab is a feature, not a bug.
 *
 * It drives the node's own endpoints (/inbox, /requests, /bot-activity, /thread, /say, /accept, /block),
 * holds no key and signs nothing: /say returns an EIP-712 descriptor the operator signs.
 *   GET /app/messenger/    → the app
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LAWBOR · messenger</title>
<style>
  :root{ --bg:#0b0e14; --panel:#121722; --line:#1e2735; --ink:#e6edf3; --dim:#8b98a9;
         --me:#1d4ed8; --them:#1b2432; --ok:#22c55e; --warn:#a1751f; --bad:#ef4444; --accent:#3b82f6 }
  @media (prefers-color-scheme:light){ :root{ --bg:#f6f8fa; --panel:#fff; --line:#d7dee6; --ink:#0b0e14; --dim:#5a6675; --them:#eef2f6 } }
  *{ box-sizing:border-box } html,body{ margin:0; height:100% }
  body{ background:var(--bg); color:var(--ink); font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; display:flex; flex-direction:column }
  header{ padding:12px 16px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:14px; flex-wrap:wrap }
  header b{ font-size:15px } header .me{ color:var(--dim); font-size:12px }
  .tabs{ display:flex; gap:6px; margin-left:auto }
  .tab{ background:none; border:1px solid var(--line); color:var(--dim); border-radius:20px; padding:4px 14px; cursor:pointer; font:inherit; font-size:12px }
  .tab.on{ color:var(--ink); border-color:var(--accent) } .tab .badge{ color:var(--warn); font-weight:700 }
  main{ flex:1; display:flex; min-height:0 }
  .list{ width:270px; border-right:1px solid var(--line); overflow-y:auto }
  .item{ padding:11px 14px; border-bottom:1px solid var(--line); cursor:pointer }
  .item:hover{ background:var(--panel) } .item.on{ background:var(--panel); border-left:3px solid var(--accent) }
  .item .who{ font-size:12px } .item .last{ color:var(--dim); font-size:11px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .pane{ flex:1; display:flex; flex-direction:column; min-width:0 }
  .msgs{ flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px }
  .bub{ max-width:74%; padding:8px 12px; border-radius:12px; background:var(--them); word-wrap:break-word }
  .bub.mine{ align-self:flex-end; background:var(--me); color:#fff }
  .bub .meta{ font-size:10px; opacity:.75; margin-top:4px }
  .tagr{ display:inline-block; font-size:10px; padding:0 5px; border-radius:8px; border:1px solid currentColor; margin-left:5px }
  .ok{ color:var(--ok) } .warn{ color:var(--warn) } .bad{ color:var(--bad) }
  .composer{ border-top:1px solid var(--line); padding:10px; display:flex; gap:8px }
  .composer input,.composer textarea{ background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; font-size:13px }
  .composer textarea{ flex:1; resize:none; height:38px }
  button.go{ background:var(--accent); color:#fff; border:none; border-radius:8px; padding:8px 16px; cursor:pointer; font:inherit; font-size:13px }
  button.ghost{ background:none; color:var(--dim); border:1px solid var(--line); border-radius:8px; padding:6px 12px; cursor:pointer; font:inherit; font-size:12px }
  .gate{ padding:10px 14px; border-bottom:1px solid var(--line); background:var(--panel); font-size:12px; color:var(--dim); display:flex; gap:10px; align-items:center; flex-wrap:wrap }
  /* a class selector beats the UA [hidden]{display:none}: without this, display:flex above keeps the
     quarantine banner on screen after you accept. Same bug class as .empty in orggraph — fix the CLASS,
     not the instance: any element we toggle with [hidden] AND style with display: needs this pair. */
  .gate[hidden]{ display:none }
  .empty{ margin:auto; color:var(--dim); text-align:center; padding:24px; max-width:44ch }
  /* a work message is an ordinary envelope whose body is typed JSON — render it as a job card, not raw
     JSON, so the NEGOTIATION happens inside the conversation instead of in a separate graph app. */
  .job{ border:1px solid var(--accent); border-radius:12px; padding:9px 12px; background:var(--panel); max-width:78% }
  .job.mine{ align-self:flex-end } .job .k{ font-size:10px; color:var(--accent); letter-spacing:.5px }
  .job .t{ margin:3px 0 } .job .id{ color:var(--dim); font-size:11px }
  .job .act{ margin-top:7px; display:flex; gap:6px }
  .jobbar{ padding:8px 10px; border-top:1px solid var(--line); display:flex; gap:6px; align-items:center; flex-wrap:wrap }
  .jobbar input{ background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:6px 9px; font:inherit; font-size:12px; min-width:0 }
  .newbar{ padding:10px; border-bottom:1px solid var(--line); display:flex; gap:8px }
  .newbar input{ background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:7px 10px; font:inherit; font-size:12px }
  .newbar input.addr{ flex:1 } .toast{ padding:6px 14px; font-size:12px; color:var(--dim); border-top:1px solid var(--line) }
  .newbar input{ min-width:0 }   /* flex items default to min-width:auto and force a horizontal scrollbar */
  /* Narrow viewport (a messenger unusable at 530px is unusable on a phone): stack the thread list above
     the conversation instead of squeezing the pane down to a one-word-per-line column. */
  @media (max-width:760px){
    main{ flex-direction:column }
    /* flex:0 0 auto — without it .pane{flex:1} shrinks the list to ~1px (it still has items, they are
       just invisible). Measured, not guessed: listHeight came back as 1. */
    .list{ width:100%; flex:0 0 auto; max-height:30vh; border-right:none; border-bottom:1px solid var(--line) }
    .bub{ max-width:88% }
    .newbar{ flex-wrap:wrap } .newbar input{ flex:1 1 160px }
    header{ gap:8px } .tabs{ margin-left:0 }
  }
</style></head><body>
<header>
  <b>LAWBOR · messenger</b>
  <span class="me" id="me">…</span>
  <div class="tabs">
    <button class="tab on" data-v="inbox">Inbox</button>
    <button class="tab" data-v="requests">Requests <span class="badge" id="rbadge"></span></button>
    <button class="tab" data-v="bot">Watch my bot</button>
  </div>
</header>
<div class="newbar">
  <input class="addr" id="naddr" placeholder="0x… address of the bot you want to reach">
  <input id="nbody" placeholder="first message" style="flex:2">
  <button class="go" id="nsend">Send</button>
</div>
<main>
  <div class="list" id="list"></div>
  <div class="pane">
    <div class="gate" id="gate" hidden></div>
    <div class="msgs" id="msgs"><div class="empty">Pick a conversation, or write to a new address above.<br><br>A stranger's first message lands in <b>Requests</b>, not here — that's the consent gate.</div></div>
    <div class="composer"><textarea id="body" placeholder="write as the human (your bot relays it)"></textarea><button class="go" id="send">Send</button></div>
    <div class="jobbar" id="jobbar" hidden>
      <span style="color:var(--dim);font-size:11px">propose work →</span>
      <input id="jid" placeholder="job id" style="width:110px">
      <input id="jtask" placeholder="what needs doing" style="flex:1">
      <button class="ghost" id="jpost">Post job</button>
    </div>
    <div class="toast" id="toast"></div>
  </div>
</main>
<script>
var view='inbox', sel=null, self='', threads={inbox:[],requests:[],bot:[]}, lastHash='';
/* jobState: jobId -> the FOLD's state, never the sender's word. A settle message says "I paid";
 * only the fold (which checked the tx against Base) says whether it is true, and the card shows that.
 * standing: addr -> usdc micro THIS node itself verifiably paid them. There is no global score to show;
 * this is our own history with them and nothing else. */
var jobState={}, standing={}, verifies=false;
function $(i){ return document.getElementById(i); }
function short(a){ a=String(a||''); return a.slice(0,6)+'…'+a.slice(-4); }
function peerOf(t){ for(var i=0;i<(t.peers||[]).length;i++){ if(String(t.peers[i]).toLowerCase()!==self.toLowerCase()) return t.peers[i]; } return t.peers&&t.peers[0]||''; }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function toast(m){ $('toast').textContent=m; }

// ---- work messages: an ordinary envelope whose body is typed JSON (lib/work.js) --------------------
function asWork(b){ try{ if(typeof b!=='string'||b.charAt(0)!=='{') return null; var o=JSON.parse(b); return (o['lawbor.work']===1&&o.kind)?o:null; }catch(e){ return null; } }
/** Thread-list preview: a work message must never show as raw JSON in the sidebar (it did).
 *  NOTE the store truncates a thread's "last" to 80 chars, so for a work body the JSON arrives CUT and
 *  JSON.parse always throws — parsing it was the bug. Read the fields off the text instead.
 *  (No backticks anywhere in here: this whole page is one template literal.) */
function preview(b){
  if(typeof b!=='string' || b.indexOf('"lawbor.work"')<0) return b;
  var kind=(b.match(/"kind":"([a-z_]+)"/)||[])[1]||'work';
  var job=(b.match(/"jobId":"([^"]*)"/)||[])[1]||'';
  var task=(b.match(/"task":"([^"]*)"/)||[])[1]||'';
  var price=(b.match(/"price":"([^"]*)"/)||[])[1]||'';
  if(kind==='help_wanted') return '📋 job: '+(task||job);
  if(kind==='bid') return '💬 bid '+price+(job?' on '+job:'');
  if(kind==='award') return '✅ awarded '+job;
  if(kind==='cancel') return '✖ cancelled '+job;
  if(kind==='settle') return '💵 paid '+job;
  return kind+' '+job;
}
/* usdc micro-units -> a readable amount. Kept exact: these are the numbers a person decides money on,
 * so no rounding that could show 0.99 as 1. */
function usdc(micro){
  var s=String(micro||'0'); while(s.length<7) s='0'+s;
  var whole=s.slice(0,-6), frac=s.slice(-6).replace(/0+$/,'');
  return whole+(frac?'.'+frac:'')+' USDC';
}
function jobCard(w, mine, from, tags){
  var head={help_wanted:'JOB OFFERED', bid:'BID', award:'AWARDED', cancel:'CANCELLED', settle:'PAID'}[w.kind]||w.kind;
  var body='';
  if(w.kind==='help_wanted') body=esc(w.task||'')+(w.dependsOn&&w.dependsOn.length?'<div class="id">waits on: '+esc(w.dependsOn.join(', '))+'</div>':'');
  else if(w.kind==='bid') body=esc(w.price||'')+(w.eta?' · '+esc(w.eta):'');
  else if(w.kind==='award') body='to '+esc(short(w.worker))+' · '+esc(w.price||'');
  else if(w.kind==='cancel') body=esc(w.reason||'');
  else if(w.kind==='settle'){
    // The claim is a POINTER to a chain fact, so we show the hash and let anyone check it themselves.
    // The state shown is the fold's, never the sender's word: an unverified claim must not look paid.
    var v=(jobState[w.jobId]==='settled');
    body=usdc(w.amountMicro)+'<div class="id">'+(v?'✓ verified on Base':'⏳ not verified here yet — confers nothing')+'</div>'+
         '<div class="id"><a href="https://basescan.org/tx/'+esc(w.txHash||'')+'" target="_blank" rel="noopener noreferrer">'+esc(short(w.txHash||''))+'</a></div>'+
         '<div class="id" style="opacity:.7">paid — not delivered, and not a judgement of the work</div>';
  }
  // the only actions offered are the ones the actor rules would actually allow (mayApply gates them for real)
  var act='';
  if(w.kind==='help_wanted' && !mine) act='<button class="ghost" data-act="bid" data-job="'+esc(w.jobId)+'">Bid on this</button>';
  if(w.kind==='bid' && !mine) act='<button class="ghost" data-act="award" data-job="'+esc(w.jobId)+'" data-worker="'+esc(from)+'" data-price="'+esc(w.price||'')+'">Award to them</button>';
  // only the requester who signed the award is offered "mark paid", and only while the job is awarded
  if(w.kind==='award' && mine && jobState[w.jobId]==='awarded') act='<button class="ghost" data-act="settle" data-job="'+esc(w.jobId)+'">I paid this — attach the tx</button>';
  return '<div class="job'+(mine?' mine':'')+'"><div class="k">'+head+'</div><div class="t">'+body+'</div>'+
         '<div class="id">'+esc(w.jobId)+'</div>'+(act?'<div class="act">'+act+'</div>':'')+
         '<div class="meta" style="font-size:10px;color:var(--dim);margin-top:5px">'+esc(short(from))+tags+'</div></div>';
}
async function work(kind, fields){
  var to=$('body').getAttribute('data-to'), th=$('body').getAttribute('data-thread');
  var payload=Object.assign({to:to, kind:kind, as:'human'}, fields); if(th) payload.thread=th;
  var r=await (await fetch('/work',{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify(payload)})).json();
  if(r.error) return toast('refused by the actor rules: '+r.error);   // mayApply, not the UI, decides
  toast(kind+' sent · delivered:'+r.delivered+' · descriptor signed:false');
  lastHash=''; await load(); if(sel) openThread(sel, true);
}
$('msgs').addEventListener('click', function(e){
  var b=e.target.closest && e.target.closest('button[data-act]'); if(!b) return;
  var a=b.getAttribute('data-act');
  if(a==='bid'){ var p=prompt('your price (e.g. 18 USDC)'); if(p) work('bid',{jobId:b.getAttribute('data-job'), price:p}); }
  if(a==='award') work('award',{jobId:b.getAttribute('data-job'), worker:b.getAttribute('data-worker'), price:b.getAttribute('data-price')});
  if(a==='settle'){
    // LAWBOR moves nothing: the operator pays from their own wallet and then attaches the proof here.
    if(!verifies && !confirm('This node has no Base RPC configured (LAWBOR_RPC_URL), so it cannot verify the tx and the payment will confer no standing. Attach it anyway?')) return;
    var tx=prompt('the Base tx hash of the USDC payment you already sent (0x…)'); if(!tx) return;
    var amt=prompt('the exact USDC amount transferred (e.g. 18.5)'); if(!amt) return;
    var micro=String(Math.round(parseFloat(amt)*1e6));
    if(!/^\d+$/.test(micro)) return toast('that amount is not a number');
    work('settle',{jobId:b.getAttribute('data-job'), txHash:tx.trim(), amountMicro:micro});
  }
});
$('jpost').onclick=function(){
  var id=$('jid').value.trim(), t=$('jtask').value.trim();
  if(!id||!t) return toast('a job needs an id and a task');
  $('jid').value=''; $('jtask').value=''; work('help_wanted',{jobId:id, task:t});
};

async function load(){
  try{
    var h=await (await fetch('/health',{cache:'no-store'})).json();
    self=h.self; $('me').textContent='you: '+short(self)+' · '+h.peers+' peers · floor-gated relay';
    var i=await (await fetch('/inbox',{cache:'no-store'})).json();
    var r=await (await fetch('/requests',{cache:'no-store'})).json();
    var b=await (await fetch('/bot-activity',{cache:'no-store'})).json();
    threads={inbox:i.threads||[], requests:r.threads||[], bot:b.threads||[]};
    $('rbadge').textContent = threads.requests.length ? '('+threads.requests.length+')' : '';
    verifies=!!h.verifiesSettlements;
    var jb=await (await fetch('/jobs',{cache:'no-store'})).json();
    jobState={}; for(var k=0;k<(jb.jobs||[]).length;k++) jobState[jb.jobs[k].jobId]=jb.jobs[k].state;
    var cr=await (await fetch('/credit',{cache:'no-store'})).json();
    standing={};
    for(var d=0;d<(cr.direct||[]).length;d++) standing[cr.direct[d].addr]=cr.direct[d].usdcMicro;
    var hash=JSON.stringify(threads)+JSON.stringify(jobState)+JSON.stringify(standing);
    if(hash!==lastHash){ lastHash=hash; renderList(); if(sel) openThread(sel,true); }
  }catch(e){}
}
function renderList(){
  var ts=threads[view], html='';
  for(var i=0;i<ts.length;i++){
    var p=peerOf(ts[i]);
    html+='<div class="item'+(sel===ts[i].thread?' on':'')+'" data-t="'+ts[i].thread+'" data-p="'+p+'">'+
      '<div class="who">'+esc(short(p))+'</div><div class="last">'+esc(preview(ts[i].last||''))+'</div></div>';
  }
  if(!ts.length) html='<div class="empty" style="font-size:12px">'+(view==='requests'
    ? 'No pending requests. A sub-floor sender never even arrives — the relay drops them before storage.'
    : view==='bot' ? 'Your bot has not spoken autonomously yet.' : 'No conversations yet.')+'</div>';
  $('list').innerHTML=html;
  var items=$('list').querySelectorAll('.item');
  for(var k=0;k<items.length;k++) items[k].addEventListener('click',(function(el){ return function(){ openThread(el.getAttribute('data-t')); }; })(items[k]));
}
async function openThread(id, keep){
  sel=id; if(!keep) renderList();
  var t=null, all=threads[view]; for(var i=0;i<all.length;i++) if(all[i].thread===id) t=all[i];
  var peer=t?peerOf(t):'';
  var g=$('gate');
  if(view==='requests' && peer){
    g.hidden=false;
    g.innerHTML='<span>⚠️ First contact from <b>'+esc(short(peer))+'</b> — quarantined by the consent gate.</span>'+
      '<button class="ghost" id="acc">Accept → move to Inbox</button><button class="ghost" id="blk">Block (total, silent)</button>';
    // switch the view BEFORE reloading: load() re-opens the selected thread asynchronously, and that
    // await used to land AFTER setTab() and repaint the old view's gate over the new one.
    $('acc').onclick=async function(){ await fetch('/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({addr:peer})}); toast('accepted '+short(peer)+' → their thread moves to Inbox'); sel=null; view='inbox'; lastHash=''; setTab(); await load(); };
    $('blk').onclick=async function(){ await fetch('/block',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({addr:peer})}); toast('blocked '+short(peer)+' — dropped before storage, indistinguishable from silence'); sel=null; lastHash=''; setTab(); await load(); };
  } else g.hidden=true;
  try{
    var d=await (await fetch('/thread?id='+encodeURIComponent(id),{cache:'no-store'})).json();
    if(sel!==id) return;   // the user switched tab/thread while this fetch was in flight — don't repaint over them
    var html='';
    for(var j=0;j<(d.messages||[]).length;j++){
      var m=d.messages[j], mine=String(m.from).toLowerCase()===self.toLowerCase();
      var tags='';
      if(!mine){
        tags+= m.authenticated ? '<span class="tagr ok">authenticated</span>' : '<span class="tagr warn">unauthenticated</span>';
        if(m.senderScore!=null) tags+='<span class="tagr ok">score '+m.senderScore+'</span>';
      }
      tags+= m.origin==='bot' ? '<span class="tagr">bot</span>' : '<span class="tagr">human</span>';
      var w=asWork(m.body);
      if(w){ html+=jobCard(w, mine, m.from, tags); continue; }   // a work message renders as a job card
      html+='<div class="bub'+(mine?' mine':'')+'">'+esc(m.body)+'<div class="meta">'+esc(short(m.from))+tags+'</div></div>';
    }
    /* What has THIS person actually been paid BY US, verified on Base. Not a score, not a reputation
     * someone else vouched for — our own settled history, which is the only claim that cannot be farmed
     * by a collusion ring (RATING-DESIGN.md). A zero is shown as "none yet", never as a bad mark. */
    var st=standing[String(peer).toLowerCase()];
    html='<div class="job" style="opacity:.9"><div class="k">SETTLED WITH YOU</div><div class="t">'+
      (st&&st!=='0' ? usdc(st) : 'none yet')+'</div><div class="id">'+
      (st&&st!=='0' ? 'you have verifiably paid them this much on Base' :
        (verifies ? 'you have never paid them — that is not a bad mark, only an absence' :
                    'this node cannot verify payments (no LAWBOR_RPC_URL), so nobody shows standing here'))+
      '</div></div>'+html;
    $('msgs').innerHTML=html||'<div class="empty">no messages</div>';
    $('jobbar').hidden=false;
    $('msgs').scrollTop=$('msgs').scrollHeight;
    // carry BOTH the peer and the THREAD: /say without a thread starts a new one, which would fragment
    // a two-sided conversation into a pile of one-message threads instead of one continuous fil.
    $('body').setAttribute('data-to', peer);
    $('body').setAttribute('data-thread', id);
  }catch(e){}
}
async function send(to, body, thread){
  if(!to||!body) return toast('need an address and a message');
  var payload={to:to, body:body}; if(thread) payload.thread=thread;   // continue the fil, don't start a new one
  var r=await (await fetch('/say',{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify(payload)})).json();
  if(r.error) return toast('refused: '+r.error);
  toast(r.delivered ? 'relayed to '+short(to)+' · descriptor signed:'+(r.sign&&r.sign.signed) : 'NOT delivered'+(r.reason?' ('+r.reason+')':'')+' — the relay gate refused it');
  lastHash=''; await load(); if(sel) openThread(sel, true);
}
$('send').onclick=function(){
  var to=$('body').getAttribute('data-to'), th=$('body').getAttribute('data-thread'), txt=$('body').value;
  $('body').value=''; send(to, txt, th);
};
$('nsend').onclick=function(){ var a=$('naddr').value.trim(), t=$('nbody').value; $('nbody').value=''; send(a, t); };
function setTab(){
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-v')===view);
  sel=null; $('gate').hidden=true; $('jobbar').hidden=true; $('msgs').innerHTML='<div class="empty">Pick a conversation.</div>'; renderList();
}
var tabs=document.querySelectorAll('.tab');
for(var i=0;i<tabs.length;i++) tabs[i].addEventListener('click',(function(el){ return function(){ view=el.getAttribute('data-v'); setTab(); }; })(tabs[i]));
load(); setInterval(load, 2000);
</script></body></html>`;

module.exports = {
  name: 'messenger',
  description: 'the human-facing messaging app — inbox / requests quarantine / watch-my-bot, reputation shown per message',
  routes: [
    { method: 'GET', path: '/', handle: () => ({ contentType: 'text/html; charset=utf-8', body: PAGE }) },
  ],
};
