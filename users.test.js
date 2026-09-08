import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createGameServer} from './server.js';
import {UserStore} from './users.js';
import {Lobby} from './lobby.js';

test('auth, profile, guest restrictions, and admin ban flow', async t => {
  const testDb = './users.test.json';
  const testDbSqlite = './users.test.db';
  try { fs.unlinkSync(testDb); } catch {}
  try { fs.unlinkSync(testDbSqlite); } catch {}
  t.after(() => {
    try { userStore.close(); } catch {}
    try { fs.unlinkSync(testDb); } catch {}
    try { fs.unlinkSync(testDbSqlite); } catch {}
  });

  const userStore = new UserStore(testDb);
  const lobby = new Lobby();
  const {server} = createGameServer({lobby, userStore});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. Admin login
  const expectedAdmin = process.env.ADMIN_USERNAME || 'admin';
  const expectedPwd = process.env.ADMIN_PASSWORD || 'admin123';
  const adminRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: expectedAdmin, password: expectedPwd})
  });
  assert.equal(adminRes.status, 200);
  const adminData = await adminRes.json();
  assert.equal(adminData.user.role, 'admin');
  const adminToken = adminData.token;

  // 2. Register regular user
  const regRes = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: '对弈墨客', password: 'secretpassword', avatar: '馬'})
  });
  assert.equal(regRes.status, 201);
  const regData = await regRes.json();
  assert.equal(regData.user.username, '对弈墨客');
  assert.match(regData.user.id, /^\d+$/); // Decimal digits ID
  assert.equal(regData.user.avatar, '馬');
  assert.equal(regData.user.type, 'registered');
  const userToken = regData.token;
  const userId = regData.user.id;

  // Duplicate registration should fail
  const dupRes = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: '对弈墨客', password: 'secretpassword'})
  });
  assert.equal(dupRes.status, 400);

  // 3. Guest login with device token
  const guestRes = await fetch(base + '/api/auth/guest', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({deviceToken: 'device-unique-abc-123'})
  });
  assert.equal(guestRes.status, 201);
  const guestData = await guestRes.json();
  assert.equal(guestData.user.type, 'guest');
  assert.match(guestData.user.id, /^\d+$/); // Decimal digits ID for guest
  assert.ok(guestData.user.username.length > 0);
  assert.ok(guestData.user.avatar.length > 0);
  const guestToken = guestData.token;
  const guestId = guestData.user.id;

  // Same device token returns same guest
  const guestRes2 = await fetch(base + '/api/auth/guest', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({deviceToken: 'device-unique-abc-123'})
  });
  const guestData2 = await guestRes2.json();
  assert.equal(guestData2.user.id, guestId);
  assert.equal(guestData2.user.username, guestData.user.username);

  // 4. Profile update: registered user CAN update username and avatar
  const updateRes = await fetch(base + '/api/user/profile', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${userToken}`},
    body: JSON.stringify({username: '更名棋客', avatar: '車'})
  });
  assert.equal(updateRes.status, 200);
  const updatedData = await updateRes.json();
  assert.equal(updatedData.user.username, '更名棋客');
  assert.equal(updatedData.user.avatar, '車');


  // 4b. Registered user can upload custom data URL image avatar
  const customDataUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-image-bytes').toString('base64');
  const imgUpdateRes = await fetch(base + '/api/user/profile', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${userToken}`},
    body: JSON.stringify({avatar: customDataUrl})
  });
  assert.equal(imgUpdateRes.status, 200);
  assert.equal((await imgUpdateRes.json()).user.avatar, customDataUrl);

  // 5. Profile update: guest CANNOT update profile (rejected with 400/403)
  const guestUpdateRes = await fetch(base + '/api/user/profile', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${guestToken}`},
    body: JSON.stringify({username: '想改名字'})
  });
  assert.notEqual(guestUpdateRes.status, 200);
  const guestUpdateErr = await guestUpdateRes.json();
  assert.match(guestUpdateErr.error, /游客账号由系统自动生成/);

  // 6. Non-admin accessing admin users list is forbidden
  const forbiddenRes = await fetch(base + '/api/admin/users', {
    headers: {Authorization: `Bearer ${userToken}`}
  });
  assert.equal(forbiddenRes.status, 403);

  // 7. Admin can view users list
  const listRes = await fetch(base + '/api/admin/users', {
    headers: {Authorization: `Bearer ${adminToken}`}
  });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.ok(listData.users.length >= 3); // admin, registered, guest

  // 8. Admin can ban user
  const banRes = await fetch(base + '/api/admin/ban', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`},
    body: JSON.stringify({userId, banned: true, reason: '利用外挂'})
  });
  assert.equal(banRes.status, 200);
  const banData = await banRes.json();
  assert.equal(banData.user.banned, true);

  // Banned user cannot perform authenticated actions
  const bannedActionRes = await fetch(base + '/api/user/profile', {
    headers: {Authorization: `Bearer ${userToken}`}
  });
  assert.equal(bannedActionRes.status, 403);
  assert.match((await bannedActionRes.json()).error, /封禁/);

  // Banned user cannot log in and prompt includes ban reason/time
  const bannedLoginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: '更名棋客', password: 'secretpassword'})
  });
  assert.equal(bannedLoginRes.status, 400);
  const bannedLoginErr = await bannedLoginRes.json();
  assert.match(bannedLoginErr.error, /该账号已被封禁/);

  // 9. Admin unban user
  const unbanRes = await fetch(base + '/api/admin/ban', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`},
    body: JSON.stringify({userId, banned: false})
  });
  assert.equal(unbanRes.status, 200);
  assert.equal((await unbanRes.json()).user.banned, false);
});

test('auto-generate .env and configure admin credentials from environment', async t => {
  const tempEnv = './test.custom.env';
  const tempDb = './users.custom.json';
  try { fs.unlinkSync(tempEnv); } catch {}
  try { fs.unlinkSync(tempDb); } catch {}
  t.after(() => {
    try { fs.unlinkSync(tempEnv); } catch {}
    try { fs.unlinkSync(tempDb); } catch {}
  });

  const {initEnv} = await import('./server.js');
  // Auto generate .env
  initEnv(tempEnv);
  assert.ok(fs.existsSync(tempEnv));
  const envContent = fs.readFileSync(tempEnv, 'utf8');
  assert.match(envContent, /ADMIN_USERNAME=admin/);
  assert.match(envContent, /ADMIN_PASSWORD=admin123/);

  // Write custom admin credentials to custom env file
  fs.writeFileSync(tempEnv, 'ADMIN_USERNAME=superboss\nADMIN_PASSWORD=supersecret999\nADMIN_AVATAR=將\n', 'utf8');
  initEnv(tempEnv);

  const userStore = new UserStore(tempDb, tempEnv);
  userStore.syncAdminFromEnv(tempEnv);
  const admin = userStore.findUserByUsername('superboss');
  assert.ok(admin);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.avatar, '將');

  // Verify login with custom credentials
  const logged = userStore.login({username: 'superboss', password: 'supersecret999'});
  assert.equal(logged.id, admin.id);

  // Clean up env vars
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_AVATAR;
});
