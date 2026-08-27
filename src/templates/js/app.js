let page=1, perPage=50;
function qs(){const p=new URLSearchParams();
  const v=(id)=>document.getElementById(id).value.trim();
  if(v('f-level'))p.set('level',v('f-level'));
  if(v('f-event'))p.set('event',v('f-event'));
  if(v('f-decision'))p.set('decision',v('f-decision'));
  if(v('f-chat'))p.set('chat_id',v('f-chat'));
  if(v('f-user'))p.set('user_id',v('f-user'));
  if(v('f-from'))p.set('from',v('f-from'));
  if(v('f-to'))p.set('to',v('f-to'));
  if(v('f-q'))p.set('q',v('f-q'));
  return p;}
function esc(s){return (s==null?'':String(s))
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;');}
function badge(kind,label){return '<span class="badge '+kind+'">'+esc(label)+'</span>';}
function levelBadge(l){return badge(l, l||'—');}
function decisionBadge(d){return d==='delete'?badge('delete','delete')
  :d==='keep'?badge('keep','keep'):'<span class="mono">—</span>';}
/**
 * Shorten a provider URL to a recognizable host label.
 *   https://gateway.ai.cloudflare.com/...  -> cloudflare
 *   https://api.cline.bot/api/v1            -> cline
 *   https://api.openai.com/v1               -> openai
 *   https://openrouter.ai/api/v1            -> openrouter
 *   https://api.rntm.sh/v1                  -> rntm
 * Strategy: strip common subdomains (api., gateway., compat.), then
 * prefer the second-to-last label so ai.X.com style hosts surface the
 * brand, not the literal 'ai'. Two-label hosts (openrouter.ai) just use
 * the first label. Falls back to the raw string if URL parsing fails.
 */
function shortProvider(url){
  if(!url) return '—';
  try{
    const u=new URL(url);
    let host=u.hostname;
    host=host.replace(/^api\./,'').replace(/^gateway\./,'').replace(/^compat\./,'');
    const labels=host.split('.');
    if(labels.length>=2) return labels[labels.length-2];
    return labels[0] || '—';
  }catch{ return String(url).slice(0, 40); }
}
/** Strip a leading vendor prefix and ':free' suffix from a model name. */
function shortModel(name){
  if(!name) return '—';
  let s=String(name);
  s=s.replace(/^[^/]+[/]/,'');   // drop "openrouter/" etc.
  s=s.replace(/:free$/,'');      // drop ":free"
  return s || '—';
}
/**
 * Per-row provider/model chip rendered under the Reason cell so the user
 * can see at a glance which LLM produced each row (especially useful
 * for llm_error:* / unparseable rows where the model is the question).
 */
function llmMeta(row){
  const p=shortProvider(row.provider);
  const m=shortModel(row.model);
  if(p==='—' && m==='—') return '';
  const parts=[];
  if(p!=='—') parts.push('<span class="prov">'+esc(p)+'</span>');
  if(m!=='—') parts.push('<span class="model">'+esc(m)+'</span>');
  return '<div class="llm-meta">'+parts.join('<span class="sep">·</span>')+'</div>';
}
/**
 * Render a "friendly identifier" cell.
 *  - If a handle (@chat_username / @username) is set, show it as the primary
 *    blue link-styled value and the id underneath in small mono.
 *  - Otherwise show the display name (chat_title / full_name) as primary,
 *    with the id underneath.
 *  - If neither a handle nor a name is set, fall back to the raw id in mono.
 */
function idCell(handle, name, id){
  if(handle){
    return '<div class="id-cell">'+
      '<span class="primary handle">@'+esc(handle)+'</span>'+
      '<span class="secondary">id: '+esc(id==null?'—':id)+'</span>'+
    '</div>';
  }
  if(name){
    return '<div class="id-cell">'+
      '<span class="primary">'+esc(name)+'</span>'+
      '<span class="secondary">id: '+esc(id==null?'—':id)+'</span>'+
    '</div>';
  }
  return '<div class="id-cell">'+
    '<span class="secondary">id: '+esc(id==null?'—':id)+'</span>'+
  '</div>';
}
/**
 * Render the full audit row as a compact, elegant property panel.
 * Single-column flowing layout: metadata bar, identity, message bubble,
 * reason, LLM attribution, fun_response callout, raw JSON toggle.
 */
function detailsBody(row){
  const v=x=>x==null||x===''?'—':x;
  const fmtTs=(row.ts||'').replace('T',' ').replace('Z','');
  const parts=[
    // 1 — metadata bar: ts + id
    '<div class="d-meta">'+
      '<span class="d-ts">'+esc(fmtTs)+'</span>'+
      '<span class="sep">·</span>'+
      '<span class="d-id">#'+esc(v(row.id))+'</span>'+
    '</div>',
  ];
  // 2 — chat & user identity
  const chatH=row.chat_username
    ? '<span class="who-val">@'+esc(row.chat_username)+'</span>'
    : row.chat_title
      ? '<span class="who-val">'+esc(row.chat_title)+'</span>'
      : '<span class="who-val">'+esc(v(row.chat_id))+'</span>';
  const userH=row.username
    ? '<span class="who-val">@'+esc(row.username)+'</span>'
    : row.full_name
      ? '<span class="who-val">'+esc(row.full_name)+'</span>'
      : '<span class="who-val">'+esc(v(row.user_id))+'</span>';
  parts.push(
    '<div class="d-who">'+
      '<span class="d-who-item"><span class="who-key">Chat</span>'+chatH+'</span>'+
      '<span class="d-who-item"><span class="who-key">User</span>'+userH+'</span>'+
    '</div>'
  );
  // 3 — level | event | decision
  parts.push(
    '<div class="d-meta">'+
      levelBadge(row.level)+
      ' <code style="font-size:.76rem">'+esc(v(row.event))+'</code>'+
      ' <span class="sep">·</span> '+
      decisionBadge(row.decision)+
    '</div>'
  );
  // 4 — message bubble
  if(row.message_text) parts.push('<div class="d-bubble">'+esc(row.message_text)+'</div>');
  // 5 — reason line
  if(row.reason) parts.push('<div class="d-why">'+esc(row.reason)+'</div>');
  // 6 — LLM verdict + fun_response
  if(row.llm_response){
    let parsed=null;
    try{ parsed=JSON.parse(row.llm_response); }catch{}
    if(parsed && typeof parsed==='object'){
      const flagPill=parsed.flag===true
        ? '<span class="callout flag-on">flag</span>'
        : parsed.flag===false
          ? '<span class="callout flag-off">flag</span>'
          : '';
      parts.push(
        '<div class="d-ai">'+
          '<span class="ai-prov">'+esc(shortProvider(row.provider))+'</span>'+
          '<span class="ai-sep">·</span>'+
          '<span class="ai-model">'+esc(shortModel(row.model))+'</span>'+
          (flagPill?' <span class="ai-sep">·</span> '+flagPill:'')+
        '</div>'
      );
      if(parsed.fun_response){
        parts.push('<div class="d-fun">'+esc(parsed.fun_response)+'</div>');
      }
      parts.push('<details class="d-raw"><summary>raw</summary><pre>'+esc(JSON.stringify(parsed,null,2))+'</pre></details>');
    } else {
      parts.push('<div class="d-why">'+esc(v(row.llm_response))+'</div>');
    }
  } else {
    parts.push('<div class="d-why" style="font-style:italic">— no LLM call for this event</div>');
  }
  return parts.join('\n');
}
async function loadStats(){
  const r=await fetch(base+'/api/summary?'+qs());
  if(!r.ok)return;
  const s=await r.json();
  const total=(s.by_level||[]).reduce((a,x)=>a+(x.c||0),0);
  const deletes=(s.by_event||[]).filter(x=>['flagged_deleted','video_deleted'].includes(x.event))
    .reduce((a,x)=>a+(x.c||0),0);
  const kept=(s.by_event||[]).filter(x=>x.event==='safe')
    .reduce((a,x)=>a+(x.c||0),0);
  const errors=(s.by_level||[]).filter(x=>x.level==='error').reduce((a,x)=>a+(x.c||0),0);
  document.getElementById('stats').innerHTML=
    '<div class="stat"><div class="num">'+total+'</div><div class="lbl">Total (filtered)</div></div>'+
    '<div class="stat"><div class="num">'+deletes+'</div><div class="lbl">Deletions</div></div>'+
    '<div class="stat"><div class="num">'+kept+'</div><div class="lbl">Kept</div></div>'+
    '<div class="stat"><div class="num">'+errors+'</div><div class="lbl">Errors</div></div>';
}
async function loadEvents(){
  const r=await fetch(base+'/api/events'); if(!r.ok)return;
  const evts=await r.json();
  const sel=document.getElementById('f-event');
  for(const e of evts){const o=document.createElement('option');o.value=e;o.textContent=e;sel.appendChild(o);}
}
async function loadRows(){
  const p=qs(); p.set('page',page); p.set('per_page',perPage);
  const r=await fetch(base+'/api/logs?'+p);
  const tbody=document.getElementById('rows');
  if(!r.ok){tbody.innerHTML='<tr class="error"><td colspan="9">Failed to load ('+r.status+')</td></tr>';return;}
  const d=await r.json();
  if(!d.rows.length){tbody.innerHTML='<tr class="empty"><td colspan="9">No rows match the filters.</td></tr>';}
  else{
    tbody.innerHTML=d.rows.map((row,i)=>{
      const chat=idCell(row.chat_username, row.chat_title, row.chat_id);
      const user=idCell(row.username, row.full_name, row.user_id);
      return '<tr data-i="'+i+'">'+
        '<td class="mono">'+esc((row.ts||'').replace('T',' ').replace('Z',''))+'</td>'+
        '<td>'+levelBadge(row.level)+'</td>'+
        '<td>'+esc(row.event)+'</td>'+
        '<td>'+chat+'</td>'+
        '<td>'+user+'</td>'+
        '<td>'+decisionBadge(row.decision)+'</td>'+
        '<td class="col-reason"><div class="reason">'+esc(row.reason)+'</div>'+llmMeta(row)+'</td>'+
        '<td class="col-msg"><div class="reason">'+esc(row.message_text)+'</div></td>'+
        '<td class="col-details"><button type="button" class="details-btn" data-i="'+i+'" aria-expanded="false">Details</button></td>'+
      '</tr>'+
      '<tr class="details-row" data-details-for="'+i+'" hidden><td colspan="9"><div class="details-inner">'+
        detailsBody(row)+
      '</div></td></tr>';
    }).join('');
    // Wire up details toggle buttons (event delegation on tbody).
    tbody.querySelectorAll('.details-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const i=btn.getAttribute('data-i');
        const row=tbody.querySelector('tr.details-row[data-details-for="'+i+'"]');
        const open=btn.getAttribute('aria-expanded')==='true';
        const next=!open;
        btn.setAttribute('aria-expanded', next?'true':'false');
        btn.textContent=next?'Hide':'Details';
        if(row) row.hidden=!next;
      });
    });
  }
  document.getElementById('page-info').textContent=
    'Page '+page+(d.has_more?' (more)':'');
  document.getElementById('prev').disabled=page<=1;
  document.getElementById('next').disabled=!d.has_more;
}
function apply(){page=1;loadRows();loadStats();}
document.getElementById('apply').addEventListener('click',apply);
document.getElementById('prev').addEventListener('click',()=>{if(page>1){page--;loadRows();}});
document.getElementById('next').addEventListener('click',()=>{if(!document.getElementById('next').disabled){page++;loadRows();}});
document.getElementById('export').addEventListener('click',()=>{location.href=base+'/export.csv?'+qs();});
/* Sortable column headers: click toggles asc/desc, client-side sort of the
   current page rows. Sorted columns get aria-sort. */
let sortKey=null, sortAsc=true;
const _colIdx={ts:0,level:1,event:2,chat_username:3,user_id:4,decision:5,reason:6,message_text:7};
document.querySelectorAll('th[data-k]').forEach(th=>{
  th.addEventListener('click',()=>{
    const k=th.getAttribute('data-k');
    if(sortKey===k){sortAsc=!sortAsc;}else{sortKey=k;sortAsc=true;}
    const dir=sortAsc?1:-1;
    const idx=_colIdx[k];
    const tbody=document.getElementById('rows');
    const els=Array.from(tbody.children);
    const pairs=[];
    for(let i=0;i<els.length;i+=2){
      const row=els[i];
      const detail=els[i+1]&&els[i+1].classList.contains('details-row')?els[i+1]:null;
      pairs.push({row,detail});
    }
    pairs.sort((a,b)=>{
      const ca=(a.row.cells[idx]?.textContent||'').trim();
      const cb=(b.row.cells[idx]?.textContent||'').trim();
      return ca.localeCompare(cb,undefined,{numeric:true,sensitivity:'base'})*dir;
    });
    tbody.innerHTML='';
    pairs.forEach(p=>{tbody.appendChild(p.row);if(p.detail)tbody.appendChild(p.detail);});
    document.querySelectorAll('th[data-k]').forEach(h=>h.removeAttribute('aria-sort'));
    th.setAttribute('aria-sort',sortAsc?'ascending':'descending');
  });
});
['f-level','f-event','f-decision','f-chat','f-user','f-from','f-to','f-q'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')apply();});
});

/* ---- Bot queue tab ---- */
/** Human-short age of an ISO timestamp: <1m / 42m / 3h 12m / 2d 5h. */
function ageStr(iso){
  const ms=Date.now()-Date.parse(iso);
  if(isNaN(ms))return '—';
  const m=Math.floor(ms/60000);
  if(m<1)return '<1m';
  if(m<60)return m+'m';
  const h=Math.floor(m/60);
  if(h<48)return h+'h '+(m%60)+'m';
  return Math.floor(h/24)+'d '+(h%24)+'h';
}
async function loadQueue(){
  const tbody=document.getElementById('bq-rows');
  const notice=document.getElementById('bq-notice');
  const kind=document.getElementById('bq-kind').value;
  const p=new URLSearchParams();if(kind)p.set('kind',kind);
  const r=await fetch(base+'/api/bot-queue?'+p);
  if(!r.ok){tbody.innerHTML='<tr class="error"><td colspan="7">Failed to load ('+r.status+')</td></tr>';return;}
  const d=await r.json();
  if(d.enabled){notice.hidden=true;}
  else{
    notice.hidden=false;
    notice.textContent='Self-clean is disabled (ENABLE_SELF_CLEAN) — messages below will not be auto-deleted.';
  }
  document.getElementById('bq-count').textContent=
    d.rows.length+' pending · TTL '+d.ttl_minutes+'m';
  if(!d.rows.length){
    tbody.innerHTML='<tr class="empty"><td colspan="7">'+
      (kind?'No "'+esc(kind)+'" messages awaiting cleanup.'
           :'No bot messages awaiting cleanup.')+
    '</td></tr>';
    return;
  }
  tbody.innerHTML=d.rows.map(row=>{
    return '<tr>'+
      '<td class="mono">'+esc(row.message_id)+'</td>'+
      '<td>'+idCell(row.chat_username,null,row.chat_id)+'</td>'+
      '<td class="bq-msg"><div class="reason">'+esc(row.message)+'</div></td>'+
      '<td><span class="badge bq-kind-'+esc(row.kind)+'">'+esc(row.kind)+'</span></td>'+
      '<td class="mono">'+esc((row.sent_at||'').replace('T',' ').replace('Z',''))+'</td>'+
      '<td class="mono">'+ageStr(row.sent_at)+
        (row.eligible?' <span class="badge due">due</span>':'')+'</td>'+
      '<td class="mono">'+esc(row.attempts)+'</td>'+
    '</tr>';
  }).join('');
}
document.getElementById('bq-refresh').addEventListener('click',loadQueue);
document.getElementById('bq-kind').addEventListener('change',loadQueue);

/* ---- Tabs: audit (default) | bot-queue, deep-linked via ?tab= ---- */
function currentTab(){
  return new URLSearchParams(location.search).get('tab')==='bot-queue'
    ?'bot-queue':'audit';
}
function showTab(t){
  document.getElementById('tab-audit').hidden=(t!=='audit');
  document.getElementById('tab-bot-queue').hidden=(t!=='bot-queue');
  document.querySelectorAll('.tab').forEach(a=>{
    a.classList.toggle('active',a.getAttribute('data-tab')===t);
  });
  if(t==='bot-queue'){loadQueue();}
  else{loadStats();loadRows();}
}
document.querySelectorAll('.tab').forEach(a=>{
  a.addEventListener('click',e=>{
    e.preventDefault();
    const t=a.getAttribute('data-tab');
    const u=new URL(location.href);
    if(t==='audit'){u.searchParams.delete('tab');}else{u.searchParams.set('tab',t);}
    history.replaceState(null,'',u);
    showTab(t);
  });
});
loadEvents();
showTab(currentTab());
