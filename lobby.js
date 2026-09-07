import {randomBytes, randomInt, randomUUID} from 'node:crypto';
import {initial, play, key, other, actions, names, danger} from './engine.js';
const prefixes=['听雨','松风','云水','竹影','清泉','落霞','山月','长风','寒梅','青岚'];
const name=words=>prefixes[randomInt(prefixes.length)]+words[randomInt(words.length)]+'·'+randomInt(1000,10000);
const coord=i=>'ABCDEFGHI'[i%9]+(10-Math.floor(i/9));
export class LobbyError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export class Lobby {
  constructor({now=Date.now,graceMs=30000,randomColor=()=>randomInt(2)}={}){
    this.now=now;this.graceMs=graceMs;this.randomColor=randomColor;
    this.sessions=new Map();this.rooms=new Map();this.version=0;this.onChange=()=>{};
  }
  changed(){this.version++;this.onChange();}
  createSession(){
    if(this.sessions.size>=2000)throw new LobbyError('大厅繁忙，请稍后再试。',503);
    const token=randomBytes(32).toString('hex');
    const s={id:randomUUID(),token,name:name(['棋客','隐士','游侠','书生','行者','居士','弈者','墨客']),roomId:null,ready:false,color:null,connected:false,lastSeen:this.now(),disconnectedAt:this.now(),streams:new Set(),requests:new Map()};
    this.sessions.set(token,s);return s;
  }
  auth(token){const s=this.sessions.get(token);if(!s)throw new LobbyError('身份已过期，正在重新连接。',401);s.lastSeen=this.now();return s;}
  connect(s,stream){s.streams.add(stream);s.connected=true;s.disconnectedAt=null;s.lastSeen=this.now();this.changed();}
  disconnect(s,stream){s.streams.delete(stream);if(s.streams.size)return;s.connected=false;s.disconnectedAt=this.now();if(this.rooms.get(s.roomId)?.phase!=='playing')s.ready=false;this.changed();}
  player(s){return {id:s.id,name:s.name,ready:s.ready,color:s.color,connected:s.connected};}
  summary(r){return {id:r.id,name:r.name,phase:r.phase,players:r.members.map(s=>this.player(s)),count:r.members.length};}
  snapshot(s){const r=this.rooms.get(s.roomId);return {version:this.version,self:{id:s.id,name:s.name,roomId:s.roomId},rooms:[...this.rooms.values()].map(r=>this.summary(r)),room:r?{...this.summary(r),game:r.game}:null};}
  getRoom(s){const r=this.rooms.get(s.roomId);if(!r)throw new LobbyError('请先进入房间。');return r;}
  leave(s){
    const r=this.rooms.get(s.roomId);s.roomId=null;s.ready=false;s.color=null;if(!r)return;
    r.members=r.members.filter(p=>p!==s);
    if(!r.members.length){this.rooms.delete(r.id);return;}
    r.members.forEach(p=>p.ready=false);
    if(r.phase==='playing'){r.phase='finished';r.game.winner=r.members[0].color;r.game.reason='对手已离开房间';}
  }
  command(s,c){
    if(!c||typeof c!=='object'||Array.isArray(c))throw new LobbyError('请求格式错误。');
    if(typeof c.requestId!=='string'||c.requestId.length>80||!c.requestId.length)throw new LobbyError('缺少请求标识。');
    if(s.requests.has(c.requestId))return this.snapshot(s);
    if(!s.connected)throw new LobbyError('连接尚未恢复，请稍后再试。',409);
    switch(c.type){
      case 'create':{
        if(s.roomId)throw new LobbyError('请先退出当前房间。');
        if(this.rooms.size>=5)throw new LobbyError('已有 5 个房间，请加入现有房间或等待空位。',409);
        const r={id:randomUUID(),name:name(['棋亭','竹院','山房','水榭','云阁','书斋']),members:[s],phase:'waiting',game:null};
        this.rooms.set(r.id,r);s.roomId=r.id;s.ready=false;s.color=null;break;
      }
      case 'join':{
        if(s.roomId)throw new LobbyError('请先退出当前房间。');
        const r=this.rooms.get(c.roomId);if(!r)throw new LobbyError('房间已销毁，请选择其他房间。',404);
        if(r.members.length>=2||r.phase==='playing')throw new LobbyError('房间已满或正在对局。',409);
        if(r.phase==='finished')r.members.forEach(p=>{p.ready=false;p.color=null;});
        r.members.push(s);s.roomId=r.id;s.ready=false;s.color=null;r.phase='waiting';r.game=null;break;
      }
      case 'leave':this.leave(s);break;
      case 'ready':{
        const r=this.getRoom(s);if(r.phase==='playing')throw new LobbyError('对局已经开始。',409);
        if(typeof c.ready!=='boolean')throw new LobbyError('准备状态无效。');s.ready=c.ready;
        if(r.members.length===2&&r.members.every(p=>p.ready&&p.connected)){
          const red=this.randomColor();r.members.forEach((p,i)=>{p.color=i===red?'r':'b';p.ready=false;});
          const board=initial();r.phase='playing';r.game={id:randomUUID(),board,turn:'r',history:[key(board)],records:[],winner:null,reason:null,last:null,checked:[]};
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
        g.board=result.board;g.history.push(key(g.board));g.turn=other(g.turn);g.winner=result.winner;
        if(!g.winner&&!actions(g.board,g.turn,g.history).length){g.winner=s.color;g.reason='对方无合法行动';}
        if(g.winner){r.phase='finished';g.reason??='捕获对方将帅';r.members.forEach(p=>p.ready=false);}
        g.checked=g.winner?[]:['r','b'].filter(side=>danger(g.board,side,g.history));g.last={from:a.from??null,to:a.to};
        g.records.push({side:s.color,text:`${label} ${a.from==null?'落于':coord(a.from)+' →'} ${coord(a.to)}${g.checked.length?' · 将军':''}`,captured:result.captured.length});break;
      }
      default:throw new LobbyError('不支持的操作。');
    }
    s.requests.set(c.requestId,true);if(s.requests.size>64)s.requests.delete(s.requests.keys().next().value);
    this.changed();return this.snapshot(s);
  }
  sweep(){let dirty=false;for(const [token,s] of this.sessions){
    if(!s.connected&&s.roomId&&this.now()-s.disconnectedAt>=this.graceMs){this.leave(s);dirty=true;}
    if(!s.connected&&!s.roomId&&this.now()-s.lastSeen>3600000)this.sessions.delete(token);
  }if(dirty)this.changed();}
}
