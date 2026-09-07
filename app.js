import {initial,names,group,play,key,other,actions,danger} from './engine.js';
import {OnlineConnection} from './online.js';
import {GameAudio} from './audio.js';
const sound=new GameAudio();
document.addEventListener('pointerdown',()=>sound.unlock(),{once:true});
document.addEventListener('keydown',()=>sound.unlock(),{once:true});
const $=id=>document.getElementById(id);
let board=initial(),side='r',mode='online',selected=null,records=[],snapshots=[],history=[key(board)],winner=null,busy=false,worker=null,job=0,pendingMode=null,last=null;
let animating=false,animationEpoch=0,eventText='',checked=[];
let netState=null,netConnected=false,netPending=false,onlineGameId=null,onlineSyncTarget=null;
const online=new OnlineConnection(receiveOnline,connectionStatus);
function myPlayer(){return netState?.room?.players.find(p=>p.id===netState.self.id);}
function canInteract(){return mode!=='online'||(netConnected&&!netPending&&netState?.room?.phase==='playing'&&netState.room.players.every(p=>p.connected)&&myPlayer()?.color===side&&records.length===netState.room.game.records.length);}
const title=s=>s==='r'?'红方':'黑方';
function svg(tag,attrs={},text=''){return `<${tag} ${Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}>${text}</${tag}>`;}
const point=i=>[54+i%9*64,57+Math.floor(i/9)*64];
function draw(){let out='<defs><radialGradient id="wood"><stop stop-color="#fff2ce"/><stop offset="1" stop-color="#e4c28c"/></radialGradient><radialGradient id="blackStone" cx="35%" cy="25%"><stop stop-color="#526057"/><stop offset="1" stop-color="#16251f"/></radialGradient><radialGradient id="whiteStone" cx="35%" cy="25%"><stop stop-color="#fffef6"/><stop offset="1" stop-color="#dbd9c7"/></radialGradient><filter id="shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="2" flood-opacity=".23"/></filter></defs>';
for(let y=0;y<10;y++)out+=svg('path',{d:`M54 ${57+y*64}H566`,class:'gridline'});for(let x=0;x<9;x++)out+=svg('path',{d:x===0||x===8?`M${54+x*64} 57V633`:`M${54+x*64} 57V313 M${54+x*64} 377V633`,class:'gridline'});
out+=svg('rect',{x:48,y:51,width:524,height:588,stroke:'#806845','stroke-width':2,fill:'none'});for(const y of [57,505])out+=svg('path',{d:`M246 ${y}L374 ${y+128}M374 ${y}L246 ${y+128}`,class:'gridline'});
out+=svg('text',{x:172,y:354,class:'river','text-anchor':'middle'},'楚河')+svg('text',{x:454,y:354,class:'river','text-anchor':'middle'},'漢界');
for(let x=0;x<9;x++)out+=svg('text',{x:54+x*64,y:664,class:'coord','text-anchor':'middle'},'ABCDEFGHI'[x]);for(let y=0;y<10;y++)out+=svg('text',{x:24,y:61+y*64,class:'coord'},10-y);
for(const i of [19,25,27,29,31,33,35,54,56,58,60,62,64,70]){const [x,y]=point(i);for(const dx of [-1,1])for(const dy of [-1,1]){if((i%9===0&&dx<0)||(i%9===8&&dx>0))continue;out+=svg('path',{d:`M${x+dx*6} ${y+dy*13}V${y+dy*6}H${x+dx*13}`,class:'gridline'});}}
if(last){const [x,y]=point(last.to);out+=svg('rect',{x:x-29,y:y-29,width:58,height:58,rx:9,fill:'#72895722',stroke:'#718352','stroke-width':2});}
let liberties=[];if(selected!=null){const g=group(board,selected);liberties=g.liberties;for(const i of g.cells){const [x,y]=point(i);out+=svg('circle',{cx:x,cy:y,r:29,fill:'#69805220',stroke:'#758b58','stroke-width':1});}for(const i of liberties){const [x,y]=point(i);out+=svg('circle',{cx:x,cy:y,r:5,fill:'#749261',opacity:.65});}}
if(selected!=null&&board[selected]?.s===side&&board[selected].t!=='g'&&!busy&&!winner&&!animating&&canInteract())for(let to=0;to<90;to++){const r=play(board,side,{from:selected,to},history);if(!r.error){const [x,y]=point(to);out+=svg('circle',{cx:x,cy:y,r:board[to]?29:10,fill:board[to]?'none':'#405f4277',stroke:'#405f42','stroke-width':2});}}
for(let i=0;i<90;i++){const p=board[i],[x,y]=point(i);if(p){const color=p.s==='r'?'#a23e2e':'#283d32';let body='';if(p.t==='g')body=svg('circle',{cx:x,cy:y,r:23,fill:p.s==='r'?'url(#whiteStone)':'url(#blackStone)',stroke:p.s==='r'?'#c6c4ae':'#21372b','stroke-width':1,filter:'url(#shadow)'});else body=svg('circle',{cx:x,cy:y,r:25,fill:'url(#wood)',stroke:p.s==='r'?'#ffffff':'#161616','stroke-width':4,filter:'url(#shadow)'})+svg('circle',{cx:x,cy:y,r:21,fill:'none',stroke:color,'stroke-width':1,opacity:.6})+svg('text',{x,y:y+10,'text-anchor':'middle',fill:color},names[p.s][p.t]);out+=svg('g',{class:'piece','data-piece':i},body);}out+=svg('circle',{cx:x,cy:y,r:31.8,class:'hit','data-i':i,tabindex:0,role:'button','aria-label':`${'ABCDEFGHI'[i%9]}${10-Math.floor(i/9)} ${p?title(p.s)+(p.t==='g'?'围棋子':names[p.s][p.t]):'空位'}`});}
out+=svg('circle',{id:'ghost',r:23,fill:side==='r'?'url(#whiteStone)':'url(#blackStone)',opacity:.5,'pointer-events':'none',visibility:'hidden'});
$('board').innerHTML=out;$('turn').textContent=winner?`${title(winner)}获胜`:animating?'落子有声…':busy?'黑方思考中…':`${title(side)}行棋`; $('event').hidden=!eventText;$('event').textContent=eventText;$('event').classList.toggle('warning',checked.length>0);$('turnDot').textContent=winner?'胜':side==='r'?'帥':'將';$('turnDot').style.color=side==='r'?'#a54938':'#263d32';$('status').textContent=winner?'将帅已被捕获，或对方无合法行动。':busy?'正在权衡走棋、落子与棋块的气。':`移动象棋，或落下一枚${side==='r'?'白':'黑'}子。`;$('round').textContent=`第 ${Math.floor(records.length/2)+1} 回合`;$('count').textContent=`${records.length} 手`;$('blackType').textContent=mode==='pve'?'人机':'玩家';for(const id of ['pve','pvp'])$(id).classList.toggle('active',mode===id);$('level').disabled=mode!=='pve';$('restart').disabled=mode==='online';for(const id of ['pve','pvp'])$(id).disabled=mode==='online';$('undo').disabled=mode==='online'||!snapshots.length;$('selection').textContent=selected!=null?`当前棋块 · ${group(board,selected).cells.length} 枚棋子 · ${liberties.length} 口气`:'点击棋子可查看所在棋块的气';if(records.length)$('history').innerHTML=records.map((r,n)=>`<div class="record"><b>${n+1}</b><i class="dot ${r.side==='r'?'red':'black'}"></i><span>${r.text}</span><em>${r.captured?'吃 / 提 '+r.captured+' 子':''}</em></div>`).join('');else $('history').innerHTML='<div class="empty"><span>弈</span><p>棋局未启，万象待生。</p></div>';
if(mode==='online'){const mine=myPlayer();$('blackType').textContent='联机';$('status').textContent=!netConnected?'连接中断，正在重连…':netState?.room?.players.some(p=>!p.connected)?'对手断线，暂停对局并等待重连。':winner?(netState?.room?.game?.reason||'对局结束'):mine?.color===side?'轮到你行棋。':'等待对手行棋。';if(!winner&&!animating)$('turn').textContent=mine?.color===side?'轮到你 · '+title(side):'等待'+title(side);}
}
function hint(t){$('hint').textContent=t;}
const coord=i=>'ABCDEFGHI'[i%9]+(10-Math.floor(i/9));
function refreshThreats(){checked=winner?[]:['r','b'].filter(s=>danger(board,s,history));}
async function commit(a){
  if(mode==='online'){if(!canInteract())return false;netPending=true;selected=null;draw();try{await online.command('move',{action:a,gameId:onlineGameId,ply:records.length});}catch(e){hint(e.message);}finally{netPending=false;if(!animating)draw();}return false;}

  const r=play(board,side,a,history);if(r.error){hint(r.error);return false;}
  const epoch=++animationEpoch;animating=true;selected=null;draw();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(a.from!=null){
    const el=$('board').querySelector(`[data-piece="${a.from}"]`),[x,y]=point(a.from),[u,v]=point(a.to);
    if(el){el.parentNode.appendChild(el);const anim=el.animate([{transform:'translate(0px,0px)'},{transform:`translate(${u-x}px,${v-y}px)`}],{duration:reduced?0:280,easing:'cubic-bezier(.2,.7,.2,1)',fill:'forwards'});await anim.finished.catch(()=>{});}
  }
  if(epoch!==animationEpoch)return false;
  snapshots.push({board,side,history:[...history],records:[...records],last,winner});
  const mover=side,name=a.from==null?(side==='r'?'白子':'黑子'):names[side][board[a.from].t];
  board=r.board;history.push(key(board));winner=r.winner;last=a;side=other(side);animating=false;
  if(!winner&&!actions(board,side,history).length)winner=other(side);
  refreshThreats();
  const captureText=r.captured.length?`${title(mover)}吃 / 提 ${r.captured.length} 子` : '';
  const checkText=checked.map(s=>`${title(s)}被将军！将帅面临吃子或围杀`).join('；');
  eventText=winner?`${title(winner)}获胜！${captureText}`:[captureText,checkText].filter(Boolean).join(' · ');
  records.push({side:mover,text:`${name} ${a.from==null?'落于':coord(a.from)+' →'} ${coord(a.to)}${checked.length?' · 将军':''}`,captured:r.captured.length});
  hint(winner?`${title(winner)}赢得这局棋。`:'点选己方象棋，或直接点击空位落围棋。');draw();
  sound.effect(a.from==null?'stone':'move');if(r.captured.length)sound.effect('capture');if(winner)sound.effect('win');else if(checked.length)sound.effect('check');
  if(a.from==null){const el=$('board').querySelector(`[data-piece="${a.to}"]`);el?.animate([{opacity:0},{opacity:1}],{duration:reduced?0:180});}
  $('history').scrollTop=$('history').scrollHeight;return true;
}
function think(){
  if(mode!=='pve'||side!=='b'||winner||animating)return;busy=true;selected=null;draw();hint('电脑正在推演将帅安全、吃子与围杀，可随时悔棋。');
  worker?.terminate();worker=new Worker('./ai.js',{type:'module'});const id=++job;
  worker.onmessage=async({data})=>{if(data.id!==job)return;worker?.terminate();worker=null;busy=false;
    if(data.error){hint('电脑计算失败，请悔棋后重试。');draw();return;}
    if(data.action)await commit(data.action);else{winner='r';eventText='红方获胜：黑方无合法行动。';draw();}
  };
  worker.onerror=()=>{worker?.terminate();worker=null;busy=false;hint('人机模块加载失败，请通过本地服务器打开游戏。');draw();};
  worker.postMessage({id,board,side,history,level:$('level').value});
}
async function click(i){
  if(busy||winner||animating||!canInteract())return;sound.unlock();
  if(selected!=null){
    const from=selected;selected=null;
    const r=play(board,side,{from,to:i},history);
    if(r.error){draw();hint(`${r.error} 已取消选中。`);return;}
    if(await commit({from,to:i}))think();return;
  }
  if(board[i]?.s===side&&board[i].t!=='g'){selected=i;draw();hint('大圆点 / 圆环是合法走位，小圆点是气；点击非法位置取消选中。');return;}
  if(!board[i]){if(await commit({from:null,to:i}))think();return;}
  const g=group(board,i);hint(`${title(board[i].s)}棋块：${g.cells.length} 枚棋子，${g.liberties.length} 口气。围棋不能移动。`);
}
function preview(i){
  const ghost=$('ghost');if(!ghost)return;
  const show=i!=null&&!board[i]&&selected==null&&!busy&&!winner&&!animating&&canInteract();
  ghost.setAttribute('visibility',show?'visible':'hidden');
  if(show){const [x,y]=point(i);ghost.setAttribute('cx',x);ghost.setAttribute('cy',y);const illegal=play(board,side,{to:i},history).error;ghost.setAttribute('opacity',illegal?.25:.52);ghost.setAttribute('stroke',illegal?'#b95040':'#71835d');}
}
$('board').addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;const t=e.target.closest('[data-i]');preview(t?Number(t.dataset.i):null);});
$('board').addEventListener('pointerleave',()=>preview(null));
$('board').addEventListener('focusin',e=>preview(e.target.dataset.i!=null?Number(e.target.dataset.i):null));
$('board').addEventListener('focusout',()=>preview(null));
$('board').addEventListener('click',e=>{const t=e.target.closest('[data-i]');if(t)click(Number(t.dataset.i));else if(selected!=null&&!animating&&!busy){selected=null;draw();hint('已取消选中。');}});
$('board').addEventListener('keydown',e=>{if(e.key==='Escape'&&!animating&&!busy){selected=null;draw();hint('已取消选中。');}else if((e.key==='Enter'||e.key===' ')&&e.target.dataset.i!=null){e.preventDefault();click(Number(e.target.dataset.i));}});
function reset(){worker?.terminate();worker=null;job++;animationEpoch++;animating=false;board=initial();side='r';selected=null;records=[];snapshots=[];history=[key(board)];winner=null;busy=false;last=null;checked=[];eventText='';if(pendingMode)mode=pendingMode;pendingMode=null;draw();hint('点选己方象棋行棋，或直接点击空位落围棋。');}
function requestReset(nextMode=null){if(mode==='online')return;pendingMode=nextMode;if(records.length)$('confirmDialog').showModal();else reset();}
$('restart').onclick=()=>requestReset();for(const id of ['pve','pvp'])$(id).onclick=()=>{if(mode!=='online'&&mode!==id)requestReset(id);};$('confirmReset').onclick=()=>{$('confirmDialog').close();reset();};$('cancelReset').onclick=()=>{$('confirmDialog').close();pendingMode=null;};
$('undo').onclick=()=>{if(mode==='online')return;worker?.terminate();worker=null;job++;animationEpoch++;animating=false;busy=false;let s=snapshots.pop();if(!s)return;if(mode==='pve'&&s.side==='b'&&snapshots.length)s=snapshots.pop();({board,side,history,records,last,winner}=s);selected=null;refreshThreats();eventText=checked.map(s=>`${title(s)}被将军！`).join('；');draw();hint('已撤回上一手；人机模式会回到你行动之前。');};$('rules').onclick=()=>$('rulesDialog').showModal();$('closeRules').onclick=()=>$('rulesDialog').close();$('level').onchange=()=>{if(busy)think();};draw();

$('music').onclick=()=>{sound.setMusic(!sound.musicOn);sound.unlock();$('music').textContent=sound.musicOn?'♫ 配乐开启':'♫ 配乐关闭';$('music').setAttribute('aria-pressed',String(sound.musicOn));};
$('effects').onclick=()=>{sound.effectsOn=!sound.effectsOn;$('effects').textContent=sound.effectsOn?'♪ 音效开启':'♪ 音效关闭';$('effects').setAttribute('aria-pressed',String(sound.effectsOn));};
$('volume').oninput=e=>sound.setVolume(Number(e.target.value)/100);
document.addEventListener('visibilitychange',()=>{if(document.hidden)sound.ctx?.suspend();else if(sound.ctx)sound.unlock();});

function connectionStatus(connected,message){netConnected=connected;$('connectionStatus').textContent=message;$('connectionStatus').classList.toggle('connected',connected);renderLobby();if(mode==='online')draw();}
function renderLobby(){
  $('lobby').hidden=mode!=='online';$('gameLayout').hidden=mode==='online'&&!netState?.room?.game;
  $('localPlay').disabled=!!netState?.room;
  $('playerName').textContent=netState?'你的棋名 · '+netState.self.name:'正在领取棋名…';
  const room=netState?.room,list=netState?.rooms||[];
  $('roomListArea').hidden=!!room;$('roomPanel').hidden=!room;$('roomCapacity').textContent=list.length+' / 5';
  $('createRoom').disabled=!netConnected||netPending||list.length>=5;
  $('roomList').replaceChildren();
  if(!list.length){const empty=document.createElement('p');empty.className='lobby-empty';empty.textContent='棋室静候来客。创建第一间房，邀朋友入座。';$('roomList').append(empty);}
  for(const r of list){const card=document.createElement('article');card.className='room-card';const title=document.createElement('h3');title.textContent=r.name;const detail=document.createElement('p');detail.textContent=r.players.map(p=>p.name).join(' · ');const status=document.createElement('span');status.textContent=`${r.count} / 2 人 · ${r.phase==='playing'?'对局中':r.phase==='finished'?'已结束':'待开局'}`;const button=document.createElement('button');button.textContent=r.count>=2?'已满':'入座 →';button.disabled=!netConnected||netPending||r.count>=2||r.phase==='playing';button.onclick=()=>roomCommand('join',{roomId:r.id});card.append(title,detail,status,button);$('roomList').append(card);}
  if(!room)return;
  $('roomName').textContent=room.name;
  $('roomPhase').textContent=room.phase==='playing'?'对局进行中':room.phase==='finished'?'本局结束 · 可再次准备':'等待双方准备';
  $('seats').replaceChildren();for(let i=0;i<2;i++){const p=room.players[i],seat=document.createElement('div');seat.className='seat';const name=document.createElement('strong'),status=document.createElement('span');name.textContent=p?p.name+(p.id===netState.self.id?'（你）':''):'虚位以待';status.textContent=!p?'等待另一位棋友':!p.connected?'断线 · 保留座位 30 秒':room.phase==='playing'?`${title(p.color)} · ${p.color==='r'?'白子 / 白圈':'黑子 / 黑圈'}`:p.ready?'已准备 ✓':'未准备';seat.append(name,status);$('seats').append(seat);}
  const mine=myPlayer();$('readyRoom').hidden=room.phase==='playing';$('readyRoom').disabled=!netConnected||netPending;$('readyRoom').textContent=mine?.ready?'取消准备':room.phase==='finished'?'准备再来一局':'准备';$('leaveRoom').disabled=!netConnected||netPending;
  $('roomHelp').textContent=room.players.some(p=>!p.connected)?'正在等待重连；超时后自动离房。':room.phase==='playing'?`你执${mine?.color==='r'?'红':'黑'}，红方先行。`:room.players.length<2?'等待另一位玩家入座。':'双方都准备后自动开局，重新随机分配红黑。';
}
function receiveOnline(state){
  netState=state;renderLobby();
  if(mode!=='online')return;
  syncOnline(state);
}
async function syncOnline(state){
  const g=state.room?.game;
  const signature=g?`${g.id}:${g.records.length}:${g.winner}:${state.room.phase}`:null;
  if(signature&&signature===onlineSyncTarget){if(!animating)draw();return;}
  onlineSyncTarget=signature;
  const epoch=++animationEpoch;
  worker?.terminate();worker=null;job++;busy=false;selected=null;
  if(!g){onlineGameId=null;board=initial();side='r';records=[];history=[key(board)];winner=null;last=null;checked=[];eventText='';animating=false;draw();return;}
  const isMove=g.id===onlineGameId&&g.records.length===records.length+1;
  if(isMove&&g.last?.from!=null){animating=true;draw();const el=$('board').querySelector(`[data-piece="${g.last.from}"]`),[x,y]=point(g.last.from),[u,v]=point(g.last.to);
    if(el){el.parentNode.appendChild(el);await el.animate([{transform:'translate(0,0)'},{transform:`translate(${u-x}px,${v-y}px)`}],{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:280,easing:'ease-out',fill:'forwards'}).finished.catch(()=>{});}
  }
  if(epoch!==animationEpoch||mode!=='online')return;
  animating=false;onlineGameId=g.id;board=g.board;side=g.turn;records=g.records;history=g.history;winner=g.winner;last=g.last;checked=g.checked;snapshots=[];
  const record=records.at(-1),capture=record?.captured?`${title(record.side)}吃 / 提 ${record.captured} 子`:'';
  eventText=winner?`${title(winner)}获胜 · ${g.reason}`:[capture,...checked.map(s=>`${title(s)}被将军！`)].filter(Boolean).join(' · ');
  draw();hint(winner?'本局结束，双方准备后可再来一局。':myPlayer()?.color===side?'轮到你：点选己方象棋或点击空位落围棋。':'等待对手行动。');
  if(isMove){sound.effect(g.last.from==null?'stone':'move');if(record.captured)sound.effect('capture');if(winner)sound.effect('win');else if(checked.length)sound.effect('check');$('history').scrollTop=$('history').scrollHeight;}
}
async function roomCommand(type,data={}){if(netPending||!netConnected)return;netPending=true;$('lobbyError').hidden=true;renderLobby();try{await online.command(type,data);}catch(e){$('lobbyError').textContent=e.message;$('lobbyError').hidden=false;}finally{netPending=false;renderLobby();}}
$('createRoom').onclick=()=>roomCommand('create');$('readyRoom').onclick=()=>roomCommand('ready',{ready:!myPlayer()?.ready});
$('leaveRoom').onclick=()=>{if(netState?.room?.phase==='playing')$('leaveDialog').showModal();else roomCommand('leave');};
$('cancelLeave').onclick=()=>$('leaveDialog').close();$('confirmLeave').onclick=()=>{$('leaveDialog').close();roomCommand('leave');};
$('enterLobby').onclick=()=>{if(mode==='online')return;mode='online';onlineSyncTarget=null;worker?.terminate();worker=null;job++;animationEpoch++;animating=false;busy=false;selected=null;renderLobby();if(netState)syncOnline(netState);online.start();};
$('localPlay').onclick=()=>{if(netState?.room)return;mode='pve';reset();renderLobby();};
renderLobby();online.start();
