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
  if(!r.ok){tbody.innerHTML='<tr class="row-error"><td colspan="9">Failed to load ('+r.status+')</td></tr>';return;}
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
  if(!r.ok){tbody.innerHTML='<tr class="row-error"><td colspan="7">Failed to load ('+r.status+')</td></tr>';return;}
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

/* ---- Settings tab: runtime config overrides (generated from defs) ---- */
/* ---- Digest tab: runs list, draft editor, publish/discard, stats ---- */
let dgCurrent=null;   // full row loaded into the editor
const DG_TAGS=['b','i','u','s','a','code','blockquote'];
/** Render the Telegram-HTML subset safely for the preview pane. */
function renderTgHtml(src){
  let s=esc(src);
  // Only the allowlisted tags survive; everything else stays escaped text.
  s=s.replace(/&lt;(\/?)(b|i|u|s|blockquote|code|strong|em)&gt;/g,(m,sl,tag)=>{
    const map={strong:'b',em:'i'};
    return '<'+sl+(map[tag]||tag)+'>';
  });
  s=s.replace(/&lt;a href=&quot;(.*?)&quot;&gt;/g,(m,url)=>{
    const u=url.replace(/&amp;/g,'&');
    return '<a href="'+u+'" target="_blank" rel="noopener">';
  });
  s=s.replace(/&lt;(\/?)a&gt;/g,'<$1a>');
  return s;
}
function typeBadge(t){return '<span class="badge dg-type-'+esc(t||'daily')+'">'+esc(t||'daily')+'</span>';}
function statusBadge(st){
  const cls={published:'keep',draft:'info',failed:'error',discarded:'debug'}[st]||'debug';
  return badge(cls,st);
}
// Shared POST helper for the digest + settings APIs (single definition).
async function dgPost(url,payload){
  return fetch(base+url,{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},
    body:JSON.stringify(payload||{})
  });
}
async function loadSettings(){
  const tbody=document.getElementById('st-rows');
  try{
    const r=await fetch(base+'/api/settings',{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    if(!d.defs||!d.defs.length){
      tbody.innerHTML='<tr class="empty"><td colspan="4">No editable settings.</td></tr>';
      return;
    }
    const byKey={};
    d.values.forEach(v=>{byKey[v.key]=v;});
    tbody.innerHTML=d.defs.map(def=>{
      const v=byKey[def.key]||{value:'',source:'default'};
      const input=def.kind==='boolean'
        ?'<input type="checkbox" data-key="'+esc(def.key)+'"'+(v.value==='true'?' checked':'')+'>'
        :'<input type="text" data-key="'+esc(def.key)+'" value="'+esc(v.value)+'" style="width:240px">';
      const src='<span class="badge'+(v.source==='override'?' due':'')+'">'+esc(v.source)+'</span>';
      const reset='<button class="st-reset" data-key="'+esc(def.key)+'"'+(v.source==='override'?'':' disabled')+' title="Delete the override; the env/default value applies again">Reset</button>';
      return '<tr>'+
        '<td title="'+esc(def.description)+'"><b>'+esc(def.label)+'</b><br><span class="mono" style="font-size:.75em">'+esc(def.key)+'</span></td>'+
        '<td>'+input+'</td>'+
        '<td>'+src+'</td>'+
        '<td>'+reset+'</td>'+
      '</tr>';
    }).join('');
    tbody.querySelectorAll('input[data-key]').forEach(inp=>{
      inp.addEventListener('change',async()=>{
        const key=inp.getAttribute('data-key');
        const value=inp.type==='checkbox'?String(inp.checked):inp.value;
        try{
          const r=await apiPost('/api/settings',{key,value});
          const d=await r.json().catch(()=>({}));
          if(r.ok){loadSettings();}
          else{alert('Save failed: '+(d.error||('HTTP '+r.status)));}
        }catch(err){alert('Save failed: '+(err&&err.message||err));}
      });
    });
    tbody.querySelectorAll('.st-reset').forEach(btn=>{
      btn.addEventListener('click',async()=>{
        const key=btn.getAttribute('data-key');
        try{
          const r=await apiPost('/api/settings/reset',{key});
          const d=await r.json().catch(()=>({}));
          if(r.ok){loadSettings();}
          else{alert('Reset failed: '+(d.error||('HTTP '+r.status)));}
        }catch(err){alert('Reset failed: '+(err&&err.message||err));}
      });
    });
  }catch(err){
    tbody.innerHTML='<tr class="empty"><td colspan="4">Settings load failed: '+
      esc(err&&err.message||String(err))+'</td></tr>';
  }
}
document.getElementById('st-refresh').addEventListener('click',loadSettings);

/* ---- Tabs: audit (default) | bot-queue | settings, deep-linked via ?tab= ---- */
function currentTab(){
  const t=new URLSearchParams(location.search).get('tab');
  return t==='bot-queue'||t==='settings'||t==='digest'?t:'audit';
}
/* ---- Digest toast + loading UX (§23.5) ---- */
function dgToast(msg,kind){
  const host=document.getElementById('dg-toast-host');
  if(!host)return;
  const t=document.createElement('div');
  t.className='dg-toast dg-toast-'+(kind||'ok');
  t.textContent=msg;
  host.appendChild(t);
  requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('dg-toast-show')));
  const ms=kind==='err'?5000:3000;
  setTimeout(()=>{
    t.classList.remove('dg-toast-show');
    t.classList.add('dg-toast-hide');
    setTimeout(()=>t.remove(),280);
  },ms);
}
let dgLoading=0;          // refcount so nested loads share one spinner pass
function dgSetLoading(btn,on){
  if(on){
    if(!btn.dataset.dgLabel)btn.dataset.dgLabel=btn.textContent;
    dgLoading++;
    btn.classList.add('dg-loading');
    btn.textContent='Working…';
  }else{
    dgLoading=Math.max(0,dgLoading-1);
    if(dgLoading===0){
      btn.classList.remove('dg-loading');
      if(btn.dataset.dgLabel){btn.textContent=btn.dataset.dgLabel;}
    }
  }
}
/* Digest filter state (applies to Published server-side; drafts client-side). */
let dgPage=1;
const DG_PER_PAGE=20;
function dgFilterParams(){
  const p=new URLSearchParams();
  const g=(id)=>document.getElementById(id).value;
  const domain=g('dg-f-domain');if(domain&&domain!=='all')p.set('domain',domain);
  if(g('dg-f-type'))p.set('type',g('dg-f-type'));
  if(g('dg-f-from'))p.set('from',g('dg-f-from'));
  if(g('dg-f-to'))p.set('to',g('dg-f-to'));
  if(g('dg-f-minrx'))p.set('min_reactions',g('dg-f-minrx'));
  if(g('dg-f-trend'))p.set('trend',g('dg-f-trend'));
  return p;
}
/** GET with no-store: Refresh must never serve a cached response (§23.4). */
async function dgGet(path){
  return await fetch(base+path,{cache:'no-store'});
}
/** Emoji pills from a breakdown map, tinted by sentiment class. */
function rxChips(breakdown,signals){
  const entries=Object.entries(breakdown||{}).sort((a,b)=>b[1]-a[1]);
  if(!entries.length)return '<span class="mono">0</span>';
  return '<div class="rx-wrap">'+entries.map(([e,c])=>{
    const cls=signals&&signals[e]==='neg'?' rx-neg':(signals&&signals[e]==='pos'?' rx-pos':'');
    return '<span class="rx-chip'+cls+'" title="'+esc(e)+'">'+esc(e)+' '+esc(c)+'</span>';
  }).join('')+'</div>';
}
/** Windowed-delta arrow + age-normalized velocity (reactions/hour). */
function trendChip(a){
  if(!a||a.total==null)return '<span class="mono">—</span>';
  const map={up:'\u{1F4C8}',down:'\u{1F4C9}',flat:'➖',new:'·'};
  const arrow=map[a.trend||'new']||'·';
  const delta=a.trend_delta!=null&&a.trend_delta!==0
    ?(' '+(a.trend_delta>0?'+':'')+a.trend_delta):'';
  const cls='trend-'+(a.trend||'new');
  return '<span class="'+cls+'" title="reactions since ~24h ago">'+arrow+esc(delta)+'</span>'+
    (a.velocity!=null?'<div class="secondary">'+esc(a.velocity)+'/h</div>':'');
}
/** Flatten a settings object into key/value rows (arrays joined, nested dotted). */
function kvRows(obj,prefix,out){
  out=out||[];
  for(const[k,v]of Object.entries(obj||{})){
    const key=prefix?prefix+'.'+k:k;
    if(v&&typeof v==='object'&&!Array.isArray(v)){kvRows(v,key,out);}
    else if(Array.isArray(v)){out.push([key,v.length?v.join(', '):'—']);}
    else if(v&&typeof v==='object')out.push([key,'—']);
    else out.push([key,v==null||v===''?'—':String(v)]);
  }
  return out;
}
function kvTable(obj){
  return '<table class="kv">'+kvRows(obj,'',[]).map(([k,v])=>
    '<tr><td class="k">'+esc(k)+'</td><td class="v">'+esc(v)+'</td></tr>').join('')+'</table>';
}
function domainBadge(dm){return dm?'<span class="badge dg-domain-'+esc(dm)+'">'+esc(dm)+'</span>':'<span class="mono">—</span>';}
async function loadDigest(){
  const notice=document.getElementById('dg-notice');
  const btn=document.getElementById('dg-refresh');
  const warnNotice=(msg)=>{notice.hidden=false;notice.textContent=msg;dgToast(msg,'warn');};
  dgSetLoading(btn,true);
  try{
    const r=await dgGet('/api/digest/drafts');
    if(!r.ok){warnNotice('Digest API failed ('+r.status+').');return;}
    const d=await r.json();
    if(!d.enabled){warnNotice('Digest is disabled (ENABLE_NEWS_DIGEST != "true").');}
    else if(d.auto_publish){warnNotice('Auto-publish is ON — runs publish directly. Drafts below are from earlier manual/failed runs or can be created by turning auto-publish off.');}
    else{notice.hidden=false;notice.textContent='Auto-publish is OFF — new runs are stored as drafts and must be approved here.';}
    const drafts=(d.rows||[]).filter(x=>x.status==='draft');
    const f=dgFilterParams();
    const fDomain=f.get('domain'),fType=f.get('type');
    const shownDrafts=drafts.filter(x=>
      (!fDomain||(x.domain||'')===fDomain)&&(!fType||x.type===fType));
    const tbody=document.getElementById('dg-drafts');
    if(!shownDrafts.length){
      tbody.innerHTML='<tr class="empty"><td colspan="8">'+
        (drafts.length?'No drafts match the filters.':'No pending drafts.')+'</td></tr>';
    }else{
      tbody.innerHTML=shownDrafts.map(row=>'<tr>'+
        '<td class="mono">'+esc(row.slot_key)+'</td>'+
        '<td>'+typeBadge(row.type)+'</td>'+
        '<td>'+domainBadge(row.domain)+'</td>'+
        '<td><div class="primary">'+esc(row.title||'—')+'</div></td>'+
        '<td><div class="reason">'+esc(row.preview||'')+'</div></td>'+
        '<td class="mono">'+esc((row.run_at||'').replace('T',' ').replace('Z',''))+'</td>'+
        '<td class="mono">'+esc(row.body_len||0)+' ch</td>'+
        '<td><button type="button" class="details-btn" data-dg-edit="'+row.id+'">Edit</button></td>'+
      '</tr>').join('');
      tbody.querySelectorAll('[data-dg-edit]').forEach(b=>b.addEventListener('click',()=>openEditor(Number(b.getAttribute('data-dg-edit')))));
    }
    // Published (filtered + paginated) via /api/digest/stats
    const sp=new URLSearchParams(f);sp.set('page',dgPage);sp.set('per_page',DG_PER_PAGE);
    const sr=await dgGet('/api/digest/stats?'+sp);
    const spub=document.getElementById('dg-published');
    const sstat=document.getElementById('dg-stats');
    if(!sr.ok){warnNotice('Digest stats failed ('+sr.status+').');spub.innerHTML='<tr class="error"><td colspan="9">Failed to load.</td></tr>';return;}
    const st=await sr.json();
    const sm=st.summary||{};
    sstat.innerHTML=
      '<div class="stat"><div class="num">'+(sm.published||0)+'</div><div class="lbl">Published (filtered)</div></div>'+
      '<div class="stat"><div class="num">'+drafts.length+'</div><div class="lbl">Pending drafts</div></div>'+
      '<div class="stat"><div class="num">'+(sm.reactions||0)+'</div><div class="lbl">Total reactions</div></div>'+
      '<div class="stat"><div class="num">'+((sm.pos||0)-(sm.neg||0))+'</div><div class="lbl">Net sentiment</div></div>'+
      '<div class="stat"><div class="num" title="'+esc(sm.best&&sm.best.title||'')+'">'+(sm.best!=null?esc(sm.best.reactions):'—')+'</div><div class="lbl">Best post</div></div>';
    // Domain filter options = union of published + draft domains (keep selection).
    const fd=document.getElementById('dg-f-domain');
    const sel=fd.value||'all';
    const doms=[...new Set([...(st.domains||[]),...drafts.map(x=>x.domain).filter(Boolean)])].sort();
    fd.innerHTML='<option value="all">domain: all</option>'+doms.map(x=>'<option>'+esc(x)+'</option>').join('');
    if(doms.includes(sel))fd.value=sel;
    spub.innerHTML=(st.posts||[]).length?st.posts.map(p=>{
      const a=p.analytics;
      return '<tr>'+
        '<td><div class="primary">'+esc(p.title||'—')+'</div></td>'+
        '<td>'+typeBadge(p.type)+'</td>'+
        '<td>'+domainBadge(p.domain)+'</td>'+
        '<td class="mono">'+esc((p.published_at||'').replace('T',' ').replace('Z',''))+'</td>'+
        '<td class="mono col-rx-count">'+(a&&a.total!=null?esc(a.total):'—')+'</td>'+
        '<td class="col-rx">'+(a&&a.breakdown?rxChips(a.breakdown,st.signal_map):'<span class="mono">—</span>')+'</td>'+
        '<td class="mono">'+trendChip(a)+'</td>'+
        '<td class="mono">'+esc(p.message_id||'—')+'</td>'+
        '<td>'+(p.edited_at?'<span class="badge due">edited</span>':'—')+'</td>'+
      '</tr>';
    }).join(''):'<tr class="empty"><td colspan="9">Nothing published yet.</td></tr>';
    document.getElementById('dg-page-info').textContent=
      'Page '+dgPage+' · '+(st.posts||[]).length+' of '+st.total+(st.has_more?' (more)':'');
    document.getElementById('dg-prev').disabled=dgPage<=1;
    document.getElementById('dg-next').disabled=!st.has_more;
    // Settings as readable key/value rows
    const setr=await dgGet('/api/digest/settings');
    if(setr.ok){
      document.getElementById('dg-settings').innerHTML=kvTable(await setr.json());
    }
    dgToast('Digest refreshed.','ok');
  }catch(err){
    const msg='Digest load failed: '+(err&&err.message||err);
    notice.hidden=false;notice.textContent=msg;
    dgToast(msg,'err');
  }finally{
    dgSetLoading(btn,false);
  }
}
/* Editor */
async function openEditor(id){
  const r=await dgGet('/api/digest/drafts/'+id);
  if(!r.ok){alert('Failed to load draft '+id);return;}
  dgCurrent=await r.json();
  document.getElementById('dg-editor').hidden=false;
  document.getElementById('dg-editor-title').textContent=dgCurrent.title||'(untitled)';
  document.getElementById('dg-editor-meta').textContent=
    dgCurrent.slot_key+' · '+dgCurrent.type+(dgCurrent.domain?' · '+dgCurrent.domain:'')+
    ' · '+dgCurrent.mode+' · '+(dgCurrent.model||'');
  document.getElementById('dg-body').value=dgCurrent.body||'';
  document.getElementById('dg-editor-status').textContent='';
  updateCount();updatePreview();
  document.getElementById('dg-editor').scrollIntoView({behavior:'smooth',block:'start'});
}
function closeEditor(){
  document.getElementById('dg-editor').hidden=true;dgCurrent=null;
}
function updateCount(){
  const v=document.getElementById('dg-body').value;
  document.getElementById('dg-count').textContent=
    v.length+' chars raw'+(v.length>4096?' — WILL be split into parts':'');
}
function updatePreview(){
  document.getElementById('dg-preview').innerHTML=renderTgHtml(document.getElementById('dg-body').value);
}
document.getElementById('dg-body').addEventListener('input',()=>{updateCount();updatePreview();});
document.querySelectorAll('.dg-toolbar button').forEach(b=>{
  b.addEventListener('click',()=>{
    const ta=document.getElementById('dg-body');
    const tag=b.getAttribute('data-wrap');
    const {selectionStart:s,selectionEnd:e,value:v}=ta;
    const sel=v.slice(s,e);
    let ins;
    if(tag==='a'){
      const url=sel&&/^(https?:\/\/|tg:\/\/)/i.test(sel.trim())?sel.trim():window.prompt('Link URL (https:// or tg://)','https://');
      if(!url)return;
      const label=sel&&sel.trim()!==url?sel:url.replace(/^https?:\/\//,'');
      ins='<a href="'+url+'">'+label+'</a>';
    }else{
      ins='<'+tag+'>'+sel+'</'+tag+'>';
    }
    ta.value=v.slice(0,s)+ins+v.slice(e);
    ta.focus();ta.setSelectionRange(s+ins.length,s+ins.length);
    updateCount();updatePreview();
  });
});
document.getElementById('dg-save').addEventListener('click',async()=>{
  if(!dgCurrent)return;
  const r=await dgPost('/api/digest/drafts/'+dgCurrent.id+'/save',{body:document.getElementById('dg-body').value});
  const st=document.getElementById('dg-editor-status');
  st.textContent=r.ok?'Saved ✓':'Save failed ('+r.status+')';
  if(r.ok)document.getElementById('dg-editor-meta').textContent=dgCurrent.slot_key+' · '+dgCurrent.type+' · '+dgCurrent.mode+' · '+(dgCurrent.model||'')+' · saved';
});
document.getElementById('dg-restore').addEventListener('click',()=>{
  if(dgCurrent&&dgCurrent.body_original!=null){
    document.getElementById('dg-body').value=dgCurrent.body_original;
    updateCount();updatePreview();
    document.getElementById('dg-editor-status').textContent='Restored original (not saved yet)';
  }
});
document.getElementById('dg-publish').addEventListener('click',async()=>{
  if(!dgCurrent)return;
  if(!window.confirm('Publish this digest to '+(dgCurrent.target_chat_id||'the channel')+'?'))return;
  const sr=await dgPost('/api/digest/drafts/'+dgCurrent.id+'/save',{body:document.getElementById('dg-body').value});
  if(!sr.ok){document.getElementById('dg-editor-status').textContent='Save failed before publish';return;}
  const r=await dgPost('/api/digest/drafts/'+dgCurrent.id+'/publish');
  const st=document.getElementById('dg-editor-status');
  const d=await r.json().catch(()=>({}));
  st.textContent=r.ok?'Published ✓ (message '+d.message_id+')':'Publish failed: '+(d.error||r.status);
  if(r.ok){closeEditor();loadDigest();}
});
document.getElementById('dg-discard').addEventListener('click',async()=>{
  if(!dgCurrent||!window.confirm('Discard this draft?'))return;
  const r=await dgPost('/api/digest/drafts/'+dgCurrent.id+'/discard');
  if(r.ok){closeEditor();loadDigest();}
});
document.getElementById('dg-close').addEventListener('click',closeEditor);
/* Filter bar: apply resets to page 1; Enter in inputs does the same. */
function dgApply(){dgPage=1;loadDigest();}
document.getElementById('dg-apply').addEventListener('click',dgApply);
['dg-f-from','dg-f-to','dg-f-minrx'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')dgApply();});
});
['dg-f-domain','dg-f-type','dg-f-trend'].forEach(id=>{
  document.getElementById(id).addEventListener('change',dgApply);
});
document.getElementById('dg-prev').addEventListener('click',()=>{if(dgPage>1){dgPage--;loadDigest();}});
document.getElementById('dg-next').addEventListener('click',()=>{if(!document.getElementById('dg-next').disabled){dgPage++;loadDigest();}});
document.getElementById('dg-refresh').addEventListener('click',()=>{
  closeEditor();   // a stale editor open across a refresh shows old state (§23.4)
  loadDigest();
});
// Dev-only: insert a fake draft to exercise the review/edit/publish flow.
// Gated server-side by NEWS_DEV_SEED — returns 404 in production.
document.getElementById('dg-seed').addEventListener('click',async()=>{
  if(!window.confirm('Insert a test draft? It will appear in Pending drafts and can be reviewed, edited, published or discarded.'))return;
  const btn=document.getElementById('dg-seed');
  dgSetLoading(btn,true);
  try{
    const r=await dgPost('/api/digest/dev/seed');
    const d=await r.json().catch(()=>({}));
    if(r.ok){dgToast('Test draft inserted — check Pending drafts.','ok');loadDigest();}
    else{const m=d.error||('Failed ('+r.status+')');dgToast(m,'err');}
  }catch(err){dgToast('Seed failed: '+(err&&err.message||err),'err');}
  finally{dgSetLoading(btn,false);}
});

/* ---- Tabs: audit (default) | bot-queue | digest | settings, deep-linked via ?tab= ---- */
function showTab(t){
  document.getElementById('tab-audit').hidden=(t!=='audit');
  document.getElementById('tab-bot-queue').hidden=(t!=='bot-queue');
  document.getElementById('tab-digest').hidden=(t!=='digest');
  document.getElementById('tab-settings').hidden=(t!=='settings');
  document.querySelectorAll('.tab').forEach(a=>{
    a.classList.toggle('active',a.getAttribute('data-tab')===t);
  });
  if(t==='bot-queue'){loadQueue();}
  else if(t==='digest'){loadDigest();}
  else if(t==='settings'){loadSettings();}
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
