import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Lobby, LobbyError } from './lobby.js';
import { UserStore, publicUser, AVATARS, permissions } from './users.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Set(['index.html', 'style.css', 'app.js', 'engine.js', 'ai.js', 'audio.js', 'online.js', 'admin.html', 'admin.js', 'admin.css']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const isLoopback = h => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';

export function isSameOrigin(origin, expected) {
  try {
    const o = new URL(origin), e = new URL(expected);
    if (o.host === e.host) return true;
    return isLoopback(o.hostname) && isLoopback(e.hostname) && o.port === e.port;
  } catch {
    return false;
  }
}

export function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts[0]?.trim();
    if (!name) return;
    const val = parts.slice(1).join('=').trim();
    try { list[name] = decodeURIComponent(val); } catch { list[name] = val; }
  });
  return list;
}

export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  const header = parts.join('; ');
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', header);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, header]);
  else res.setHeader('Set-Cookie', [prev, header]);
}

export function clearCookie(res, name, opts = {}) {
  setCookie(res, name, '', { ...opts, maxAge: 0 });
}

export function getClientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const trustedList = (process.env.TRUSTED_PROXIES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (trustedList.length > 0) {
    const isTrusted = trustedList.some(p => p === remote || (isLoopback(p) && isLoopback(remote)));
    if (isTrusted && req.headers['x-forwarded-for']) {
      const client = req.headers['x-forwarded-for'].split(',')[0].trim();
      if (client) return client;
    }
  }
  return remote;
}

export function isSecure(req) {
  if (req.socket.encrypted) return true;
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'https') return true;
  return false;
}

export function initEnv(envPath = path.join(root, '.env')) {
  if (!fsSync.existsSync(envPath)) {
    const defaultEnv = `# 围之象棋 · 环境变量配置
# 本文件在服务首次启动时自动生成，已被 .gitignore 忽略，请勿提交至 Git 仓库

# 服务端口与监听地址
PORT=5173
HOST=0.0.0.0

# 系统管理员账号配置（修改后重启游戏生效）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ADMIN_AVATAR=帥

# 可选：公网反向代理外部域名（例如 https://game.example.com）
# PUBLIC_ORIGIN=http://127.0.0.1:5173
# TRUSTED_PROXIES=127.0.0.1,::1
# COOKIE_SECURE=false
`;
    try { fsSync.writeFileSync(envPath, defaultEnv, 'utf8'); } catch {}
  }
  try {
    const lines = fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const k = trimmed.slice(0, eq).trim(), v = trimmed.slice(eq + 1).trim();
        if (k === 'PORT' && process.env.PORT) continue;
        process.env[k] = v;
      }
    }
  } catch {}
}
initEnv();

export function createGameServer({ lobby = new Lobby(), userStore = new UserStore() } = {}) {
  lobby.maxRooms = userStore.settings.maxRooms;
  lobby.onGameFinished = game => userStore.recordGame(game);
  userStore.onRevoke = id => lobby.revokeUser(id);
  const limits = new Map();

  function limit(id, max) {
    const now = Date.now(), entry = limits.get(id);
    if (!entry || entry.until < now) {
      limits.set(id, { until: now + 60000, count: 1 });
      return;
    }
    if (++entry.count > max) throw new LobbyError('操作太频繁，请稍后再试。', 429);
  }

  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  function send(s, res) {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(`data: ${JSON.stringify(lobby.snapshot(s))}\n\n`);
  }

  lobby.onChange = () => {
    for (const s of lobby.sessions.values()) {
      for (const res of s.streams) send(s, res);
    }
  };

  async function readJson(req, maxBytes = 4096) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) throw new LobbyError('请求过大。', 413);
    }
    if (!body.trim()) return {};
    try { return JSON.parse(body); } catch { throw new LobbyError('无效 JSON。', 400); }
  }

  const server = http.createServer(async (req, res) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none';");
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');

    try {
      const url = new URL(req.url, 'http://localhost');
      const clientIp = getClientIp(req);
      const secure = isSecure(req);

      if (url.pathname === '/health') {
        json(res, 200, { ok: true, rooms: lobby.rooms.size, users: userStore.users.size });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const expected = process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
        if (req.headers.origin && !isSameOrigin(req.headers.origin, expected)) {
          throw new LobbyError('不允许跨站访问。', 403);
        }
        if (!req.headers.origin && req.headers.referer && !isSameOrigin(req.headers.referer, expected)) {
          throw new LobbyError('不允许跨站访问。', 403);
        }

        const cookies = parseCookies(req);

        // Public auth endpoints
        if (url.pathname === '/api/auth/register' && req.method === 'POST') {
          if (!userStore.settings.registrationOpen) throw new LobbyError('服务器暂未开放用户注册。', 403);
          limit('ip:' + clientIp, 15);
          const { username, password, avatar } = await readJson(req, 512 * 1024);
          const user = await userStore.register({ username, password, avatar });
          const sess = userStore.createSession(user.id, { ip: clientIp, userAgent: req.headers['user-agent'] });
          setCookie(res, 'xq_session', sess.token, { httpOnly: true, secure, maxAge: 2592000 });
          setCookie(res, 'xq_csrf', sess.csrfToken, { httpOnly: false, secure, maxAge: 2592000 });
          const s = lobby.createSession(user, sess.token);
          s.csrfToken = sess.csrfToken;
          json(res, 201, { token: sess.token, csrfToken: sess.csrfToken, user: publicUser(user), ...lobby.snapshot(s) });
          return;
        }

        if (url.pathname === '/api/auth/login' && req.method === 'POST') {
          limit('ip:' + clientIp, 30);
          const { username, password } = await readJson(req);
          if (username) limit('login:user:' + String(username).toLowerCase(), 10);
          const user = await userStore.login({ username, password });
          const sess = userStore.createSession(user.id, { ip: clientIp, userAgent: req.headers['user-agent'] });
          setCookie(res, 'xq_session', sess.token, { httpOnly: true, secure, maxAge: 2592000 });
          setCookie(res, 'xq_csrf', sess.csrfToken, { httpOnly: false, secure, maxAge: 2592000 });
          const s = lobby.createSession(user, sess.token);
          s.csrfToken = sess.csrfToken;
          json(res, 200, { token: sess.token, csrfToken: sess.csrfToken, user: publicUser(user), ...lobby.snapshot(s) });
          return;
        }

        if (url.pathname === '/api/auth/guest' && req.method === 'POST') {
          if (!userStore.settings.guestLoginOpen) throw new LobbyError('服务器暂未开放游客登录。', 403);
          limit('ip:' + clientIp, 30);
          const { deviceToken, guestToken } = await readJson(req);
          const tokenInput = guestToken || deviceToken || cookies['xq_guest'];
          const user = userStore.getOrCreateGuest(tokenInput);
          const sess = userStore.createSession(user.id, { ip: clientIp, userAgent: req.headers['user-agent'] });
          setCookie(res, 'xq_session', sess.token, { httpOnly: true, secure, maxAge: 2592000 });
          setCookie(res, 'xq_csrf', sess.csrfToken, { httpOnly: false, secure, maxAge: 2592000 });
          if (user.guestToken) {
            setCookie(res, 'xq_guest', user.guestToken, { httpOnly: true, secure, maxAge: 31536000 });
          }
          const s = lobby.createSession(user, sess.token);
          s.csrfToken = sess.csrfToken;
          json(res, 201, {
            token: sess.token,
            csrfToken: sess.csrfToken,
            guestToken: user.guestToken || null,
            user: publicUser(user),
            ...lobby.snapshot(s)
          });
          return;
        }

        if (url.pathname === '/api/session' && req.method === 'POST') {
          limit('ip:' + clientIp, 30);
          const body = await readJson(req).catch(() => ({}));
          // If already has valid session cookie or bearer token, restore it
          const existingToken = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1] || cookies['xq_session'];
          if (existingToken) {
            const verified = userStore.verifySession(existingToken);
            if (verified && !verified.banned) {
              let s = lobby.sessions.get(existingToken);
              if (!s) s = lobby.createSession(verified.user, existingToken);
              s.user = verified.user;
              s.banned = !!verified.banned;
              s.csrfToken = verified.csrfToken;
              json(res, 200, {
                token: existingToken,
                csrfToken: verified.csrfToken,
                user: publicUser(verified.user),
                ...lobby.snapshot(s)
              });
              return;
            }
          }

          // Otherwise establish guest
          if (!userStore.settings.guestLoginOpen) throw new LobbyError('服务器暂未开放游客登录。', 403);
          const tokenInput = body.guestToken || body.deviceToken || cookies['xq_guest'];
          const user = userStore.getOrCreateGuest(tokenInput);
          const sess = userStore.createSession(user.id, { ip: clientIp, userAgent: req.headers['user-agent'] });
          setCookie(res, 'xq_session', sess.token, { httpOnly: true, secure, maxAge: 2592000 });
          setCookie(res, 'xq_csrf', sess.csrfToken, { httpOnly: false, secure, maxAge: 2592000 });
          if (user.guestToken) {
            setCookie(res, 'xq_guest', user.guestToken, { httpOnly: true, secure, maxAge: 31536000 });
          }
          const s = lobby.createSession(user, sess.token);
          s.csrfToken = sess.csrfToken;
          json(res, 201, {
            token: sess.token,
            csrfToken: sess.csrfToken,
            guestToken: user.guestToken || null,
            user: publicUser(user),
            ...lobby.snapshot(s)
          });
          return;
        }

        // Authenticated routes: resolve token
        const bearerMatch = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
        const token = bearerMatch ? bearerMatch[1] : cookies['xq_session'];
        const isCookieAuth = !bearerMatch && !!cookies['xq_session'];

        if (!token) {
          throw new LobbyError('未提供身份凭据。', 401);
        }

        let sessionVerification = userStore.verifySession(token);
        let s = lobby.sessions.get(token);

        if (!sessionVerification && s?.user) {
          const fresh = userStore.findUserById(s.id || s.user.id);
          if (fresh) {
            sessionVerification = {
              user: fresh,
              csrfToken: s.csrfToken || null,
              banned: !!fresh.banned
            };
          }
        }

        if (!sessionVerification) {
          if (isCookieAuth) {
            clearCookie(res, 'xq_session');
            clearCookie(res, 'xq_csrf');
          }
          throw new LobbyError('身份已过期，请重新登录。', 401);
        }

        if (!s) {
          s = lobby.createSession(sessionVerification.user, token);
        }
        s.user = sessionVerification.user;
        s.banned = !!sessionVerification.user.banned;
        s.csrfToken = sessionVerification.csrfToken;

        if (sessionVerification.banned || s.banned) {
          const u = sessionVerification.user;
          const untilStr = u?.banUntil ? ('至 ' + new Date(u.banUntil).toLocaleString('zh-CN', { hour12: false })) : '（永久封禁）';
          throw new LobbyError('您的账号已被封禁' + (u?.banUntil ? untilStr : '') + '：' + (u?.banReason || '违规操作') + (!u?.banUntil ? '（永久封禁）' : ''), 403);
        }

        // CSRF verification on mutating requests when authenticated by cookie
        if (['POST', 'PUT', 'DELETE'].includes(req.method) && isCookieAuth) {
          const clientCsrf = req.headers['x-csrf-token'];
          const expectedCsrf = sessionVerification.csrfToken;
          if (!clientCsrf || !expectedCsrf || clientCsrf.length !== expectedCsrf.length || !crypto.timingSafeEqual(Buffer.from(clientCsrf), Buffer.from(expectedCsrf))) {
            throw new LobbyError('CSRF 校验失败，请刷新页面后重试。', 403);
          }
        }

        // Logout
        if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
          userStore.deleteSession(token);
          clearCookie(res, 'xq_session');
          clearCookie(res, 'xq_csrf');
          lobby.leave(s);
          lobby.sessions.delete(s.token);
          json(res, 200, { ok: true });
          return;
        }

        // Upgrade guest
        if (url.pathname === '/api/auth/upgrade-guest' && req.method === 'POST') {
          limit('user:' + s.id, 15);
          const { username, password, avatar } = await readJson(req);
          const updated = await userStore.upgradeGuest(s.user.id, { username, password, avatar });
          s.user = updated;
          s.name = updated.username;
          lobby.updateUser(updated);
          json(res, 200, { ok: true, user: publicUser(updated), ...lobby.snapshot(s) });
          return;
        }

        // User profile
        if (url.pathname === '/api/user/profile' && req.method === 'GET') {
          json(res, 200, { user: publicUser(s.user), csrfToken: sessionVerification.csrfToken, avatars: AVATARS });
          return;
        }

        if (url.pathname === '/api/user/profile' && req.method === 'POST') {
          limit('user:' + s.id, 30);
          const { username, avatar } = await readJson(req, 512 * 1024);
          if (!s.user) throw new LobbyError('用户未初始化。', 400);
          const updated = userStore.updateProfile(s.user.id, { username, avatar });
          s.user = updated;
          s.name = updated.username;
          lobby.updateUser(updated);
          json(res, 200, { ok: true, user: publicUser(updated), ...lobby.snapshot(s) });
          return;
        }

        // User self-deletion
        if (url.pathname === '/api/user/delete' && req.method === 'POST') {
          limit('user:' + s.id, 5);
          const { password } = await readJson(req);
          await userStore.deleteOwnAccount(s.user.id, password, clientIp);
          userStore.deleteSession(token);
          clearCookie(res, 'xq_session');
          clearCookie(res, 'xq_csrf');
          lobby.leave(s);
          lobby.sessions.delete(s.token);
          json(res, 200, { ok: true, message: '账号已注销，个人历史对局已完成匿名化。' });
          return;
        }

        // User data export
        if (url.pathname === '/api/user/export' && req.method === 'GET') {
          limit('user:' + s.id, 10);
          const exportData = userStore.exportUserData(s.user.id);
          json(res, 200, exportData);
          return;
        }

        // Admin routes
        if (url.pathname === '/api/admin/users' && req.method === 'GET') {
          if (s.user?.role !== 'admin') throw new LobbyError('无权访问管理面板。', 403);
          if (!permissions(s.user).some(p => p === 'users' || p === 'records')) throw new LobbyError('没有账号查看权限。', 403);
          const query = url.searchParams.get('q') || '';
          const filter = url.searchParams.get('filter') || 'all';
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const limitNum = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          if (url.searchParams.has('offset') || url.searchParams.has('q') || url.searchParams.has('filter')) {
            json(res, 200, userStore.listUsersPaged({ query, filter, offset, limit: limitNum }));
          } else {
            json(res, 200, { users: userStore.listUsers() });
          }
          return;
        }

        if (url.pathname === '/api/admin/settings') {
          if (!permissions(s.user).includes('settings')) throw new LobbyError('没有服务器设置权限。', 403);
          if (req.method === 'POST') {
            userStore.updateSettings(await readJson(req), s.user, clientIp);
            lobby.maxRooms = userStore.settings.maxRooms;
            lobby.changed();
          } else if (req.method !== 'GET') throw new LobbyError('请求方法无效。', 405);
          json(res, 200, { settings: userStore.settings, rooms: lobby.rooms.size, sessions: lobby.sessions.size });
          return;
        }

        if (url.pathname === '/api/admin/records' && req.method === 'GET') {
          if (!permissions(s.user).includes('records')) throw new LobbyError('没有对局记录权限。', 403);
          const id = url.searchParams.get('userId');
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const limitNum = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          const { records, total } = userStore.listMatchesPaged({ userId: id, offset, limit: limitNum });
          json(res, 200, { records, total });
          return;
        }

        if (url.pathname === '/api/admin/account' && req.method === 'POST') {
          if (!permissions(s.user).includes('users')) throw new LobbyError('没有账号管理权限。', 403);
          limit('admin:' + s.id, 60);
          const data = await readJson(req);
          const target = userStore.findUserById(data.userId);
          if (data.action !== 'create' && [...lobby.rooms.values()].some(r => r.phase === 'playing' && r.members.some(p => p.id === data.userId))) {
            throw new LobbyError('该账号正在对局，请待对局结束后修改或删除。', 409);
          }
          const result = await userStore.manage(s.user, data, clientIp);
          if (target && ['update', 'password', 'delete'].includes(data.action)) {
            lobby.revokeUser(target.id);
          }
          json(res, 200, { ok: true, user: data.action === 'delete' ? null : publicUser(result) });
          return;
        }

        if (url.pathname === '/api/admin/ban' && req.method === 'POST') {
          if (!permissions(s.user).includes('users')) throw new LobbyError('无权执行管理操作。', 403);
          const { userId, banned, reason, durationMinutes } = await readJson(req);
          if (!userId) throw new LobbyError('缺少目标用户标识。');
          const target = userStore.setBan(userId, banned, reason, durationMinutes, s.user, clientIp);
          if (banned) lobby.banUser(userId, reason);
          else {
            for (const session of lobby.sessions.values()) {
              if (session.id === userId) session.banned = false;
            }
          }
          json(res, 200, { ok: true, user: publicUser(target) });
          return;
        }

        if (url.pathname === '/api/admin/audit-logs' && req.method === 'GET') {
          if (!permissions(s.user).includes('users')) throw new LobbyError('无权查看审计日志。', 403);
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const limitNum = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          json(res, 200, userStore.listAuditLogs({ limit: limitNum, offset }));
          return;
        }

        if (url.pathname === '/api/events' && req.method === 'GET') {
          if (s.streams.size >= 3) throw new LobbyError('连接数过多，请关闭重复页面。', 429);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          res.flushHeaders();
          res.on('close', () => lobby.disconnect(s, res));
          lobby.connect(s, res);
          return;
        }

        if (url.pathname === '/api/command' && req.method === 'POST') {
          limit('user:' + s.id, 120);
          const c = await readJson(req);
          json(res, 200, lobby.command(s, c));
          return;
        }

        throw new LobbyError('接口不存在。', 404);
      }

      if (!['GET', 'HEAD'].includes(req.method)) throw new LobbyError('不支持的请求方法。', 405);
      const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (!publicFiles.has(file)) throw new LobbyError('文件不存在。', 404);
      const content = await fs.readFile(path.join(root, file));
      res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      if (!res.headersSent) json(res, e instanceof LobbyError ? e.status : 400, { error: e.message || '请求处理失败。' });
      else res.end();
    }
  });

  let ticks = 0;
  const timer = setInterval(() => {
    lobby.sweep();
    userStore.cleanExpiredSessions();
    if (++ticks % 10 === 0) {
      for (const s of lobby.sessions.values()) {
        for (const res of s.streams) res.write(': heartbeat\n\n');
      }
    }
    for (const [k, v] of limits) {
      if (v.until < Date.now()) limits.delete(k);
    }
  }, 1000);
  timer.unref();

  const origClose = server.close.bind(server);
  server.close = function(cb) {
    clearInterval(timer);
    try { userStore.close(); } catch {}
    return origClose(cb);
  };
  server.on('close', () => {
    clearInterval(timer);
    try { userStore.close(); } catch {}
  });

  return { server, lobby, userStore };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createGameServer();
  const port = Number(process.env.PORT || 5173), host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(`Xiangqi-Go ready on ${host}:${port}`));
  const shutdown = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
