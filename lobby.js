import {randomBytes, randomInt, randomUUID} from 'node:crypto';
import {initial, play, key, other, actions, names, danger} from './engine.js';
const prefixes=['听雨','松风','云水','竹影','清泉','落霞','山月','长风','寒梅','青岚'];
const name=words=>prefixes[randomInt(prefixes.length)]+words[randomInt(words.length)]+'·'+randomInt(1000,10000);
const coord=i=>'ABCDEFGHI'[i%9]+(10-Math.floor(i/9));
export class LobbyError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export class Lobby {
  constructor({now=Date.now,graceMs=30000,clockMs=600000,randomColor=()=>randomInt(2)}={}){
    this.now=now;this.graceMs=graceMs;this.randomColor=randomColor;
    this.sessions=new Map();this.rooms=new Map();this.version=0;this.onChange=()=>{};
    this.maxRooms=5;this.onGameFinished=()=>{};this.clockMs=clockMs;
  }
  message(r,kind,text,extra={}){r.messages??=[];r.messages.push({id:randomUUID(),at:this.now(),kind,text,...extra});if(r.messages.length>200)r.messages.shift();}
  finish(r,winner,reason){if(r.phase!=='playing')return;r.phase='finished';r.game.winner=winner;r.game.reason=reason;r.game.clock.runningSince=null;r.game.drawOffer=null;r.members.forEach(p=>p.ready=false);this.message(r,'system',winner?(reason+' · '+(winner==='r'?'红方':'黑方')+'获胜'):(reason+' · 对局和棋'));this.onGameFinished(r.game);}
  tick(r){const g=r?.game;if(r?.phase!=='playing'||!g?.clock||g.clock.runningSince==null)return false;const c=g.clock;c.remaining[g.turn]=Math.max(0,c.remaining[g.turn]-(this.now()-c.runningSince));c.runningSince=this.now();if(c.remaining[g.turn]===0){this.finish(r,other(g.turn),'行棋时间耗尽');return true;}return false;}
  changed(){this.version++;this.onChange();}
  createSession(user=null, token=null){
    if(this.sessions.size>=2000)throw new LobbyError('大厅繁忙，请稍后再试。',503);
    if(user?.banned){
      const untilStr=user.banUntil?('至 '+new Date(user.banUntil).toLocaleString('zh-CN',{hour12:false})):'（永久封禁）';
      throw new LobbyError('该账号已被封禁'+(user.banUntil?untilStr:'')+'：'+(user.banReason||'违规操作')+(!user.banUntil?'（永久封禁）':''),403);
    }
    token = token || randomBytes(32).toString('hex');
    const s={id:user?user.id:randomUUID(),token,name:user?user.username:name(['棋客','隐士','游侠','书生','行者','居士','弈者','墨客']),user:user||null,banned:user?!!user.banned:false,roomId:null,ready:false,color:null,connected:false,lastSeen:this.now(),disconnectedAt:this.now(),streams:new Set(),requests:new Map()};
    this.sessions.set(token,s);return s;
  }
  auth(token){
    const s=this.sessions.get(token);
    if(!s)throw new LobbyError('身份已过期，正在重新连接。',401);
    if(s.banned||s.user?.banned){
      const u=s.user;
      const untilStr=u?.banUntil?('至 '+new Date(u.banUntil).toLocaleString('zh-CN',{hour12:false})):'（永久封禁）';
      throw new LobbyError('您的账号已被封禁'+(u?.banUntil?untilStr:'')+'：'+(u?.banReason||'违规操作')+(!u?.banUntil?'（永久封禁）':''),403);
    }
    s.lastSeen=this.now();
    return s;
  }
  connect(s,stream){this.sweep();const was=s.connected;s.streams.add(stream);s.connected=true;s.disconnectedAt=null;s.lastSeen=this.now();const r=this.rooms.get(s.roomId);if(r&&!was){this.message(r,'system',s.name+'已连接');if(r.phase==='playing'&&r.members.every(p=>p.connected))r.game.clock.runningSince=this.now();}this.changed();}
  disconnect(s,stream){s.streams.delete(stream);if(s.streams.size)return;const r=this.rooms.get(s.roomId);this.tick(r);s.connected=false;s.disconnectedAt=this.now();if(r?.phase==='playing')r.game.clock.runningSince=null;else s.ready=false;if(r)this.message(r,'system',s.name+'断线，等待重连 30 秒');this.changed();}
  player(s){return {id:s.id,name:s.name,avatar:s.user?.avatar||'客',type:s.user?.type||'guest',role:s.user?.role||'player',ready:s.ready,color:s.color,connected:s.connected};}
  summary(r){return {id:r.id,name:r.name,phase:r.phase,players:r.members.map(s=>this.player(s)),count:r.members.length};}
  snapshot(s){const r=this.rooms.get(s.roomId);return {version:this.version,serverNow:this.now(),maxRooms:this.maxRooms,self:{id:s.id,name:s.name,avatar:s.user?.avatar||'客',type:s.user?.type||'guest',role:s.user?.role||'player',roomId:s.roomId},rooms:[...this.rooms.values()].map(r=>this.summary(r)),room:r?{...this.summary(r),players:r.members.map(p=>({...this.player(p),reconnectDeadline:p.connected?null:p.disconnectedAt+this.graceMs})),game:r.game,messages:r.messages||[]}:null};}
  getRoom(s){const r=this.rooms.get(s.roomId);if(!r)throw new LobbyError('请先进入房间。');return r;}
  leave(s){
    const r=this.rooms.get(s.roomId);
    this.tick(r);if(r?.phase==='playing')this.finish(r,other(s.color),'对手已离开房间');
    if(r)this.message(r,'system',s.name+'已离开房间');
    s.roomId=null;s.ready=false;s.color=null;if(!r)return;
    r.members=r.members.filter(p=>p!==s);
    if(!r.members.length){this.rooms.delete(r.id);return;}
    r.members.forEach(p=>p.ready=false);
    if(r.phase==='playing'){r.phase='finished';r.game.winner=r.members[0].color;r.game.reason='对手已离开房间';}
  }
  command(s,c){
    if(!c||typeof c!=='object'||Array.isArray(c))throw new LobbyError('请求格式错误。');
    if(typeof c.requestId!=='string'||c.requestId.length>80||!c.requestId.length)throw new LobbyError('缺少请求标识。');
    if(s.requests.has(c.requestId))return this.snapshot(s);
    if(s.banned||s.user?.banned){
      const u=s.user;
      const untilStr=u?.banUntil?('至 '+new Date(u.banUntil).toLocaleString('zh-CN',{hour12:false})):'（永久封禁）';
      throw new LobbyError('您的账号已被封禁'+(u?.banUntil?untilStr:'')+'：'+(u?.banReason||'违规操作')+(!u?.banUntil?'（永久封禁）':''),403);
    }
    if(!s.connected)throw new LobbyError('连接尚未恢复，请稍后再试。',409);
    if(this.tick(this.rooms.get(s.roomId)))this.changed();
    switch(c.type){
      case 'create':{
        if([...this.sessions.values()].some(p=>p!==s&&p.id===s.id&&p.roomId))throw new LobbyError('该账号已在其他页面入座。',409);
        if(s.roomId)throw new LobbyError('请先退出当前房间。');
        if(this.rooms.size>=this.maxRooms)throw new LobbyError(`已有 ${this.maxRooms} 个房间，请加入现有房间或等待空位。`,409);
        const r={id:randomUUID(),name:name(['棋亭','竹院','山房','水榭','云阁','书斋']),members:[s],phase:'waiting',game:null};
        this.message(r,'system',s.name+'创建了房间');this.rooms.set(r.id,r);s.roomId=r.id;s.ready=false;s.color=null;break;
      }
      case 'join':{
        if([...this.sessions.values()].some(p=>p!==s&&p.id===s.id&&p.roomId))throw new LobbyError('该账号已在其他页面入座。',409);
        if(s.roomId)throw new LobbyError('请先退出当前房间。');
        const r=this.rooms.get(c.roomId);if(!r)throw new LobbyError('房间已销毁，请选择其他房间。',404);
        if(r.members.length>=2||r.phase==='playing')throw new LobbyError('房间已满或正在对局。',409);
        if(r.phase==='finished')r.members.forEach(p=>{p.ready=false;p.color=null;});
        r.members.push(s);s.roomId=r.id;s.ready=false;s.color=null;r.phase='waiting';r.game=null;this.message(r,'system',s.name+'已入座');break;
      }
      case 'leave':this.leave(s);break;
      case 'ready':{
        const r=this.getRoom(s);if(r.phase==='playing')throw new LobbyError('对局已经开始。',409);
        if(typeof c.ready!=='boolean')throw new LobbyError('准备状态无效。');s.ready=c.ready;
        if(r.members.length===2&&r.members.every(p=>p.ready&&p.connected)){
          const red=this.randomColor();r.members.forEach((p,i)=>{p.color=i===red?'r':'b';p.ready=false;});
          const board=initial();r.phase='playing';r.game={id:randomUUID(),board,turn:'r',history:[key(board)],records:[],winner:null,reason:null,last:null,checked:[],drawOffer:null};
          r.game.startedAt=this.now();r.game.players=r.members.map(p=>({id:p.id,name:p.name,side:p.color}));
          r.game.clock={remaining:{r:this.clockMs,b:this.clockMs},runningSince:this.now()};r.messages=[];this.message(r,'system','对局开始 · 每方 '+this.clockMs/60000+' 分钟 · 红方先行');
        }break;
      }
      case 'move':{
        const r=this.getRoom(s),g=r.game;
        if(r.phase!=='playing'||!g)throw new LobbyError('对局尚未开始或已经结束。',409);
        if(!r.members.every(p=>p.connected))throw new LobbyError('对手暂时断线，等待重连。',409);
        if(g.turn!==s.color)throw new LobbyError('还没有轮到你行棋。',409);
        if(c.gameId!==g.id||c.ply!==g.records.length)throw new LobbyError('棋局已更新，请按最新局面行棋。',409);
        const a=c.action;
        if(!a||typeof a!=='object'||!Number.isInteger(a.to)||(a.from!=null&&!Number.isInteger(a.from)))throw new LobbyError('走法格式错误。');
        const result=play(g.board,s.color,a,g.history);if(result.error)throw new LobbyError(result.error);
        const label=a.from==null?(s.color==='r'?'白子':'黑子'):names[s.color][g.board[a.from].t];
        g.board=result.board;g.history.push(key(g.board));g.turn=other(g.turn);g.winner=result.winner;g.drawOffer=null;
        if(!g.winner&&!actions(g.board,g.turn,g.history).length){g.winner=s.color;g.reason='对方无合法行动';}
        if(g.winner){r.phase='finished';g.reason??='捕获对方将帅';r.members.forEach(p=>p.ready=false);}
        g.checked=g.winner?[]:['r','b'].filter(side=>danger(g.board,side,g.history));g.last={from:a.from??null,to:a.to};
        g.records.push({side:s.color,text:`${label} ${a.from==null?'落于':coord(a.from)+' →'} ${coord(a.to)}${g.checked.length?' · 将军':''}`,captured:result.captured.length});this.message(r,'record',g.records.at(-1).text,{side:s.color,ply:g.records.length,captured:result.captured.length});g.clock.runningSince=g.winner?null:this.now();if(g.winner){this.message(r,'system',g.reason+' · '+(g.winner==='r'?'红方':'黑方')+'获胜');this.onGameFinished(g);}break;
      }
      case 'chat':{const r=this.getRoom(s);if(typeof c.text!=='string'||!c.text.trim()||c.text.length>300)throw new LobbyError('消息须为 1–300 个字符。');if(s.lastChatAt!=null&&this.now()-s.lastChatAt<1000)throw new LobbyError('发送太快，请稍后再试。',429);s.lastChatAt=this.now();this.message(r,'chat',c.text.trim(),{senderId:s.id,name:s.name});break;}
      case 'resign':{const r=this.getRoom(s);if(r.phase!=='playing'||c.gameId!==r.game.id)throw new LobbyError('棋局已更新。',409);this.finish(r,other(s.color),'对手认输');break;}
      case 'offerDraw':{
        const r=this.getRoom(s),g=r.game;
        if(r.phase!=='playing'||!g||c.gameId!==g.id)throw new LobbyError('棋局已更新。',409);
        if(!s.color)throw new LobbyError('您不是对局棋手。',403);
        if(r.members.length<2)throw new LobbyError('等待对手入座。',409);
        if(!r.members.every(p=>p.connected))throw new LobbyError('对手暂时断线，等待重连。',409);
        if(g.drawOffer){
          if(g.drawOffer===s.color)throw new LobbyError('已发送求和请求，请等待对方回应。',409);
          this.finish(r,null,'双方协商和棋');
          break;
        }
        if(s.lastDrawOfferAt!=null&&this.now()-s.lastDrawOfferAt<3000)throw new LobbyError('求和请求过于频繁，请稍后再试。',429);
        s.lastDrawOfferAt=this.now();
        g.drawOffer=s.color;
        const sideName=s.color==='r'?'红方':'黑方';
        this.message(r,'system',s.name+'（'+sideName+'）请求和棋，等待对方同意');
        break;
      }
      case 'respondDraw':{
        const r=this.getRoom(s),g=r.game;
        if(r.phase!=='playing'||!g||c.gameId!==g.id)throw new LobbyError('棋局已更新。',409);
        if(!s.color)throw new LobbyError('您不是对局棋手。',403);
        if(!g.drawOffer)throw new LobbyError('当前没有有效的求和请求。',409);
        if(g.drawOffer===s.color)throw new LobbyError('不能回应自己发起的求和。',400);
        if(c.accept){
          this.finish(r,null,'双方协商和棋');
        }else{
          g.drawOffer=null;
          const sideName=s.color==='r'?'红方':'黑方';
          this.message(r,'system',s.name+'（'+sideName+'）拒绝了和棋请求');
        }
        break;
      }
      case 'draw':{
        const r=this.getRoom(s),g=r.game;
        if(r.phase!=='playing'||!g||c.gameId!==g.id)throw new LobbyError('棋局已更新。',409);
        if(!s.color)throw new LobbyError('您不是对局棋手。',403);
        if(c.action==='accept'||c.accept===true){
          if(!g.drawOffer)throw new LobbyError('当前没有有效的求和请求。',409);
          if(g.drawOffer===s.color)throw new LobbyError('不能回应自己发起的求和。',400);
          this.finish(r,null,'双方协商和棋');
        }else if(c.action==='decline'||c.accept===false){
          if(!g.drawOffer)throw new LobbyError('当前没有有效的求和请求。',409);
          if(g.drawOffer===s.color)throw new LobbyError('不能回应自己发起的求和。',400);
          g.drawOffer=null;
          const sideName=s.color==='r'?'红方':'黑方';
          this.message(r,'system',s.name+'（'+sideName+'）拒绝了和棋请求');
        }else{
          if(r.members.length<2)throw new LobbyError('等待对手入座。',409);
          if(!r.members.every(p=>p.connected))throw new LobbyError('对手暂时断线，等待重连。',409);
          if(g.drawOffer){
            if(g.drawOffer===s.color)throw new LobbyError('已发送求和请求，请等待对方回应。',409);
            this.finish(r,null,'双方协商和棋');
            break;
          }
          if(s.lastDrawOfferAt!=null&&this.now()-s.lastDrawOfferAt<3000)throw new LobbyError('求和请求过于频繁，请稍后再试。',429);
          s.lastDrawOfferAt=this.now();
          g.drawOffer=s.color;
          const sideName=s.color==='r'?'红方':'黑方';
          this.message(r,'system',s.name+'（'+sideName+'）请求和棋，等待对方同意');
        }
        break;
      }
      default:throw new LobbyError('不支持的操作。');
    }
    s.requests.set(c.requestId,true);if(s.requests.size>64)s.requests.delete(s.requests.keys().next().value);
    this.changed();return this.snapshot(s);
  }
  banUser(userId,reason='违反游戏规范'){
    let dirty=false;
    for(const s of this.sessions.values()){
      if(s.user?.id===userId||s.id===userId){
        s.banned=true;if(s.user){s.user.banned=true;s.user.banReason=reason;}
        if(s.roomId){this.leave(s);dirty=true;}
        for(const stream of s.streams){
          try{stream.write(`data: ${JSON.stringify({type:'banned',error:'您的账号已被管理员封禁：'+reason})}\n\n`);stream.destroy();}catch{}
        }
        s.streams.clear();s.connected=false;
      }
    }
    if(dirty)this.changed();
  }
  updateUser(user){
    for(const s of this.sessions.values()){
      if(s.user?.id===user.id||s.id===user.id){
        s.name=user.username;s.user=user;
      }
    }
    this.changed();
  }
  revokeUser(id){
    for(const [token,s] of this.sessions)if(s.id===id){this.leave(s);for(const stream of s.streams)stream.end();this.sessions.delete(token);}
    this.changed();
  }
  sweep(){let dirty=false;for(const r of this.rooms.values())if(this.tick(r))dirty=true;for(const [token,s] of this.sessions){
    if(!s.connected&&s.roomId&&this.now()-s.disconnectedAt>=this.graceMs){this.leave(s);dirty=true;}
    if(!s.connected&&!s.roomId&&this.now()-s.lastSeen>3600000)this.sessions.delete(token);
  }if(dirty)this.changed();}
}
