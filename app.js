import {initial,names,group,play,key,other,actions,danger} from './engine.js';
import {OnlineConnection} from './online.js';
import {GameAudio} from './audio.js';
const sound=new GameAudio();
sound.unlock();
document.addEventListener('pointerdown',()=>sound.unlock(),{once:true});
document.addEventListener('keydown',()=>sound.unlock(),{once:true});
const $=id=>document.getElementById(id);
let board=initial(),side='r',mode='online',selected=null,records=[],snapshots=[],history=[key(board)],winner=null,busy=false,worker=null,job=0,pendingMode=null,last=null;
const initParamPage = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('page') : null;
let page = (initParamPage === 'lobby' || initParamPage === 'profile' || initParamPage === 'game') ? initParamPage : 'menu';
let humanSide = 'r', leaveDestination = 'lobby';
if (page === 'lobby') mode = 'online';
let animating=false,animationEpoch=0,eventText='',checked=[];
let netState=null,netConnected=false,netPending=false,onlineGameId=null,onlineSyncTarget=null;
let localClock={r:600000,b:600000},localTick=Date.now(),localMessages=[],messageFilter='all',messageSignature='',serverOffset=0,chatSending=false;
const online=new OnlineConnection(receiveOnline,connectionStatus);
function myPlayer(){return netState?.room?.players.find(p=>p.id===netState.self.id);}
function canInteract(){return page==='game'&&(mode!=='online'?mode!=='pve'||side===humanSide:(netConnected&&!netPending&&netState?.room?.phase==='playing'&&netState.room.players.every(p=>p.connected)&&myPlayer()?.color===side&&records.length===netState.room.game.records.length));}
const title=s=>s==='r'?'红方':'黑方';
function svg(tag,attrs={},text=''){return `<${tag} ${Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}>${text}</${tag}>`;}
const perspective=()=>mode==='online'?(myPlayer()?.color||'r'):mode==='pve'?humanSide:side;
const point=i=>{const n=perspective()==='b'?89-i:i;return [54+n%9*64,57+Math.floor(n/9)*64];};
function renderPage(){
  document.body.classList.toggle('in-game',page==='game');
  $('mainMenu').hidden=page!=='menu';$('lobby').hidden=page!=='lobby';$('gamePage').hidden=page!=='game';$('profilePage').hidden=page!=='profile';
}
function showPage(next){const changed=page!==next;page=next;renderPage();if(changed){window.scrollTo(0,0);const target=$(next==='menu'?'enterLobby':next==='lobby'?'createRoom':next==='profile'?'openProfileSettings':'gameTitle');target.tabIndex=target.tabIndex<0?-1:target.tabIndex;target.focus({preventScroll:true});}}
function cancelLocal(){worker?.terminate();worker=null;job++;animationEpoch++;animating=false;busy=false;selected=null;}
function boardLabels(){const own=perspective(),opponent=other(own);const label=s=>title(s)+' · '+(s==='r'?'白子':'黑子');$('selfLabel').textContent=label(own)+(mode==='pvp'?' · 当前行棋方':' · 你');$('opponentLabel').textContent=label(opponent)+(mode==='pve'?' · 电脑':' · 对手');$('gameTitle').textContent=mode==='online'?'联机对局':mode==='pve'?'人机练习':'同屏双人';$('gameMode').textContent=mode==='online'?'ONLINE':mode.toUpperCase();$('gameSettings').textContent=mode==='pve'?'你执'+title(humanSide)+' · '+$('level').selectedOptions[0].textContent:mode==='online'?'你执'+title(own)+' · 红方先行':'轮流行棋 · 当前行棋方在下方';$('gameBack').textContent=mode==='online'?'返回房间':'返回主菜单';}
function draw(){let out='<defs><radialGradient id="wood"><stop stop-color="#fff2ce"/><stop offset="1" stop-color="#e4c28c"/></radialGradient><radialGradient id="blackStone" cx="35%" cy="25%"><stop stop-color="#526057"/><stop offset="1" stop-color="#16251f"/></radialGradient><radialGradient id="whiteStone" cx="35%" cy="25%"><stop stop-color="#fffef6"/><stop offset="1" stop-color="#dbd9c7"/></radialGradient><filter id="shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="2" flood-opacity=".23"/></filter></defs>';
for(let y=0;y<10;y++)out+=svg('path',{d:`M54 ${57+y*64}H566`,class:'gridline'});for(let x=0;x<9;x++)out+=svg('path',{d:x===0||x===8?`M${54+x*64} 57V633`:`M${54+x*64} 57V313 M${54+x*64} 377V633`,class:'gridline'});
out+=svg('rect',{x:48,y:51,width:524,height:588,stroke:'#806845','stroke-width':2,fill:'none'});for(const y of [57,505])out+=svg('path',{d:`M246 ${y}L374 ${y+128}M374 ${y}L246 ${y+128}`,class:'gridline'});
out+=svg('text',{x:172,y:354,class:'river','text-anchor':'middle'},'楚河')+svg('text',{x:454,y:354,class:'river','text-anchor':'middle'},'漢界');
for(let x=0;x<9;x++)out+=svg('text',{x:54+x*64,y:664,class:'coord','text-anchor':'middle'},'ABCDEFGHI'[perspective()==='b'?8-x:x]);for(let y=0;y<10;y++)out+=svg('text',{x:24,y:61+y*64,class:'coord'},perspective()==='b'?y+1:10-y);
for(const i of [19,25,27,29,31,33,35,54,56,58,60,62,64,70]){const [x,y]=point(i);for(const dx of [-1,1])for(const dy of [-1,1]){if((x===54&&dx<0)||(x===566&&dx>0))continue;out+=svg('path',{d:`M${x+dx*6} ${y+dy*13}V${y+dy*6}H${x+dx*13}`,class:'gridline'});}}
if(last){const [x,y]=point(last.to);out+=svg('rect',{x:x-29,y:y-29,width:58,height:58,rx:9,fill:'#72895722',stroke:'#718352','stroke-width':2});}
let liberties=[];if(selected!=null){const g=group(board,selected);liberties=g.liberties;for(const i of g.cells){const [x,y]=point(i);out+=svg('circle',{cx:x,cy:y,r:29,fill:'#69805220',stroke:'#758b58','stroke-width':1});}for(const i of liberties){const [x,y]=point(i);out+=svg('circle',{cx:x,cy:y,r:5,fill:'#749261',opacity:.65});}}
if(selected!=null&&board[selected]?.s===side&&board[selected].t!=='g'&&!busy&&!winner&&!animating&&canInteract())for(let to=0;to<90;to++){const r=play(board,side,{from:selected,to},history);if(!r.error){const [x,y]=point(to);out+=svg('circle',{cx:x,cy:y,r:board[to]?29:10,fill:board[to]?'none':'#405f4277',stroke:'#405f42','stroke-width':2});}}
for(let i=0;i<90;i++){const p=board[i],[x,y]=point(i);if(p){const color=p.s==='r'?'#a23e2e':'#283d32';let body='';if(p.t==='g')body=svg('circle',{cx:x,cy:y,r:23,fill:p.s==='r'?'url(#whiteStone)':'url(#blackStone)',stroke:p.s==='r'?'#c6c4ae':'#21372b','stroke-width':1,filter:'url(#shadow)'});else body=svg('circle',{cx:x,cy:y,r:25,fill:'url(#wood)',stroke:p.s==='r'?'#ffffff':'#161616','stroke-width':4,filter:'url(#shadow)'})+svg('circle',{cx:x,cy:y,r:21,fill:'none',stroke:color,'stroke-width':1,opacity:.6})+svg('text',{x,y:y+10,'text-anchor':'middle',fill:color},names[p.s][p.t]);out+=svg('g',{class:'piece','data-piece':i},body);}out+=svg('circle',{cx:x,cy:y,r:31.8,class:'hit','data-i':i,tabindex:0,role:'button','aria-label':`${'ABCDEFGHI'[i%9]}${10-Math.floor(i/9)} ${p?title(p.s)+(p.t==='g'?'围棋子':names[p.s][p.t]):'空位'}`});}
out+=svg('circle',{id:'ghost',r:23,fill:side==='r'?'url(#whiteStone)':'url(#blackStone)',opacity:.5,'pointer-events':'none',visibility:'hidden'});
$('board').innerHTML=out;const isDraw=winner==='d'||(mode==='online'&&netState?.room?.phase==='finished'&&!winner);const isFinished=!!winner||(mode==='online'&&netState?.room?.phase==='finished');$('turn').textContent=isDraw?'双方和棋':winner?`${title(winner)}获胜`:animating?'落子有声…':busy?`${title(side)}思考中…`:`${title(side)}行棋`; $('event').hidden=!eventText;$('event').textContent=eventText;$('event').classList.toggle('warning',checked.length>0);$('turnDot').textContent=isDraw?'和':winner?'胜':side==='r'?'帥':'將';$('turnDot').style.color=isDraw?'#7a8871':side==='r'?'#a54938':'#263d32';$('status').textContent=isDraw?'双方协商和棋。准备后可开始新一局。':winner?'将帅已被捕获，或对方无合法行动。准备后可开始新一局。':busy?'正在权衡走棋、落子与棋块的气。':`移动象棋，或落下一枚${side==='r'?'白':'黑'}子。`;$('round').textContent=`第 ${Math.floor(records.length/2)+1} 回合`;$('count').textContent=`${records.length} 手`;boardLabels();$('restart').disabled=mode==='online';$('undo').disabled=mode==='online'||!snapshots.length;$('selection').textContent=selected!=null?`当前棋块 · ${group(board,selected).cells.length} 枚棋子 · ${liberties.length} 口气`:'点击棋子可查看所在棋块的气';renderMatch();
if(mode==='online'){const mine=myPlayer();$('status').textContent=!netConnected?'连接中断，正在重连…':netState?.room?.players.some(p=>!p.connected)?'对手断线，暂停对局并等待重连。':isFinished?(netState?.room?.game?.reason||(isDraw?'双方和棋':'对局结束')):mine?.color===side?'轮到你行棋。':'等待对手行棋。';if(!isFinished&&!animating)$('turn').textContent=mine?.color===side?'轮到你 · '+title(side):'等待'+title(side);}
}
function updateClocks(){
  const now=Date.now();
  const isFinished=!!winner||(mode==='online'&&netState?.room?.phase==='finished');
  if(mode!=='online'&&page==='game'&&!isFinished){localClock[side]=Math.max(0,localClock[side]-(now-localTick));if(localClock[side]===0){winner=other(side);cancelLocal();eventText=title(winner)+'获胜 · 对方行棋时间耗尽';localMessages.push({kind:'system',at:now,text:eventText});draw();}}
  localTick=now;
  const g=netState?.room?.game,c=mode==='online'?g?.clock:null;
  for(const [color,prefix] of [['r','red'],['b','black']]){let ms=mode==='online'?(c?.remaining[color]??600000):localClock[color];if(c&&c.runningSince!=null&&g.turn===color)ms-=Math.max(0,now+serverOffset-c.runningSince);const sec=Math.max(0,Math.ceil(ms/1000));$(prefix+'Clock').textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');$(prefix+'Clock').classList.toggle('active',!isFinished&&(mode==='online'?g?.turn:side)===color);$(prefix+'Clock').classList.toggle('urgent',sec<=30&&!isFinished);}
  const absent=mode==='online'?netState?.room?.players.filter(p=>!p.connected):[];
  const waiting=netState?.room?.phase==='playing'&&(absent?.length||!netConnected)&&mode==='online';
  $('disconnectCountdown').hidden=!waiting;
  if(waiting)$('disconnectCountdown').textContent=absent?.length?absent.map(p=>p.name+' · 等待重连 '+Math.max(0,Math.ceil((p.reconnectDeadline-now-serverOffset)/1000))+' 秒').join(' / '):'连接中断，正在恢复连接…';
}
function renderMatch(){
  for(const [color,prefix] of [['r','red'],['b','black']]){const p=mode==='online'?netState?.room?.players.find(p=>p.color===color):null;$(prefix+'Name').textContent=p?p.name+(p.id===netState.self.id?'（你）':''):mode==='pve'?(color===humanSide?'你':'电脑')+' · '+title(color):title(color);$(prefix+'Connection').textContent=p?(p.connected?'在线 · ':'断线 · ')+title(color):mode==='online'?'等待入座':'本地 · '+(color==='r'?'白子':'黑子');renderAvatarElement($(prefix+'Avatar'),p?.avatar||(color==='r'?'帥':'將'));$(prefix+'Avatar').classList.toggle('black-avatar',color==='b');$(prefix+'Avatar').classList.toggle('red-avatar',color==='r');}
  const isFinished=!!winner||(mode==='online'&&netState?.room?.phase==='finished');
  $('resign').disabled=!!isFinished||(mode==='online'&&(!netConnected||netState?.room?.phase!=='playing'));
  const offerBtn=$('offerDraw')||$('matchRules');
  if(offerBtn){
    if(mode==='online'){
      const canOffer=netConnected&&netState?.room?.phase==='playing'&&!isFinished;
      const myColor=myPlayer()?.color;
      const drawOffer=netState?.room?.game?.drawOffer;
      offerBtn.disabled=!canOffer||drawOffer===myColor;
      offerBtn.textContent=drawOffer===myColor?'等待对方求和回应…':'🤝 请求和棋';
    }else if(mode==='pve'){
      offerBtn.disabled=!!isFinished;
      offerBtn.textContent='🤝 请求和棋';
    }else{
      offerBtn.disabled=!!isFinished;
      offerBtn.textContent='🤝 协商和棋';
    }
  }
  const enabled=mode==='online'&&netConnected&&!!netState?.room;
  $('chatInput').disabled=!enabled;$('chatSend').disabled=!enabled||chatSending;$('emojiToggle').disabled=!enabled;
  if(!enabled)$('chatNotice').textContent=mode==='online'?'连接房间后可聊天':'联机对局可发送消息与表情';else if(!chatSending)$('chatNotice').textContent='最多 300 字 · 房间内可见';
  renderMessages();updateClocks();
}
function renderMessages(){
  const messages=mode==='online'?(netState?.room?.messages||[]):[...localMessages,...records.map((r,i)=>({...r,kind:'record',ply:i+1}))].sort((a,b)=>(a.at||0)-(b.at||0));
  const filtered=messages.filter(m=>messageFilter==='all'||m.kind===messageFilter);
  const sig=JSON.stringify([mode,netState?.room?.id,messageFilter,filtered]);if(sig===messageSignature)return;messageSignature=sig;
  const log=$('history'),bottom=log.scrollHeight-log.scrollTop-log.clientHeight<65;log.replaceChildren();
  if(!filtered.length){const el=document.createElement('p');el.className='empty';el.textContent='落子成章，静候棋友。';log.append(el);}
  for(const m of filtered){const el=document.createElement('div'),meta=document.createElement('span');el.className='message '+m.kind+(m.senderId===netState?.self?.id?' own':'');meta.className='message-meta';const time=new Date(m.at||Date.now()).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});meta.textContent=(m.kind==='chat'?m.name:m.kind==='record'?'第 '+m.ply+' 手 · '+title(m.side):'系统')+' · '+time;const text=document.createElement('span');text.textContent=m.text+(m.captured?' · 吃 / 提 '+m.captured+' 子':'');if(m.kind==='chat'){const avatar=document.createElement('span');avatar.className='seat-avatar';renderAvatarElement(avatar,netState?.room?.players.find(p=>p.id===m.senderId)?.avatar||'客');const content=document.createElement('div');text.className='message-bubble';content.append(meta,text);el.append(avatar,content);}else el.append(meta,text);log.append(el);}
  if(bottom)log.scrollTop=log.scrollHeight;
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
  updateClocks();if(winner)return false;snapshots.push({board,side,history:[...history],records:[...records],last,winner,clock:{...localClock}});
  const mover=side,name=a.from==null?(side==='r'?'白子':'黑子'):names[side][board[a.from].t];
  board=r.board;history.push(key(board));winner=r.winner;last=a;side=other(side);animating=false;
  if(!winner&&!actions(board,side,history).length)winner=other(side);
  refreshThreats();
  const captureText=r.captured.length?`${title(mover)}吃 / 提 ${r.captured.length} 子` : '';
  const checkText=checked.map(s=>`${title(s)}被将军！将帅面临吃子或围杀`).join('；');
  eventText=winner?`${title(winner)}获胜！${captureText}`:[captureText,checkText].filter(Boolean).join(' · ');
  records.push({at:Date.now(),side:mover,text:`${name} ${a.from==null?'落于':coord(a.from)+' →'} ${coord(a.to)}${checked.length?' · 将军':''}`,captured:r.captured.length});
  hint(winner?`${title(winner)}赢得这局棋。`:'点选己方象棋，或直接点击空位落围棋。');draw();
  sound.effect(a.from==null?'stone':'move');if(r.captured.length)sound.effect('capture');if(winner)sound.effect('win');else if(checked.length)sound.effect('check');
  if(a.from==null){const el=$('board').querySelector(`[data-piece="${a.to}"]`);el?.animate([{opacity:0},{opacity:1}],{duration:reduced?0:180});}
  $('history').scrollTop=$('history').scrollHeight;return true;
}
function think(){
  if(mode!=='pve'||side===humanSide||winner||animating||page!=='game')return;busy=true;selected=null;draw();hint('电脑正在推演将帅安全、吃子与围杀，可随时悔棋。');
  worker?.terminate();worker=new Worker('./ai.js',{type:'module'});const id=++job;
  worker.onmessage=async({data})=>{if(data.id!==job)return;worker?.terminate();worker=null;busy=false;
    if(data.error){hint('电脑计算失败，请悔棋后重试。');draw();return;}
    if(data.action)await commit(data.action);else{winner=humanSide;eventText=`${title(humanSide)}获胜：对方无合法行动。`;draw();}
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
function reset(){localClock={r:600000,b:600000};localTick=Date.now();localMessages=[{kind:'system',at:Date.now(),text:'对局开始 · 每方 10 分钟 · 红方先行'}];messageSignature='';worker?.terminate();worker=null;job++;animationEpoch++;animating=false;board=initial();side='r';selected=null;records=[];snapshots=[];history=[key(board)];winner=null;busy=false;last=null;checked=[];eventText='';if(pendingMode)mode=pendingMode;pendingMode=null;draw();hint('点选己方象棋行棋，或直接点击空位落围棋。');think();}
function requestReset(nextMode=null){if(mode==='online')return;pendingMode=nextMode;if(records.length)$('confirmDialog').showModal();else reset();}
$('restart').onclick=()=>requestReset();$('confirmReset').onclick=()=>{$('confirmDialog').close();reset();};$('cancelReset').onclick=()=>{$('confirmDialog').close();pendingMode=null;};
$('undo').onclick=()=>{if(mode==='online')return;worker?.terminate();worker=null;job++;animationEpoch++;animating=false;busy=false;let s=snapshots.pop();if(!s)return;if(mode==='pve'&&s.side!==humanSide&&snapshots.length)s=snapshots.pop();({board,side,history,records,last,winner}=s);localClock={...s.clock};localTick=Date.now();localMessages.push({kind:'system',at:Date.now(),text:'已悔棋，棋钟恢复至该步之前。'});selected=null;refreshThreats();eventText=checked.map(s=>`${title(s)}被将军！`).join('；');draw();hint('已撤回上一手；人机模式会回到你行动之前。');think();};$('rules').onclick=()=>$('rulesDialog').showModal();$('closeRules').onclick=()=>$('rulesDialog').close();$('level').onchange=()=>{if(busy)think();};draw();

$('music').onclick=()=>{sound.setMusic(!sound.musicOn);sound.unlock();$('music').textContent=sound.musicOn?'♫ 配乐开启':'♫ 配乐关闭';$('music').setAttribute('aria-pressed',String(sound.musicOn));};
$('effects').onclick=()=>{sound.effectsOn=!sound.effectsOn;$('effects').textContent=sound.effectsOn?'♪ 音效开启':'♪ 音效关闭';$('effects').setAttribute('aria-pressed',String(sound.effectsOn));};
$('volume').oninput=e=>sound.setVolume(Number(e.target.value)/100);
document.addEventListener('visibilitychange',()=>{if(document.hidden)sound.ctx?.suspend();else if(sound.ctx)sound.unlock();});

function connectionStatus(connected,message){netConnected=connected;$('connectionStatus').textContent=message;$('connectionStatus').classList.toggle('connected',connected);renderLobby();if(mode==='online')draw();}
function renderLobby(){
  renderPage();$('returnGame').hidden=!netState?.room?.game;
  $('localPlay').disabled=!!netState?.room;
  $('playerName').textContent=netState?'你的棋名 · '+netState.self.name:'正在领取棋名…';
  const room=netState?.room,list=netState?.rooms||[];
  $('roomListArea').hidden=!!room;$('roomPanel').hidden=!room;$('roomCapacity').textContent=list.length+' / '+(netState?.maxRooms??5);
  $('createRoom').disabled=!netConnected||netPending||list.length>=(netState?.maxRooms??5);
  $('roomList').replaceChildren();
  if(!list.length){const empty=document.createElement('p');empty.className='lobby-empty';empty.textContent='棋室静候来客。创建第一间房，邀朋友入座。';$('roomList').append(empty);}
  for(const r of list){const card=document.createElement('article');card.className='room-card';const title=document.createElement('h3');title.textContent=r.name;const detail=document.createElement('p');detail.textContent=r.players.map(p=>p.name).join(' · ');const status=document.createElement('span');status.textContent=`${r.count} / 2 人 · ${r.phase==='playing'?'对局中':r.phase==='finished'?'已结束':'待开局'}`;const button=document.createElement('button');button.textContent=r.count>=2?'已满':'入座 →';button.disabled=!netConnected||netPending||r.count>=2||r.phase==='playing';button.onclick=()=>roomCommand('join',{roomId:r.id});card.append(title,detail,status,button);$('roomList').append(card);}
  if(!room)return;
  $('roomName').textContent=room.name;
  $('roomPhase').textContent=room.phase==='playing'?'对局进行中':room.phase==='finished'?'本局结束 · 可再次准备':'等待双方准备';
  $('seats').replaceChildren();for(let i=0;i<2;i++){const p=room.players[i],seat=document.createElement('div');seat.className='seat'+(p?.ready?' ready':'');const avatar=document.createElement('div');avatar.className='seat-avatar'+(!p?' empty':'');if(p){renderAvatarElement(avatar,p.avatar,false);}else{avatar.textContent='待';}const info=document.createElement('div');info.className='seat-info';const name=document.createElement('strong'),status=document.createElement('span');name.textContent=p?p.name+(p.id===netState.self.id?'（你）':''):'虚位以待';status.textContent=!p?'等待另一位棋友':!p.connected?'断线 · 保留座位 30 秒':room.phase==='playing'?`${title(p.color)} · ${p.color==='r'?'白子 / 白圈':'黑子 / 黑圈'}`:p.ready?'已准备 ✓':'未准备';info.append(name,status);seat.append(avatar,info);$('seats').append(seat);}
  const mine=myPlayer();$('readyRoom').hidden=room.phase==='playing';$('readyRoom').disabled=!netConnected||netPending;$('readyRoom').textContent=mine?.ready?'取消准备':room.phase==='finished'?'准备再来一局':'准备';$('leaveRoom').disabled=!netConnected||netPending;
  $('roomHelp').textContent=room.players.some(p=>!p.connected)?'正在等待重连；超时后自动离房。':room.phase==='playing'?`你执${mine?.color==='r'?'红':'黑'}，红方先行。`:room.players.length<2?'等待另一位玩家入座。':'双方都准备后自动开局，重新随机分配红黑。';
}
function receiveOnline(state){
  const previousGame=netState?.room?.game?.id;netState=state;serverOffset=(state.serverNow??Date.now())-Date.now();renderMatch();
  if(mode==='online'){if(state.room?.game&&(page==='menu'||state.room.game.id!==previousGame))showPage('game');else if(!state.room?.game&&page==='game')showPage('lobby');}
  renderLobby();
  if(mode!=='online')return;
  syncOnline(state);
}
async function syncOnline(state){
  const g=state.room?.game;
  const signature=g?`${g.id}:${g.records.length}:${g.winner}:${state.room.phase}:${g.drawOffer}`:null;
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
  animating=false;onlineGameId=g.id;board=g.board;side=g.turn;records=g.records;history=g.history;
  winner=g.winner||(state.room?.phase==='finished'?'d':null);
  last=g.last;checked=g.checked;snapshots=[];
  const isDraw=winner==='d';
  const record=records.at(-1),capture=record?.captured?`${title(record.side)}吃 / 提 ${record.captured} 子`:'';
  eventText=winner?(isDraw?(g.reason?`${g.reason} · 对局和棋`:'双方协商和棋 · 对局和棋'):`${title(winner)}获胜 · ${g.reason}`):[capture,...checked.map(s=>`${title(s)}被将军！`)].filter(Boolean).join(' · ');
  draw();hint(winner?(isDraw?'本局结束，双方和棋。双方准备后可再来一局。':'本局结束，双方准备后可再来一局。'):myPlayer()?.color===side?'轮到你：点选己方象棋或点击空位落围棋。':'等待对手行动。');
  if(isMove){sound.effect(g.last.from==null?'stone':'move');if(record.captured)sound.effect('capture');if(winner&&!isDraw)sound.effect('win');else if(checked.length)sound.effect('check');$('history').scrollTop=$('history').scrollHeight;}
  const myColor=myPlayer()?.color;
  if(g.drawOffer&&g.drawOffer!==myColor&&state.room?.phase==='playing'){
    if(!$('drawOfferDialog')?.open){
      const opponent=state.room?.players?.find(p=>p.color===g.drawOffer);
      if($('drawOfferPlayerName')&&opponent)$('drawOfferPlayerName').textContent=opponent.name;
      try{$('drawOfferDialog').showModal();}catch{}
    }
  }else{
    if($('drawOfferDialog')?.open)$('drawOfferDialog').close();
    if(winner&&$('drawConfirmDialog')?.open)$('drawConfirmDialog').close();
  }
}
async function roomCommand(type,data={}){if(netPending||!netConnected)return;netPending=true;$('lobbyError').hidden=true;renderLobby();try{await online.command(type,data);}catch(e){$('lobbyError').textContent=e.message;$('lobbyError').hidden=false;}finally{netPending=false;renderLobby();}}
$('createRoom').onclick=()=>roomCommand('create');$('readyRoom').onclick=()=>roomCommand('ready',{ready:!myPlayer()?.ready});
async function leaveTo(destination){leaveDestination=destination;if(netState?.room?.phase==='playing'){$('leaveDialog').showModal();return;}await roomCommand('leave');if(!netState?.room)showPage(destination);}
$('leaveRoom').onclick=()=>leaveTo('lobby');
$('cancelLeave').onclick=()=>$('leaveDialog').close();$('confirmLeave').onclick=async()=>{$('leaveDialog').close();await roomCommand('leave');if(!netState?.room)showPage(leaveDestination);};
$('enterLobby').onclick=()=>{if(!currentUser){openAuthDialog("login");return;}mode='online';onlineSyncTarget=null;cancelLocal();showPage(netState?.room?.game?'game':'lobby');renderLobby();if(netState)syncOnline(netState);online.start();};
$('localPlay').onclick=()=>{if(netState?.room)return;$('practiceDialog').showModal();};
$('closePractice').onclick=()=>$('practiceDialog').close();
$('practiceMode').onchange=()=>{const pvp=$('practiceMode').value==='pvp';$('difficultyField').hidden=pvp;$('playerSide').disabled=pvp;$('practiceNote').textContent=pvp?'同屏双人随行棋方翻转，当前行棋方始终在下方。':'己方在棋盘下方；选择黑方时，电脑执红先行。';};
$('practiceForm').onsubmit=e=>{e.preventDefault();mode=$('practiceMode').value;humanSide=$('playerSide').value;$('practiceDialog').close();showPage('game');reset();};
function goHome(){if(netState?.room){leaveTo('menu');return;}cancelLocal();showPage('menu');}
$('homeBrand').onclick=e=>{e.preventDefault();goHome();};
$('gameBack').onclick=()=>{if(mode==='online')showPage('lobby');else goHome();};
$('returnGame').onclick=()=>{showPage('game');draw();};


const AUTO_LOGIN_KEY='xiangqi_auto_login';

function clearLegacySavedPassword(){
  try{
    localStorage.removeItem('xiangqi_saved_pwd');
    sessionStorage.removeItem('xiangqi_saved_pwd');
  }catch{}
}
clearLegacySavedPassword();

function prefillLoginForm(){
  try{
    const auto=localStorage.getItem(AUTO_LOGIN_KEY);
    if($('autoLogin'))$('autoLogin').checked=auto===null?true:auto==='true';
  }catch{}
}

const AVATARS=['帥','將','仕','士','相','象','車','馬','炮','兵','卒','弈','墨','客','竹','松','泉','月','风','云'];
let currentUser=null,selectedRegAvatar='弈',selectedEditAvatar='弈',adminUsersList=[];


function renderAvatarElement(el,avatar,isLarge=false){
  if(!el)return;
  el.replaceChildren();
  if(typeof avatar==='string'&&avatar.startsWith('data:image/')){
    const img=document.createElement('img');
    img.src=avatar;img.alt='头像';
    img.className=isLarge?'avatar-img-lg':'avatar-img';
    el.append(img);
  }else{
    el.textContent=avatar||'客';
  }
}

function processAvatarFile(file,callback){
  if(!file)return;
  if(!file.type.startsWith('image/')){
    alert('请选择有效的图片文件。');return;
  }
  const reader=new FileReader();
  reader.onload=e=>{
    const img=new Image();
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      const size=128;canvas.width=size;canvas.height=size;
      const ctx=canvas.getContext('2d');
      const minDim=Math.min(img.width,img.height);
      const sx=(img.width-minDim)/2,sy=(img.height-minDim)/2;
      ctx.drawImage(img,sx,sy,minDim,minDim,0,0,size,size);
      const dataUrl=canvas.toDataURL('image/jpeg',0.85);
      callback(dataUrl);
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}

function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function updateUserUi(){
  if(currentUser){
    renderAvatarElement($('headerAvatar'),currentUser.avatar||'客',false);
    $('headerUsername').textContent=currentUser.username||'访客';
    $('userBadge').hidden=false;
    $('authBtn').hidden=true;
    $('playerName').textContent='你的棋名 · '+(currentUser.username||'');
  }else{
    $('userBadge').hidden=true;
    $('authBtn').hidden=false;
    $('playerName').textContent='未登录';
  }
}

function renderAvatarPicker(containerId,initial,onPick){
  const box=$(containerId);if(!box)return;
  box.replaceChildren();
  let sel=initial||'弈';
  AVATARS.forEach(a=>{
    const btn=document.createElement('button');
    btn.type='button';btn.className='avatar-opt'+(a===sel?' selected':'');
    btn.textContent=a;
    btn.onclick=()=>{
      box.querySelectorAll('.avatar-opt').forEach(el=>el.classList.remove('selected'));
      btn.classList.add('selected');sel=a;onPick(a);
      if(containerId==='editAvatarPicker')renderAvatarElement($('editAvatarPreview'),a,true);
      if(containerId==='regAvatarPicker')renderAvatarElement($('regAvatarPreview'),a,false);
    };
    box.append(btn);
  });
  onPick(sel);
}


// Toggle password visibility
document.querySelectorAll('.toggle-password').forEach(btn=>{
  btn.onclick=()=>{
    const input=btn.parentElement?.querySelector('input');
    if(!input)return;
    const isPassword=input.type==='password';
    input.type=isPassword?'text':'password';
    const eye=btn.querySelector('.eye-icon'),eyeOff=btn.querySelector('.eye-off-icon');
    if(eye&&eyeOff){
      eye.style.display=isPassword?'none':'block';
      eyeOff.style.display=isPassword?'block':'none';
    }
    btn.setAttribute('aria-label',isPassword?'隐藏密码':'显示密码');
  };
});

function openAuthDialog(tab='login'){
  $('authError').hidden=true;
  $('tabLogin').classList.toggle('active',tab==='login');
  $('tabRegister').classList.toggle('active',tab==='register');
  $('tabGuest').classList.toggle('active',tab==='guest');
  $('loginForm').hidden=tab!=='login';
  $('registerForm').hidden=tab!=='register';
  $('guestPanel').hidden=tab!=='guest';
  if(tab==='login'){
    prefillLoginForm();
  }else if(tab==='register'){
    renderAvatarElement($('regAvatarPreview'),selectedRegAvatar,false);
    renderAvatarPicker('regAvatarPicker',selectedRegAvatar,a=>{selectedRegAvatar=a;});
  }
  $('authDialog').showModal();
}

$('tabLogin').onclick=()=>openAuthDialog('login');
$('tabRegister').onclick=()=>openAuthDialog('register');
$('tabGuest').onclick=()=>openAuthDialog('guest');
$('closeAuth').onclick=()=>$('authDialog').close();
$('authBtn').onclick=()=>openAuthDialog('login');
$('userBadge').onclick=()=>showProfilePage();

$('loginForm').onsubmit=async e=>{
  e.preventDefault();$('authError').hidden=true;
  const username=$('loginUsername').value.trim();
  const password=$('loginPassword').value;
  try{
    const res=await online.login(username,password);
    currentUser=res.user;updateUserUi();
    if($('autoLogin')&&$('autoLogin').checked){
      localStorage.setItem(AUTO_LOGIN_KEY,'true');
    }else{
      localStorage.removeItem(AUTO_LOGIN_KEY);
    }
    $('authDialog').close();
    if(page==='profile')showProfilePage();
  }catch(err){
    $('authError').textContent=err.message;$('authError').hidden=false;
  }
};

$('registerForm').onsubmit=async e=>{
  e.preventDefault();$('authError').hidden=true;
  const p1=$('regPassword').value,p2=$('regConfirmPassword').value;
  if(p1!==p2){$('authError').textContent='两次输入的密码不一致。';$('authError').hidden=false;return;}
  try{
    const res=await online.register($('regUsername').value,p1,selectedRegAvatar);
    currentUser=res.user;updateUserUi();$('authDialog').close();
    if(page==='profile')showProfilePage();
  }catch(err){
    $('authError').textContent=err.message;$('authError').hidden=false;
  }
};

$('doGuestLogin').onclick=async()=>{
  $('authError').hidden=true;
  try{
    const res=await online.guestLogin();
    currentUser=res.user;updateUserUi();$('authDialog').close();
    if(page==='profile')showProfilePage();
  }catch(err){
    $('authError').textContent=err.message;$('authError').hidden=false;
  }
};

function showProfilePage(){
  if(!currentUser){openAuthDialog('login');return;}
  showPage('profile');
  renderAvatarElement($('profileAvatar'),currentUser.avatar||'客',true);
  $('profileUsername').textContent=currentUser.username;
  $('profileUserId').textContent=currentUser.id;
  $('profileTypeTag').textContent=currentUser.type==='registered'?'正式玩家':'游客账号';
  $('profileTypeTag').className='tag '+(currentUser.type==='registered'?'':'guest-tag');
  $('profileRoleTag').hidden=currentUser.role!=='admin';
  $('profileStatusTag').textContent=currentUser.banned?'已封禁（仅限单机）':'正常';
  $('profileStatusTag').className='tag status-tag '+(currentUser.banned?'banned':'');
  if($('profileBanBanner')){
    $('profileBanBanner').hidden=!currentUser.banned;
    if(currentUser.banned){
      const banDur=currentUser.banUntil?'至 '+new Date(currentUser.banUntil).toLocaleString('zh-CN'):'永久';
      $('profileBanBanner').textContent=`当前账号已被封禁（${banDur}）。封禁原因：${currentUser.banReason||'违反游戏规范'}。封禁期间禁止进入联机大厅及对战，单机练习模式仍可正常游玩。`;
    }
  }
  $('profileTypeDesc').textContent=currentUser.type==='registered'?'正式注册账号':'游客账号';
  $('profileRoleDesc').textContent=currentUser.role==='admin'?'系统管理员（拥有后台管控权限）':'普通对弈玩家';
  $('profileCreatedAt').textContent=currentUser.createdAt?new Date(currentUser.createdAt).toLocaleString('zh-CN',{hour12:false}):'--';
  $('profileLastLogin').textContent=currentUser.lastLoginAt?new Date(currentUser.lastLoginAt).toLocaleString('zh-CN',{hour12:false}):'刚刚';
  $('adminPanelEntrance').hidden=currentUser.role!=='admin';
}

$('copyUserIdBtn').onclick=()=>{
  if(!currentUser)return;
  navigator.clipboard?.writeText?.(currentUser.id);
  $('copyUserIdBtn').textContent='已复制 ✓';
  setTimeout(()=>{$('copyUserIdBtn').textContent='复制';},1500);
};

$('profileBackHome')&&($('profileBackHome').onclick=()=>showPage('menu'));
$('lobbyBackHome')&&($('lobbyBackHome').onclick=()=>goHome());
$('profileLogoutBtn').onclick=async()=>{
  localStorage.removeItem(AUTO_LOGIN_KEY);
  await online.logout();currentUser=null;updateUserUi();showPage('menu');
};

$('openProfileSettings').onclick=()=>{
  if(!currentUser)return;
  $('settingsError').hidden=true;
  if(currentUser.type==='registered'){
    $('settingsGuestNotice').hidden=true;
    $('settingsForm').hidden=false;
    $('editUsername').value=currentUser.username;
    selectedEditAvatar=currentUser.avatar||'相';
    renderAvatarElement($('editAvatarPreview'),selectedEditAvatar,true);
    renderAvatarPicker('editAvatarPicker',selectedEditAvatar,a=>{selectedEditAvatar=a;});
  }else{
    $('settingsGuestNotice').hidden=false;
    $('settingsForm').hidden=true;
  }
  $('profileSettingsDialog').showModal();
};

$('closeSettings').onclick=()=>$('profileSettingsDialog').close();

// Custom avatar file uploads
$('editAvatarFile')&&($('editAvatarFile').onchange=e=>{
  processAvatarFile(e.target.files[0],dataUrl=>{
    selectedEditAvatar=dataUrl;
    renderAvatarElement($('editAvatarPreview'),dataUrl,true);
    $('editAvatarPicker')?.querySelectorAll('.avatar-opt').forEach(el=>el.classList.remove('selected'));
  });
});

$('regAvatarFile')&&($('regAvatarFile').onchange=e=>{
  processAvatarFile(e.target.files[0],dataUrl=>{
    selectedRegAvatar=dataUrl;
    renderAvatarElement($('regAvatarPreview'),dataUrl,false);
    $('regAvatarPicker')?.querySelectorAll('.avatar-opt').forEach(el=>el.classList.remove('selected'));
  });
});

$('upgradeToRegBtn').onclick=()=>{$('profileSettingsDialog').close();openAuthDialog('register');};

$('settingsForm').onsubmit=async e=>{
  e.preventDefault();$('settingsError').hidden=true;
  try{
    const res=await online.updateProfile($('editUsername').value,selectedEditAvatar);
    currentUser=res.user;updateUserUi();showProfilePage();$('profileSettingsDialog').close();
  }catch(err){
    $('settingsError').textContent=err.message;$('settingsError').hidden=false;
  }
};

// Dedicated administration page keeps an active game tab connected.
$('adminPanelEntrance').onclick=()=>{if(currentUser?.role==='admin')window.open('/admin.html','_blank','noopener');};

// Data export, deletion and guest upgrade handlers
$('exportDataBtn').onclick=async()=>{
  try{
    const data=await online.exportData();
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
    const u=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=u;
    a.download=`xiangqi-profile-${currentUser.username||currentUser.id}.json`;
    a.click();
    URL.revokeObjectURL(u);
  }catch(err){
    $('settingsError').textContent=err.message||'导出数据失败';$('settingsError').hidden=false;
  }
};

$('deleteAccountBtn').onclick=()=>{
  $('profileSettingsDialog').close();
  $('deleteAccountPassword').value='';
  $('deleteAccountError').hidden=true;
  $('deleteConfirmDialog').showModal();
};

$('closeDeleteConfirm').onclick=()=>$('deleteConfirmDialog').close();
$('deleteAccountForm').onsubmit=async e=>{
  e.preventDefault();
  const pwd=$('deleteAccountPassword').value;
  try{
    await online.deleteAccount(pwd);
    $('deleteConfirmDialog').close();
    currentUser=null;
    updateUserUi();
    showPage('menu');
    alert('账号已成功注销，个人历史对局已完成匿名化。');
  }catch(err){
    $('deleteAccountError').textContent=err.message||'注销失败';$('deleteAccountError').hidden=false;
  }
};

$('upgradeToRegBtn').onclick=()=>{
  $('profileSettingsDialog').close();
  $('upgradeUsername').value='';
  $('upgradePassword').value='';
  $('upgradeError').hidden=true;
  $('upgradeGuestDialog').showModal();
};

$('closeUpgradeGuest').onclick=()=>$('upgradeGuestDialog').close();
$('upgradeGuestForm').onsubmit=async e=>{
  e.preventDefault();
  const uname=$('upgradeUsername').value.trim();
  const pwd=$('upgradePassword').value;
  try{
    const res=await online.upgradeGuest(uname,pwd);
    currentUser=res.user;
    updateUserUi();
    $('upgradeGuestDialog').close();
    showProfilePage();
  }catch(err){
    $('upgradeError').textContent=err.message||'升级失败';$('upgradeError').hidden=false;
  }
};

renderLobby();
async function initAuth(){
  clearLegacySavedPassword();
  const isAuto=localStorage.getItem(AUTO_LOGIN_KEY);
  const allowAuto=isAuto===null?true:isAuto==='true';
  if(allowAuto){
    try{
      const prof=await online.getProfile();
      if(prof?.user){
        currentUser=prof.user;
        updateUserUi();
      }
    }catch{}
  }
  try{if(currentUser)online.start();}catch{}
}
initAuth();

$('gameOptions').onclick=()=>$('gameOptionsDialog').showModal();$('closeGameOptions').onclick=()=>$('gameOptionsDialog').close();
if($('matchRules'))$('matchRules').onclick=()=>$('rulesDialog').showModal();
const offerBtn=$('offerDraw')||$('matchRules');
if(offerBtn){
  offerBtn.onclick=()=>{
    if(mode==='online'){
      if(netState?.room?.phase!=='playing'||!onlineGameId){hint('对局尚未开始。');return;}
      if(winner){hint('本局已结束。');return;}
      const myColor=myPlayer()?.color;
      const currentOffer=netState?.room?.game?.drawOffer;
      if(currentOffer===myColor){hint('已向对方发起求和，等待对方回应…');return;}
      if(currentOffer&&currentOffer!==myColor){
        if(!$('drawOfferDialog')?.open){
          const opponent=netState?.room?.players?.find(p=>p.color===currentOffer);
          if($('drawOfferPlayerName')&&opponent)$('drawOfferPlayerName').textContent=opponent.name;
          try{$('drawOfferDialog').showModal();}catch{}
        }
        return;
      }
      $('drawConfirmDialog').showModal();
    }else if(mode==='pve'){
      if(winner){hint('本局已结束。');return;}
      winner='d';
      cancelLocal();
      eventText='双方协商和棋 · 人机对局和局';
      localMessages.push({kind:'system',at:Date.now(),text:'双方协商和棋 · 本局以和棋结束'});
      draw();
      hint('本局结束，双方和棋。准备后可开始新一局。');
      sound.effect('win');
    }else if(mode==='pvp'){
      if(winner){hint('本局已结束。');return;}
      $('drawConfirmDialog').showModal();
    }
  };
}
if($('cancelDrawConfirm'))$('cancelDrawConfirm').onclick=()=>$('drawConfirmDialog').close();
if($('confirmDrawOffer'))$('confirmDrawOffer').onclick=async()=>{
  $('drawConfirmDialog').close();
  if(mode==='online'){
    try{
      await online.command('offerDraw',{gameId:onlineGameId});
      hint('已向对手发送求和请求，等待对方同意…');
    }catch(e){hint(e.message);}
  }else if(mode==='pvp'){
    winner='d';
    cancelLocal();
    eventText='双方协商和棋';
    localMessages.push({kind:'system',at:Date.now(),text:eventText});
    draw();
    hint('本局结束，双方协商和棋。');
  }
};
if($('acceptDraw'))$('acceptDraw').onclick=async()=>{
  $('drawOfferDialog').close();
  if(mode==='online'){
    try{
      await online.command('respondDraw',{gameId:onlineGameId,accept:true});
    }catch(e){hint(e.message);}
  }
};
if($('declineDraw'))$('declineDraw').onclick=async()=>{
  $('drawOfferDialog').close();
  if(mode==='online'){
    try{
      await online.command('respondDraw',{gameId:onlineGameId,accept:false});
    }catch(e){hint(e.message);}
  }
};
$('resign').onclick=()=>$('resignDialog').showModal();$('cancelResign').onclick=()=>$('resignDialog').close();$('confirmResign').onclick=async()=>{$('resignDialog').close();if(mode==='online'){try{await online.command('resign',{gameId:onlineGameId});}catch(e){hint(e.message);}}else if(!winner){winner=mode==='pve'?other(humanSide):other(side);cancelLocal();eventText=title(winner)+'获胜 · 对方认输';localMessages.push({kind:'system',at:Date.now(),text:eventText});draw();}};
for(const button of document.querySelectorAll('[data-filter]'))button.onclick=()=>{messageFilter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));messageSignature='';renderMessages();$('history').scrollTop=$('history').scrollHeight;};
for(const emoji of ['👍','👏','🤝','😊','🤔','😮','🎉','🙏']){const b=document.createElement('button');b.type='button';b.textContent=emoji;b.setAttribute('aria-label','插入 '+emoji);b.onclick=()=>{const input=$('chatInput');if(input.value.length+emoji.length<=300)input.value+=emoji;input.focus();};$('emojiPicker').append(b);}
$('emojiToggle').onclick=()=>{$('emojiPicker').hidden=!$('emojiPicker').hidden;$('emojiToggle').setAttribute('aria-expanded',String(!$('emojiPicker').hidden));};
$('chatForm').onsubmit=async e=>{e.preventDefault();const input=$('chatInput'),text=input.value.trim();if(!text||chatSending||input.disabled)return;chatSending=true;$('chatSend').disabled=true;try{await online.command('chat',{text});if(input.value.trim()===text)input.value='';$('emojiPicker').hidden=true;$('emojiToggle').setAttribute('aria-expanded','false');$('history').scrollTop=$('history').scrollHeight;}catch(e){$('chatNotice').textContent=e.message;}finally{chatSending=false;$('chatSend').disabled=!netConnected;}};
setInterval(updateClocks,250);
