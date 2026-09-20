const $=id=>document.getElementById(id);
let token,me,users=[],selected=null,view='users',recordUser='',recordOffset=0,auditOffset=0,epoch=0;
try{token=localStorage.getItem('xiangqi-online-token')||sessionStorage.getItem('xiangqi-online-token');}catch{}

function getCookie(name){
  const match=document.cookie.match(new RegExp('(?:^|; )'+name.replace(/([.$?*|{}()[\]\\/+^])/g,'\\$1')+'=([^;]*)'));
  return match?decodeURIComponent(match[1]):null;
}

const can=p=>me?.permissions?.includes(p);
const rate=n=>n==null?'—':(n*100).toFixed(1)+'%';
const date=n=>n?new Date(n).toLocaleString('zh-CN'):'—';
function node(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;}

async function api(path,data){
  const headers={'Content-Type':'application/json'};
  if(token)headers['Authorization']='Bearer '+token;
  const csrf=getCookie('xq_csrf');
  if(csrf)headers['X-CSRF-Token']=csrf;
  const res=await fetch('/api/'+path,{
    method:data===undefined?'GET':'POST',
    credentials:'same-origin',
    headers,
    ...(data===undefined?{}:{body:JSON.stringify(data)})
  });
  const result=await res.json();
  if(!res.ok)throw new Error(result.error||'操作失败');
  return result;
}

function message(text){$('message').hidden=false;$('message').textContent=text;}
async function guarded(fn){try{await fn();}catch(e){message(e.message);}}

async function switchView(next){
  view=next;epoch++;
  for(const v of ['users','records','settings','audit'])$(v+'View').hidden=v!==next;
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===next));
  $('pageTitle').textContent={users:'账号与权限',records:'对局档案',settings:'服务器设置',audit:'操作审计日志'}[next];
  await refresh();
}

async function refresh(){
  const ticket=++epoch;
  if(view==='users'){
    const data=await api('admin/users');
    if(ticket!==epoch)return;
    users=data.users;
    renderUsers();
  }else if(view==='settings'){
    const data=await api('admin/settings');
    if(ticket!==epoch)return;
    if($('registration'))$('registration').checked=Boolean(data.settings.registrationOpen);
    if($('guestLogin'))$('guestLogin').checked=Boolean(data.settings.guestLoginOpen);
    if($('maxRooms'))$('maxRooms').value=data.settings.maxRooms;
    if($('serverStatus'))$('serverStatus').textContent=`当前 ${data.rooms} 间房 · ${data.sessions} 个会话（含离线保留会话）`;
  }else if(view==='records'){
    recordOffset=0;
    $('recordList').replaceChildren();
    await loadRecords(ticket);
  }else if(view==='audit'){
    auditOffset=0;
    $('auditBody').replaceChildren();
    await loadAuditLogs(ticket);
  }
}

function renderUsers(){
  const values=[['全部账号',users.length],['注册棋友',users.filter(u=>u.type==='registered').length],['游客棋友',users.filter(u=>u.type==='guest').length],['封禁中',users.filter(u=>u.banned).length]];
  $('stats').replaceChildren(...values.map(([label,value])=>{const el=node('div',null,'stat');el.append(node('span',label),node('strong',value));return el;}));
  const query=$('search').value.trim().toLowerCase(),filter=$('filter').value;
  const list=users.filter(u=>(u.username.toLowerCase().includes(query)||u.id.includes(query))&&(filter==='all'||u.type===filter||filter==='admin'&&u.role==='admin'||filter==='banned'&&u.banned));
  $('resultCount').textContent=`${list.length} 个账号`;
  $('usersBody').replaceChildren();
  for(const u of list){
    const tr=node('tr'),name=node('td');
    name.append(node('strong',u.username),node('small',u.id));
    tr.append(name,node('td',(u.type==='guest'?'游客':'注册')+' / '+(u.role==='admin'?'管理员':'玩家')));
    const status=node('td');
    status.append(node('span',u.banned?'封禁中':'正常','badge'));
    if(u.banned)status.append(node('small',u.banUntil?'至 '+date(u.banUntil):'永久封禁'));
    tr.append(status,node('td',u.stats.games),node('td',rate(u.stats.winRate)),node('td',rate(u.stats.recentWinRate)));
    const actions=node('td');
    if(can('users')){const b=node('button','管理');b.onclick=()=>openAccount(u);actions.append(b);}
    if(can('records')){const b=node('button','对局');b.onclick=()=>guarded(async()=>{recordUser=u.id;await switchView('records');});actions.append(b);}
    tr.append(actions);
    $('usersBody').append(tr);
  }
  if(!list.length){
    const td=node('td','没有符合条件的账号');td.colSpan=7;const tr=node('tr');tr.append(td);$('usersBody').append(tr);
  }
}

function openAccount(u){
  selected=u;
  $('accountTitle').textContent=u?'管理 · '+u.username:'新建账号';
  $('accountError').hidden=true;
  $('accountName').value=u?.username||'';
  $('accountType').value=u?.type||'registered';
  $('accountRole').value=u?.role||'player';
  $('accountPassword').value='';
  $('accountPassword').required=!u;
  $('accountActions').hidden=!u;
  $('banReason').value=u?.banReason||'';
  if($('adminAuthPassword'))$('adminAuthPassword').value='';

  const guestOpt=$('accountType').querySelector('option[value=guest]');
  if(guestOpt){
    if(!u){
      guestOpt.disabled=true;
      $('accountTypeHint').textContent='注：后台仅支持创建正式注册账号；游客账号由客户端直接生成。';
    }else if(u.type==='registered'){
      guestOpt.disabled=true;
      $('accountTypeHint').textContent='注：注册账号不可降级为游客账号。';
    }else{
      guestOpt.disabled=false;
      $('accountTypeHint').textContent='注：当前为游客，可设置密码升级为正式注册账号。';
    }
  }

  const protectedUser=u&&(u.id==='10000001'||u.id===me.id||u.role==='admin'&&me.id!=='10000001');
  $('accountForm').querySelectorAll('input,select,fieldset,#saveAccount').forEach(el=>el.disabled=!!protectedUser);
  $('accountActions').querySelectorAll('button,input,select').forEach(el=>el.disabled=!!protectedUser);
  $('banAccount').disabled=!!protectedUser||u?.role==='admin';
  $('unbanAccount').disabled=!!protectedUser||!u?.banned;
  $('accountRole').disabled=!!protectedUser||!u||me.id!=='10000001';
  $('permissionFields').hidden=!u;
  document.querySelectorAll('#permissionFields input').forEach(el=>{
    el.checked=!!u?.permissions?.includes(el.value);
    el.disabled=!!protectedUser||!can(el.value)||me.id!=='10000001';
  });
  $('customDuration').disabled=$('banDuration').value!=='custom'||!!protectedUser;
  if(protectedUser){
    $('accountError').hidden=false;
    $('accountError').textContent='此账号受保护，不能在此修改。主管理员凭据由服务器环境配置维护。';
  }
  $('accountDialog').showModal();
}

async function mutate(data){
  if($('adminAuthPassword')?.value) {
    data.adminPassword=$('adminAuthPassword').value;
    data.requireReauth=true;
  }
  await api('admin/account',data);
  $('accountDialog').close();
  await refresh();
  message('账号操作已完成。');
}

async function accountAction(fn){
  const buttons=[...$('accountDialog').querySelectorAll('button')];
  const disabled=buttons.map(b=>b.disabled);
  buttons.forEach(b=>b.disabled=true);
  try{await fn();}
  catch(e){$('accountError').textContent=e.message;$('accountError').hidden=false;}
  finally{buttons.forEach((b,i)=>b.disabled=disabled[i]);}
}

$('accountForm').onsubmit=e=>{
  e.preventDefault();
  accountAction(()=>mutate({
    action:selected?'update':'create',
    userId:selected?.id,
    username:$('accountName').value,
    type:$('accountType').value,
    role:$('accountRole').value,
    password:$('accountPassword').value,
    permissions:[...document.querySelectorAll('#permissionFields input:checked')].map(el=>el.value)
  }));
};

$('accountType').onchange=()=>{
  $('accountPassword').required=$('accountType').value==='registered'&&(!selected||selected.type==='guest');
  $('accountName').required=!!selected||$('accountType').value==='registered';
};

$('banDuration').onchange=()=>$('customDuration').disabled=$('banDuration').value!=='custom';

async function ban(banned){
  await api('admin/ban',{
    userId:selected.id,
    banned,
    reason:$('banReason').value,
    durationMinutes:banned?Number($('banDuration').value==='custom'?$('customDuration').value:$('banDuration').value):0
  });
  $('accountDialog').close();
  await refresh();
  message(banned?'封禁已生效，到期自动解除。永久封禁需手动解除。':'已解除封禁。');
}

$('banAccount').onclick=()=>accountAction(()=>ban(true));
$('unbanAccount').onclick=()=>accountAction(()=>ban(false));
$('resetPassword').onclick=()=>accountAction(()=>mutate({action:'password',userId:selected.id,password:$('accountPassword').value}));

for(const [id,action,label] of [['clearRecords','clearRecords','清除对局数据'],['deleteAccount','delete','删除账号及数据']]){
  $(id).onclick=()=>{
    if(confirm(`确定${label}：${selected.username}（${selected.id}）？此操作无法撤销。`)){
      accountAction(()=>mutate({action,userId:selected.id}));
    }
  };
}

async function loadRecords(ticket=epoch){
  const data=await api('admin/records?userId='+encodeURIComponent(recordUser)+'&offset='+recordOffset);
  if(ticket!==epoch)return;
  recordOffset+=data.records.length;
  $('recordsSummary').textContent=(recordUser?'账号 '+recordUser+' · ':'')+`共 ${data.total} 场，已显示 ${recordOffset} 场`;
  $('moreRecords').hidden=recordOffset>=data.total;
  for(const m of data.records){
    const detail=node('details');
    const players=m.players.map(p=>`${p.name}（${p.side==='r'?'红':'黑'}）`).join(' 对 ');
    const outcome = m.winner ? (m.winner === 'r' ? '红胜' : '黑胜') : '和棋';
    detail.append(node('summary',`${players} · ${outcome} · ${m.records.length}手 · ${date(m.endedAt)}`),node('p',m.reason,'muted'));
    const ol=node('ol');
    for(const r of m.records)ol.append(node('li',(r.side==='r'?'红方 ':'黑方 ')+r.text));
    if(!m.records.length)detail.append(node('p','对局在首次走子前结束。','muted'));
    else detail.append(ol);
    $('recordList').append(detail);
  }
  if(!data.total)$('recordList').append(node('p','暂无已归档对局。','muted'));
}

async function loadAuditLogs(ticket=epoch){
  const data=await api('admin/audit-logs?offset='+auditOffset+'&limit=50');
  if(ticket!==epoch)return;
  auditOffset+=data.logs.length;
  $('auditSummary').textContent=`共 ${data.total} 条日志，已显示 ${auditOffset} 条`;
  $('moreAuditLogs').hidden=auditOffset>=data.total;
  const actionNames={
    account_create:'创建账号',
    account_update:'修改资料/权限',
    account_reset_password:'重置密码',
    account_clear_records:'清除对局',
    account_delete:'删除账号',
    ban_user:'封禁账号',
    unban_user:'解除封禁',
    guest_upgraded:'游客升级',
    account_self_delete:'用户注销',
    settings_update:'修改服务器设置'
  };
  for(const l of data.logs){
    const tr=node('tr');
    tr.append(
      node('td',date(l.createdAt)),
      node('td',l.actorName+(l.actorId?' ('+l.actorId+')':'')),
      node('td',actionNames[l.action]||l.action),
      node('td',l.targetId||'—'),
      node('td',l.details?JSON.stringify(l.details):'—'),
      node('td',l.ip||'—')
    );
    $('auditBody').append(tr);
  }
  if(!data.total){
    const tr=node('tr'),td=node('td','暂无操作审计日志');td.colSpan=6;tr.append(td);$('auditBody').append(tr);
  }
}

$('moreRecords').onclick=()=>guarded(async()=>{$('moreRecords').disabled=true;try{await loadRecords();}finally{$('moreRecords').disabled=false;}});
$('allRecords').onclick=()=>guarded(async()=>{recordUser='';await refresh();});
$('allAuditLogs').onclick=()=>guarded(async()=>{auditOffset=0;$('auditBody').replaceChildren();await loadAuditLogs();});
$('moreAuditLogs').onclick=()=>guarded(async()=>{$('moreAuditLogs').disabled=true;try{await loadAuditLogs();}finally{$('moreAuditLogs').disabled=false;}});

$('settingsForm').onsubmit=e=>{
  e.preventDefault();
  guarded(async()=>{
    const b=e.submitter;if(b)b.disabled=true;
    try{
      const payload={
        registrationOpen: Boolean($('registration')?.checked),
        guestLoginOpen: Boolean($('guestLogin')?.checked),
        maxRooms: Math.min(100, Math.max(1, Math.floor(Number($('maxRooms')?.value || 5))))
      };
      await api('admin/settings',payload);
      message('服务器设置已保存并立即生效。');
      await refresh();
    }finally{if(b)b.disabled=false;}
  });
};

$('closeAccount').onclick=()=>$('accountDialog').close();
$('newAccount').onclick=()=>openAccount(null);
$('search').oninput=renderUsers;
$('filter').onchange=renderUsers;
$('refresh').onclick=()=>guarded(refresh);
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>guarded(()=>switchView(b.dataset.view)));

try{
  me=(await api('user/profile')).user;
  if(me.role!=='admin')throw new Error('当前账号没有管理员身份。');
  $('identity').textContent=me.username+' · 管理员';
  $('content').hidden=false;
  $('newAccount').hidden=!can('users');
  document.querySelectorAll('[data-view]').forEach(b=>{
    if(b.dataset.view==='users')b.hidden=!can('users')&&!can('records');
    else if(b.dataset.view==='audit')b.hidden=!can('users');
    else b.hidden=!can(b.dataset.view);
  });
  await switchView(can('users')||can('records')?'users':'settings');
}catch(e){
  $('locked').hidden=false;
  $('content').hidden=true;
  message(e.message);
}
