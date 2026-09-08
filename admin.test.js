import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UserStore,permissions} from './users.js';
import {Lobby} from './lobby.js';
import {createGameServer} from './server.js';
import {key} from './engine.js';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiangqi-admin-'));
  const file=path.join(dir,'users.json');
  const store=new UserStore(file,path.join(dir,'no.env'));
  t.after(()=>{
    for (const s of UserStore.openStores) {
      if (s.dbPath && path.resolve(s.dbPath).startsWith(path.resolve(dir))) try { s.close(); } catch {}
    }
    try { store.close(); } catch {}
    try { fs.rmSync(dir,{recursive:true,force:true}); } catch {}
  });
  return {store,file,dir,root:store.findUserById('10000001')};
}
test('account lifecycle, permission boundaries, expiry, shared records and persistence',t=>{
  const {store,file,dir,root}=fixture(t);
  const user=store.manage(root,{action:'create',type:'registered',username:'管理测试',password:'password1'});
  assert.throws(()=>store.manage(root,{action:'delete',userId:root.id}),/不能/);
  assert.throws(()=>store.manage(user,{action:'delete',userId:root.id}),/权限/);
  store.setBan(user.id,true,'测试',1);assert.equal(user.banned,true);
  user.banUntil=Date.now()-1;assert.equal(store.findUserById(user.id).banned,false);
  assert.throws(()=>store.setBan(user.id,true,'测试',-1),/参数/);
  store.manage(root,{action:'password',userId:user.id,password:'password2'});
  assert.throws(()=>store.login({username:user.username,password:'password1'}));
  assert.equal(store.login({username:user.username,password:'password2'}).id,user.id);
  store.manage(root,{action:'update',userId:user.id,username:user.username,type:'registered',role:'admin',permissions:['records']});
  assert.deepEqual(permissions(user),['records']);
  assert.equal(store.login({username:user.username,password:'password2'}).id,user.id);
  assert.throws(()=>store.manage(user,{action:'create',type:'registered',username:'非法创建',password:'password1'}),/权限/);
  const guest=store.getOrCreateGuest('test-device');
  assert.throws(()=>store.manage(root,{action:'update',userId:guest.id,type:'registered',role:'player',permissions:[],username:'游客升级'}),/密码/);
  store.manage(root,{action:'update',userId:guest.id,type:'registered',role:'player',permissions:[],username:'游客升级',password:'password3'});
  assert.equal(store.login({username:'游客升级',password:'password3'}).id,guest.id);
  for(let i=0;i<25;i++)store.recordGame({id:'game'+i,startedAt:1,players:[{id:user.id,name:user.username,side:'r'},{id:guest.id,name:guest.username,side:'b'}],winner:i<5?'r':'b',records:[],reason:'测试'});
  store.recordGame({id:'game0',winner:'r'});
  assert.deepEqual(store.stats(user.id),{games:25,wins:5,winRate:.2,recentGames:20,recentWinRate:0});
  store.updateSettings({registrationOpen:false,maxRooms:8});
  const reloaded=new UserStore(file,path.join(dir,'no.env'));
  assert.equal(reloaded.stats(user.id).games,25);assert.equal(reloaded.settings.maxRooms,8);
  assert.equal(JSON.stringify(store.listUsers()).includes('passwordHash'),false);
  store.manage(root,{action:'clearRecords',userId:user.id});assert.equal(store.stats(user.id).games,0);assert.equal(store.stats(guest.id).games,25);
  store.manage(root,{action:'delete',userId:guest.id});assert.equal(store.findUserById(guest.id),null);assert.equal(store.findUserByUsername('游客升级'),null);
});
test('legacy array database loads without losing accounts',t=>{const {store,file,dir}=fixture(t);const u=store.register({username:'旧版账号',password:'password'});fs.writeFileSync(file,JSON.stringify([...store.users.values()]));const next=new UserStore(file,path.join(dir,'no.env'));assert.equal(next.findUserById(u.id).username,'旧版账号');assert.equal(next.settings.maxRooms,5);});
test('HTTP admin authorization, live capacity, registration gate and session revocation',async t=>{
  const {store,root}=fixture(t);const lobby=new Lobby();const {server}=createGameServer({lobby,userStore:store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const admin=lobby.createSession(root),user=store.register({username:'普通测试',password:'password'}),session=lobby.createSession(user);
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(route,body,token=admin.token){const res=await fetch(base+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};}
  for(const route of ['admin/settings','admin/records','admin/users'])assert.equal((await call(route,undefined,session.token)).status,403);
  assert.equal((await call('admin/account',{action:'delete',userId:root.id},session.token)).status,403);
  assert.equal((await call('admin/settings',{registrationOpen:false,maxRooms:1})).status,200);assert.equal(lobby.maxRooms,1);
  assert.equal((await call('auth/register',{username:'不能注册',password:'password'})).status,403);
  assert.equal((await call('admin/account',{action:'create',type:'registered',username:'后台创建',password:'password'})).status,200);
  assert.equal((await call('admin/settings',{registrationOpen:true,maxRooms:0})).status,400);assert.equal(lobby.maxRooms,1);
  session.connected=true;lobby.command(session,{type:'create',requestId:'one'});
  const other=lobby.createSession(store.getOrCreateGuest('other'));other.connected=true;
  assert.throws(()=>lobby.command(other,{type:'create',requestId:'two'}),/1 个房间/);
  assert.equal((await call('admin/account',{action:'password',userId:user.id,password:'newpassword'})).status,200);
  assert.equal((await call('user/profile',undefined,session.token)).status,401);assert.equal(lobby.rooms.size,0);
  const current=lobby.createSession(user);
  await call('admin/ban',{userId:user.id,banned:true,durationMinutes:1});assert.equal((await call('user/profile',undefined,current.token)).status,403);
  user.banUntil=Date.now()-1;assert.equal((await call('user/profile',undefined,current.token)).status,200);
  const editor=store.register({username:'统计管理员',password:'password'});editor.role='admin';editor.permissions=['records'];const e=lobby.createSession(editor);
  assert.equal((await call('admin/records',undefined,e.token)).status,200);assert.equal((await call('admin/settings',undefined,e.token)).status,403);
  assert.equal((await fetch(base+'/admin.html')).status,200);assert.equal((await fetch(base+'/users.json')).status,404);
});
test('game capture and departure archive once including final move and both players',t=>{
  const {store}=fixture(t);const lobby=new Lobby({randomColor:()=>0});lobby.onGameFinished=g=>store.recordGame(g);
  const a=lobby.createSession(store.register({username:'红方棋友',password:'password'})),b=lobby.createSession(store.register({username:'黑方棋友',password:'password'}));a.connected=b.connected=true;
  let n=0;const cmd=(s,type,data={})=>lobby.command(s,{type,requestId:String(++n),...data});
  cmd(a,'create');cmd(b,'join',{roomId:a.roomId});cmd(a,'ready',{ready:true});cmd(b,'ready',{ready:true});
  const room=lobby.rooms.get(a.roomId),g=room.game;g.board=Array(90).fill(null);g.board[85]={s:'r',t:'k'};g.board[4]={s:'b',t:'k'};g.history=[key(g.board)];
  cmd(a,'move',{gameId:g.id,ply:0,action:{from:85,to:4}});
  assert.equal(store.matches.length,1);assert.equal(store.matches[0].records.length,1);assert.equal(store.stats(a.id).wins,1);
  cmd(a,'ready',{ready:true});cmd(b,'ready',{ready:true});cmd(b,'leave');
  assert.equal(store.matches.length,2);assert.equal(store.stats(b.id).games,2);cmd(a,'leave');assert.equal(store.matches.length,2);
});
