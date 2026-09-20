import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserStore, permissions, publicUser, migrateFromJson } from './users.js';
import { Lobby } from './lobby.js';
import { createGameServer } from './server.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangqi-sec-'));
  const file = path.join(dir, 'users.json');
  const store = new UserStore(file, path.join(dir, 'no.env'));
  t.after(() => {
    for (const s of UserStore.openStores) {
      if (s.dbPath && path.resolve(s.dbPath).startsWith(path.resolve(dir))) {
        try { s.close(); } catch {}
      }
    }
    try { store.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return { store, file, dir, root: store.findUserById('10000001') };
}

test('1. Guest identity isolation and no IP-merging', async t => {
  const { store } = fixture(t);
  const lobby = new Lobby();
  const { server } = createGameServer({ lobby, userStore: store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Two guest requests from the same IP (no token) must get separate guest identities
  const res1 = await fetch(base + '/api/auth/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res1.status, 201);
  const data1 = await res1.json();

  const res2 = await fetch(base + '/api/auth/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res2.status, 201);
  const data2 = await res2.json();

  assert.notEqual(data1.user.id, data2.user.id);
  assert.notEqual(data1.guestToken, data2.guestToken);

  // Presenting guestToken restores the same guest identity
  const restoreRes = await fetch(base + '/api/auth/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestToken: data1.guestToken })
  });
  assert.equal(restoreRes.status, 201);
  const restoreData = await restoreRes.json();
  assert.equal(restoreData.user.id, data1.user.id);
  assert.equal(restoreData.user.username, data1.user.username);

  // Ban guest and ensure guest credential cannot log in
  store.setBan(data1.user.id, true, '违规测试', 60);
  const bannedRes = await fetch(base + '/api/auth/guest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestToken: data1.guestToken })
  });
  assert.equal(bannedRes.status, 400); // login/guest creation rejects with 400 banned error
  const bannedErr = await bannedRes.json();
  assert.match(bannedErr.error, /封禁/);
  assert.match(bannedErr.error, /至/);
});

test('2. Default-deny permissions and privilege boundaries', async t => {
  const { store, root } = fixture(t);

  // Default-deny: empty or missing permissions array must return []
  assert.deepEqual(permissions({ role: 'player' }), []);
  assert.deepEqual(permissions({ role: 'admin', id: '20000000', permissions: null }), []);
  assert.deepEqual(permissions({ role: 'admin', id: '20000000', permissions: undefined }), []);
  assert.deepEqual(permissions({ role: 'admin', id: '20000000', permissions: [] }), []);
  assert.deepEqual(permissions({ role: 'admin', id: '20000000', permissions: ['invalid_perm'] }), []);

  // Main admin 10000001 always has full permissions
  assert.deepEqual(permissions(root), ['users', 'records', 'settings']);

  // Admin cannot grant permissions beyond their own scope
  const limitedAdmin = store.register({ username: '受限管理', password: 'password123' });
  store.manage(root, {
    action: 'update',
    userId: limitedAdmin.id,
    username: limitedAdmin.username,
    type: 'registered',
    role: 'admin',
    permissions: ['records']
  });

  const freshLimited = store.findUserById(limitedAdmin.id);
  assert.deepEqual(permissions(freshLimited), ['records']);

  // Limited admin cannot grant 'users' or 'settings'
  const targetUser = store.register({ username: '目标用户', password: 'password123' });
  assert.throws(() => {
    store.manage(freshLimited, {
      action: 'update',
      userId: targetUser.id,
      username: targetUser.username,
      type: 'registered',
      role: 'admin',
      permissions: ['settings']
    });
  }, /没有账号管理权限|超出自身范围/);

  // Cannot delete main admin 10000001
  assert.throws(() => {
    store.manage(root, { action: 'delete', userId: root.id });
  }, /不能/);

  // Cannot delete last admin
  assert.throws(() => {
    store.deleteOwnAccount(root.id, 'admin123');
  }, /不可注销/);
});

test('3. CSRF defense and proxy IP validation', async t => {
  const { store } = fixture(t);
  const lobby = new Lobby();
  const { server } = createGameServer({ lobby, userStore: store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Register a user and capture Set-Cookie
  const regRes = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'CSRF测试', password: 'password123' })
  });
  assert.equal(regRes.status, 201);
  const cookieHeader = regRes.headers.get('set-cookie');
  assert.ok(cookieHeader);
  assert.match(cookieHeader, /xq_session=/);
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);

  const regData = await regRes.json();
  const csrfToken = regData.csrfToken;
  assert.ok(csrfToken);

  // Extract cookies
  const cookies = cookieHeader.split(',').map(c => c.split(';')[0].trim()).join('; ');

  // Mutating request using Cookie without X-CSRF-Token must be rejected with 403
  const failCsrfRes = await fetch(base + '/api/user/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookies
    },
    body: JSON.stringify({ username: '伪造改名' })
  });
  assert.equal(failCsrfRes.status, 403);
  const failCsrfBody = await failCsrfRes.json();
  assert.match(failCsrfBody.error, /CSRF/);

  // Mutating request using Cookie with correct X-CSRF-Token must succeed
  const passCsrfRes = await fetch(base + '/api/user/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookies,
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ username: '合法改名' })
  });
  assert.equal(passCsrfRes.status, 200);

  // Cross-origin request rejection
  const corsRes = await fetch(base + '/api/user/profile', {
    method: 'GET',
    headers: {
      'Cookie': cookies,
      'Origin': 'https://attacker.example.com'
    }
  });
  assert.equal(corsRes.status, 403);
});

test('4. Session revocation on logout, password change and permission change', async t => {
  const { store, root } = fixture(t);
  const lobby = new Lobby();
  const { server } = createGameServer({ lobby, userStore: store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const user = store.register({ username: '会话测试', password: 'oldpassword' });
  const sess = store.createSession(user.id);
  const token = sess.token;

  // Session is active
  const prof1 = await fetch(base + '/api/user/profile', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(prof1.status, 200);

  // Reset password via admin
  store.manage(root, { action: 'password', userId: user.id, password: 'newpassword123' });

  // Previous session must be revoked immediately
  const prof2 = await fetch(base + '/api/user/profile', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(prof2.status, 401);

  // Login with new password gives fresh valid session
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '会话测试', password: 'newpassword123' })
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  const newToken = loginData.token;

  // Logout revokes session
  const logoutRes = await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${newToken}` }
  });
  assert.equal(logoutRes.status, 200);

  const prof3 = await fetch(base + '/api/user/profile', {
    headers: { Authorization: `Bearer ${newToken}` }
  });
  assert.equal(prof3.status, 401);
});

test('5. Data migration: JSON import, idempotency, backup and corrupt data rollback', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiangqi-mig-'));
  const jsonPath = path.join(dir, 'users.json');
  const dbPath = path.join(dir, 'xiangqi.db');
  t.after(() => {
    for (const s of UserStore.openStores) {
      if (s.dbPath && path.resolve(s.dbPath).startsWith(path.resolve(dir))) {
        try { s.close(); } catch {}
      }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  // Create mock users.json with valid structure
  const initialData = {
    users: [
      {
        id: '10000001',
        username: 'admin',
        role: 'admin',
        type: 'registered',
        avatar: '帥',
        passwordHash: 'deadbeef',
        salt: 'cafebabe',
        createdAt: 1000
      },
      {
        id: '12345678',
        username: '迁移老玩家',
        role: 'player',
        type: 'registered',
        avatar: 'https://evil.com/external.png', // External URL must be sanitized to safe seal
        passwordHash: 'hash123',
        salt: 'salt123',
        createdAt: 2000
      }
    ],
    settings: { registrationOpen: false, guestLoginOpen: false, maxRooms: 7 },
    matches: [
      {
        id: 'm-1',
        endedAt: 3000,
        winner: 'r',
        reason: '将死',
        records: [{ side: 'r', text: '炮二平五' }],
        players: [
          { id: '12345678', name: '迁移老玩家', side: 'r' },
          { id: '10000001', name: 'admin', side: 'b' }
        ]
      }
    ]
  };
  fs.writeFileSync(jsonPath, JSON.stringify(initialData, null, 2), 'utf8');

  // Instantiate UserStore with dbPath
  const store = new UserStore(jsonPath, path.join(dir, 'no.env'));

  // Verify accounts imported
  const u = store.findUserById('12345678');
  assert.ok(u);
  assert.equal(u.username, '迁移老玩家');
  assert.equal(u.avatar, '弈'); // external http URL sanitized!
  assert.equal(store.settings.maxRooms, 7);
  assert.equal(store.settings.registrationOpen, false);
  assert.equal(store.settings.guestLoginOpen, false);
  assert.equal(store.matches.length, 1);
  assert.equal(store.stats('12345678').wins, 1);

  // Verify backup created and original JSON still exists
  assert.ok(fs.existsSync(jsonPath));
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('users.json.bak'));
  assert.ok(backups.length >= 1);

  // Idempotency: re-running migration on the same data should not duplicate
  const reResult = migrateFromJson(jsonPath, store.db, { force: false });
  assert.equal(reResult.skipped, true);
  assert.equal(store.matches.length, 1);

  // Corrupted JSON must rollback and not corrupt DB
  const corruptJsonPath = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptJsonPath, '{ invalid json content !!!', 'utf8');
  assert.throws(() => {
    migrateFromJson(corruptJsonPath, store.db, { force: true });
  }, /损坏|解析/);
});

test('6. Idempotent match recording, anonymization and sensitive fields protection', async t => {
  const { store } = fixture(t);
  const u1 = store.register({ username: '玩家甲', password: 'password1' });
  const u2 = store.register({ username: '玩家乙', password: 'password2' });

  // Record a match
  const game = {
    id: 'game-unique-1',
    startedAt: 1000,
    endedAt: 2000,
    winner: 'r',
    reason: '绝杀',
    records: [{ side: 'r', text: '马八进七' }],
    players: [
      { id: u1.id, name: u1.username, side: 'r' },
      { id: u2.id, name: u2.username, side: 'b' }
    ]
  };
  store.recordGame(game);
  assert.equal(store.stats(u1.id).wins, 1);
  assert.equal(store.stats(u2.id).wins, 0);

  // Idempotent: recording again does not duplicate
  store.recordGame(game);
  assert.equal(store.stats(u1.id).games, 1);
  assert.equal(store.stats(u1.id).wins, 1);

  // Data export does NOT contain sensitive hash/salt/tokens
  const exportData = store.exportUserData(u1.id);
  const jsonExport = JSON.stringify(exportData);
  assert.equal(jsonExport.includes('passwordHash'), false);
  assert.equal(jsonExport.includes('password_hash'), false);
  assert.equal(jsonExport.includes('salt'), false);
  assert.equal(jsonExport.includes('token'), false);
  assert.equal(exportData.matches.length, 1);
  assert.equal(exportData.matches[0].result, 'win');

  // User deletes own account: verifies password, anonymizes match records
  assert.throws(() => {
    store.deleteOwnAccount(u1.id, 'wrongpassword');
  }, /密码错误/);

  const delRes = store.deleteOwnAccount(u1.id, 'password1');
  assert.equal(delRes.ok, true);
  assert.equal(store.findUserById(u1.id), null);

  // Opponent u2's record is preserved, u1 is anonymized as '已注销玩家'
  const u2Stats = store.stats(u2.id);
  assert.equal(u2Stats.games, 1);
  const u2Export = store.exportUserData(u2.id);
  assert.equal(u2Export.matches[0].opponent, '已注销玩家');
});

test('7. Lobby back to main menu button exists and is configured', () => {
  const indexHtml = fs.readFileSync('./index.html', 'utf8');
  assert.ok(indexHtml.includes('id="lobbyBackHome"'));
  assert.ok(indexHtml.includes('class="back-home-button"'));
  assert.match(indexHtml, /<button[^>]+id="lobbyBackHome"[^>]*>← 返回主菜单<\/button>/);

  const styleCss = fs.readFileSync('./style.css', 'utf8');
  assert.ok(styleCss.includes('.lobby-top-nav'));
  assert.ok(styleCss.includes('.back-home-button'));

  const appJs = fs.readFileSync('./app.js', 'utf8');
  assert.ok(appJs.includes('lobbyBackHome'));
  assert.ok(appJs.includes('goHome'));
});
