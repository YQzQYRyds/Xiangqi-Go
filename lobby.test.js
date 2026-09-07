import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Lobby} from './lobby.js';
import {initial,key} from './engine.js';
import {createGameServer} from './server.js';
const command=(l,s,type,data={})=>l.command(s,{type,requestId:randomUUID(),...data});
function player(l){const p=l.createSession();l.connect(p,{});return p;}
function game(l){const a=player(l),b=player(l);command(l,a,'create');command(l,b,'join',{roomId:a.roomId});command(l,a,'ready',{ready:true});command(l,b,'ready',{ready:true});return {a,b,r:l.rooms.get(a.roomId),red:a.color==='r'?a:b,black:a.color==='b'?a:b};}
test('at most five rooms; capacity two; names generated; empty rooms disappear',()=>{
  const l=new Lobby(),ps=Array.from({length:6},()=>player(l));for(const p of ps.slice(0,5))command(l,p,'create');
  assert.equal(l.rooms.size,5);assert.throws(()=>command(l,ps[5],'create'),/5 个/);
  command(l,ps[5],'join',{roomId:ps[0].roomId});const extra=player(l);assert.throws(()=>command(l,extra,'join',{roomId:ps[0].roomId}),/已满/);
  const id=ps[0].roomId;assert.ok(l.rooms.get(id).name);assert.ok(ps[0].name);command(l,ps[0],'leave');assert.ok(l.rooms.has(id));command(l,ps[5],'leave');assert.ok(!l.rooms.has(id));command(l,extra,'create');assert.equal(l.rooms.size,5);
});
test('one player or only one ready never starts; both colors can be randomly assigned',()=>{
  for(const randomColor of [()=>0,()=>1]){
    const l=new Lobby({randomColor}),a=player(l),b=player(l);command(l,a,'create');command(l,a,'ready',{ready:true});assert.equal(l.rooms.get(a.roomId).phase,'waiting');
    command(l,b,'join',{roomId:a.roomId});assert.equal(a.ready,true);command(l,a,'ready',{ready:false});assert.equal(a.ready,false);command(l,a,'ready',{ready:true});assert.equal(l.rooms.get(a.roomId).phase,'waiting');
    command(l,b,'ready',{ready:true});const r=l.rooms.get(a.roomId);assert.equal(r.phase,'playing');assert.equal(a.color,randomColor()===0?'r':'b');assert.notEqual(a.color,b.color);assert.equal(r.game.turn,'r');assert.deepEqual(r.game.board,initial());
  }
});
test('server validates turn, legal moves, membership and stale/repeated submissions',()=>{
  const l=new Lobby(),{r,red,black}=game(l),data={gameId:r.game.id,ply:0,action:{to:40}};
  assert.throws(()=>command(l,black,'move',data),/轮到/);assert.throws(()=>command(l,player(l),'move',data),/进入房间/);
  assert.throws(()=>command(l,red,'move',{...data,action:{from:81,to:41}}),/走法/);
  assert.throws(()=>command(l,red,'move',{...data,gameId:'old'}),/已更新/);
  const c={type:'move',requestId:randomUUID(),...data};l.command(red,c);l.command(red,c);assert.equal(r.game.records.length,1);assert.equal(r.game.board[40].s,'r');
  command(l,black,'move',{gameId:r.game.id,ply:1,action:{to:41}});assert.equal(r.game.records.length,2);
  assert.throws(()=>command(l,red,'move',data),/已更新/);assert.equal(r.game.records.length,2);
});
test('disconnect pauses, reconnect restores; timeout removes player and awards remaining opponent',()=>{
  let now=0;const l=new Lobby({now:()=>now}),{r,red,black}=game(l);l.disconnect(black,[...black.streams][0]);
  assert.throws(()=>command(l,red,'move',{gameId:r.game.id,ply:0,action:{to:40}}),/断线/);
  now=20000;l.sweep();assert.equal(r.members.length,2);l.connect(black,{});assert.equal(l.snapshot(black).room.game.id,r.game.id);
  l.disconnect(black,[...black.streams][0]);now=51000;l.sweep();assert.equal(black.roomId,null);assert.equal(r.phase,'finished');assert.equal(r.game.winner,'r');
  l.disconnect(red,[...red.streams][0]);now=82000;l.sweep();assert.equal(l.rooms.size,0);
});
test('capture ends game, rejects later moves; both can ready again with fresh board',()=>{
  const l=new Lobby(),{r,red,black}=game(l);r.game.board=Array(90).fill(null);r.game.board[85]={s:'r',t:'k'};r.game.board[4]={s:'b',t:'k'};r.game.history=[key(r.game.board)];
  command(l,red,'move',{gameId:r.game.id,ply:0,action:{from:85,to:4}});assert.equal(r.game.winner,'r');assert.equal(r.phase,'finished');
  assert.throws(()=>command(l,black,'move',{gameId:r.game.id,ply:1,action:{to:40}}),/结束/);
  const old=r.game.id;command(l,red,'ready',{ready:true});command(l,black,'ready',{ready:true});assert.notEqual(r.game.id,old);assert.deepEqual(r.game.board,initial());assert.equal(r.game.records.length,0);
});
test('HTTP identity, SSE delivery, static allowlist, cross-origin and malformed requests',async t=>{
  const {server}=createGameServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/server.js')).status,404);assert.equal((await fetch(base+'/lobby.js')).status,404);
  assert.equal((await fetch(base+'/api/command',{method:'POST'})).status,401);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{Origin:'https://unrelated.example'}})).status,403);
  const session=await (await fetch(base+'/api/session',{method:'POST'})).json(),headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};
  const controller=new AbortController();t.after(()=>controller.abort());const stream=await fetch(base+'/api/events',{headers,signal:controller.signal});assert.match(stream.headers.get('content-type'),/event-stream/);
  const reader=stream.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/data:/);
  let response=await fetch(base+'/api/command',{method:'POST',headers,body:JSON.stringify({type:'create',requestId:randomUUID()})});assert.equal(response.status,200);const state=await response.json();assert.equal(state.rooms.length,1);assert.ok(state.room.name);assert.equal(JSON.stringify(state).includes(session.token),false);
  response=await fetch(base+'/api/command',{method:'POST',headers,body:'{broken'});assert.equal(response.status,400);controller.abort();
});
