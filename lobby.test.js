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
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {UserStore}=await import('./users.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiangqi-lobby-test-'));
  const {server}=createGameServer({userStore:new UserStore(path.join(dir,'users.json'),path.join(dir,'no.env'))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/server.js')).status,404);assert.equal((await fetch(base+'/lobby.js')).status,404);
  assert.equal((await fetch(base+'/api/command',{method:'POST'})).status,401);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{Origin:'https://unrelated.example'}})).status,403);
  assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{Origin:`http://localhost:${server.address().port}`}})).status,201);
  const session=await (await fetch(base+'/api/session',{method:'POST'})).json(),headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};
  const controller=new AbortController();t.after(()=>controller.abort());const stream=await fetch(base+'/api/events',{headers,signal:controller.signal});assert.match(stream.headers.get('content-type'),/event-stream/);
  const reader=stream.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/data:/);
  let response=await fetch(base+'/api/command',{method:'POST',headers,body:JSON.stringify({type:'create',requestId:randomUUID()})});assert.equal(response.status,200);const state=await response.json();assert.equal(state.rooms.length,1);assert.ok(state.room.name);assert.equal(JSON.stringify(state).includes(session.token),false);
  response=await fetch(base+'/api/command',{method:'POST',headers,body:'{broken'});assert.equal(response.status,400);controller.abort();
});

test('authoritative clock switches turns, pauses on disconnect and expires only once',()=>{
  let now=0;const l=new Lobby({now:()=>now,clockMs:60000}),{r,red,black}=game(l);let finished=0;l.onGameFinished=()=>finished++;
  now=5000;command(l,red,'move',{gameId:r.game.id,ply:0,action:{to:40}});assert.equal(r.game.clock.remaining.r,55000);
  now=12000;l.disconnect(black,[...black.streams][0]);assert.equal(r.game.clock.remaining.b,53000);assert.equal(l.snapshot(red).room.players.find(p=>p.id===black.id).reconnectDeadline,42000);
  now=30000;l.sweep();assert.equal(r.game.clock.remaining.b,53000);l.connect(black,{});assert.equal(r.game.clock.runningSince,30000);
  now=83000;assert.throws(()=>command(l,black,'move',{gameId:r.game.id,ply:1,action:{to:41}}),/结束/);assert.equal(r.game.winner,'r');assert.equal(r.game.records.length,1);l.sweep();assert.equal(finished,1);assert.equal(r.game.clock.runningSince,null);
});
test('reconnect after grace cannot reclaim an expired seat before periodic sweep',()=>{
  let now=0;const l=new Lobby({now:()=>now}),{r,black}=game(l);l.disconnect(black,[...black.streams][0]);now=30000;l.connect(black,{});assert.equal(black.roomId,null);assert.equal(r.game.winner,'r');
});
test('room chat validates size and membership, deduplicates, rate limits and stays private',()=>{
  let now=0;const l=new Lobby({now:()=>now}),{r,red,black}=game(l),outsider=player(l);
  assert.throws(()=>command(l,outsider,'chat',{text:'hello'}),/进入房间/);
  for(const text of ['', '   ', 'x'.repeat(301), {}, null])assert.throws(()=>command(l,red,'chat',{text}),/消息须/);
  const c={type:'chat',requestId:randomUUID(),text:'好棋 👍 <script>alert(1)</script>'};l.command(red,c);l.command(red,c);assert.equal(r.messages.filter(m=>m.kind==='chat').length,1);
  assert.equal(l.snapshot(black).room.messages.at(-1).text,c.text);assert.equal(l.snapshot(outsider).room,null);assert.equal(JSON.stringify(l.snapshot(outsider)).includes('alert(1)'),false);
  assert.throws(()=>command(l,red,'chat',{text:'again'}),/发送太快/);
  for(let i=0;i<205;i++){now+=1000;command(l,red,'chat',{text:'消息 '+i});}assert.equal(r.messages.length,200);
  command(l,red,'resign',{gameId:r.game.id});assert.equal(r.game.winner,'b');now+=1000;command(l,red,'chat',{text:'再来一局'});assert.equal(r.messages.at(-1).text,'再来一局');
  command(l,red,'ready',{ready:true});command(l,black,'ready',{ready:true});assert.equal(r.messages.length,1);assert.equal(r.game.clock.remaining.r,600000);
});

test("draw offer requires agreement, clears on move, and draws are excluded from win rate", async () => {
  const { UserStore } = await import("./users.js");
  const store = new UserStore(":memory:");
  let now = 100000;
  const l = new Lobby({ now: () => now });
  l.onGameFinished = g => store.recordGame(g);

  const u1 = store.register({ username: "棋友甲", password: "password123" });
  const u2 = store.register({ username: "棋友乙", password: "password123" });
  const p1 = l.createSession(u1); l.connect(p1, {});
  const p2 = l.createSession(u2); l.connect(p2, {});

  command(l, p1, "create");
  command(l, p2, "join", { roomId: p1.roomId });
  command(l, p1, "ready", { ready: true });
  command(l, p2, "ready", { ready: true });

  const r = l.rooms.get(p1.roomId);
  const red = p1.color === "r" ? p1 : p2;
  const black = p1.color === "b" ? p1 : p2;

  // 1. Red offers draw
  command(l, red, "offerDraw", { gameId: r.game.id });
  assert.equal(r.game.drawOffer, "r");
  // Cannot re-offer while pending
  assert.throws(() => command(l, red, "offerDraw", { gameId: r.game.id }), /已发送/);
  // Red cannot respond to own offer
  assert.throws(() => command(l, red, "respondDraw", { gameId: r.game.id, accept: true }), /自己/);

  // 2. Black declines draw
  command(l, black, "respondDraw", { gameId: r.game.id, accept: false });
  assert.equal(r.game.drawOffer, null);
  assert.equal(r.phase, "playing");

  // 3. Move clears pending draw offer
  now += 5000;
  command(l, black, "offerDraw", { gameId: r.game.id });
  assert.equal(r.game.drawOffer, "b");
  command(l, red, "move", { gameId: r.game.id, ply: 0, action: { to: 40 } });
  assert.equal(r.game.drawOffer, null);

  // 4. Black accepts draw
  now += 5000;
  command(l, red, "offerDraw", { gameId: r.game.id });
  assert.equal(r.game.drawOffer, "r");
  command(l, black, "respondDraw", { gameId: r.game.id, accept: true });
  assert.equal(r.phase, "finished");
  assert.equal(r.game.winner, null);
  assert.equal(r.game.reason, "双方协商和棋");

  // Verify match recording in UserStore
  const s1 = store.stats(u1.id);
  const s2 = store.stats(u2.id);
  assert.equal(s1.games, 1);
  assert.equal(s1.wins, 0);
  assert.equal(s1.winRate, null); // 0 decisive games -> null winRate
  assert.equal(s2.games, 1);
  assert.equal(s2.wins, 0);
  assert.equal(s2.winRate, null);

  // 5. Next game: u1 wins, then 1 draw -> win rate is 100% (1 win / 1 decisive game, draw not counted)
  command(l, p1, "ready", { ready: true });
  command(l, p2, "ready", { ready: true });
  const r2 = l.rooms.get(p1.roomId);
  const winner = p1;
  const loser = p2;
  command(l, loser, "resign", { gameId: r2.game.id });

  const s1After = store.stats(u1.id);
  const s2After = store.stats(u2.id);
  assert.equal(s1After.games, 2);
  assert.equal(s1After.wins, 1);
  assert.equal(s1After.winRate, 1.0); // 1 win / (1 win + 0 loss), draw does not drag it down!

  assert.equal(s2After.games, 2);
  assert.equal(s2After.wins, 0);
  assert.equal(s2After.winRate, 0.0); // 0 win / (0 win + 1 loss)

  store.close();
});
