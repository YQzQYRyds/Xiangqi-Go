export function getCookie(name) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

const GUEST_KEY = 'xiangqi-guest-token';
export function readGuestToken() {
  try { return localStorage.getItem(GUEST_KEY); } catch { return null; }
}
export function writeGuestToken(t) {
  try { localStorage.setItem(GUEST_KEY, t); } catch {}
}
export function clearGuestToken() {
  try { localStorage.removeItem(GUEST_KEY); } catch {}
}

export function getDeviceId() {
  return readGuestToken() || '';
}

const TOKEN_KEY = 'xiangqi-online-token';
function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch {}
  try { sessionStorage.setItem(TOKEN_KEY, t); } catch {}
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
}

export class OnlineConnection {
  constructor(onState, onStatus) {
    this.onState = onState;
    this.onStatus = onStatus;
    this.token = null;
    this.csrfToken = null;
    this.guestToken = readGuestToken();
    this.enabled = false;
    this.controller = null;
    this.retry = null;
    this.version = -1;
  }

  getCsrf() {
    return this.csrfToken || getCookie('xq_csrf') || '';
  }

  getHeaders(extra = {}) {
    const h = { ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    const csrf = this.getCsrf();
    if (csrf) h['X-CSRF-Token'] = csrf;
    return h;
  }

  accept(state) {
    if (state.version <= this.version) return;
    this.version = state.version;
    this.onState(state);
  }

  async start() {
    if (this.enabled) return;
    this.enabled = true;
    this.token = readToken();
    this.csrfToken = getCookie('xq_csrf');
    await this.connect();
  }

  async connect() {
    if (!this.enabled) return;
    this.onStatus(false, '正在连接大厅…');
    this.controller = new AbortController();
    try {
      if (!this.token) {
        const guestTok = readGuestToken();
        const res = await fetch('/api/session', {
          method: 'POST',
          credentials: 'same-origin',
          headers: this.getHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ guestToken: guestTok }),
          signal: this.controller.signal
        });
        const data = await res.json();
        if (!res.ok) throw Error(data.error || '会话建立失败');
        this.token = data.token;
        this.csrfToken = data.csrfToken || getCookie('xq_csrf');
        if (data.guestToken) {
          this.guestToken = data.guestToken;
          writeGuestToken(data.guestToken);
        }
        this.version = -1;
        writeToken(this.token);
        this.accept(data);
      }

      const res = await fetch('/api/events', {
        credentials: 'same-origin',
        headers: this.getHeaders(),
        signal: this.controller.signal
      });

      if (res.status === 401) {
        this.token = null;
        this.version = -1;
        clearToken();
        throw Error('身份已过期，正在重建连接…');
      }
      if (!res.ok) throw Error('连接失败，正在重试…');

      this.onStatus(true, '已连接');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.enabled) {
        const { done, value } = await reader.read();
        if (done) throw Error('连接中断，正在重连…');
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.startsWith('data: ')) {
            this.accept(JSON.parse(event.slice(6)));
          }
        }
      }
    } catch (e) {
      if (!this.enabled) return;
      this.onStatus(false, e.message || '连接中断，正在重连…');
      this.retry = setTimeout(() => this.connect(), 2000);
    }
  }

  async command(type, data = {}) {
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await fetch('/api/command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ type, ...data, requestId }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await res.json();
    if (res.status === 401) {
      this.token = null;
      this.version = -1;
      clearToken();
      this.connect();
    }
    if (!res.ok) throw Error(result.error || '操作失败');
    this.accept(result);
    return result;
  }

  async register(username, password, avatar) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ username, password, avatar })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '注册失败');
    this.token = data.token;
    this.csrfToken = data.csrfToken || getCookie('xq_csrf');
    clearGuestToken();
    this.version = -1;
    writeToken(this.token);
    this.accept(data);
    return data;
  }

  async login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '登录失败');
    this.token = data.token;
    this.csrfToken = data.csrfToken || getCookie('xq_csrf');
    clearGuestToken();
    this.version = -1;
    writeToken(this.token);
    this.accept(data);
    return data;
  }

  async guestLogin() {
    const guestToken = readGuestToken();
    const res = await fetch('/api/auth/guest', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ guestToken })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '游客登录失败');
    this.token = data.token;
    this.csrfToken = data.csrfToken || getCookie('xq_csrf');
    if (data.guestToken) {
      this.guestToken = data.guestToken;
      writeGuestToken(data.guestToken);
    }
    this.version = -1;
    writeToken(this.token);
    this.accept(data);
    return data;
  }

  async upgradeGuest(username, password, avatar) {
    const res = await fetch('/api/auth/upgrade-guest', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ username, password, avatar })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '升级正式账号失败');
    clearGuestToken();
    if (data.version) this.accept(data);
    return data;
  }

  async logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: this.getHeaders()
      });
    } catch {}
    this.token = null;
    this.csrfToken = null;
    this.version = -1;
    clearToken();
    clearGuestToken();
    this.stop();
  }

  async getProfile() {
    const res = await fetch('/api/user/profile', {
      credentials: 'same-origin',
      headers: this.getHeaders()
    });
    if (res.status === 401) {
      this.token = null;
      clearToken();
      return null;
    }
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '获取资料失败');
    if (data.csrfToken) this.csrfToken = data.csrfToken;
    return data;
  }

  async updateProfile(username, avatar) {
    const res = await fetch('/api/user/profile', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ username, avatar })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '修改资料失败');
    if (data.version) this.accept(data);
    return data;
  }

  async deleteAccount(password) {
    const res = await fetch('/api/user/delete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '注销账号失败');
    this.token = null;
    this.csrfToken = null;
    this.version = -1;
    clearToken();
    clearGuestToken();
    this.stop();
    return data;
  }

  async exportData() {
    const res = await fetch('/api/user/export', {
      credentials: 'same-origin',
      headers: this.getHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '导出数据失败');
    return data;
  }

  async getAdminUsers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = '/api/admin/users' + (qs ? '?' + qs : '');
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: this.getHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '获取玩家列表失败');
    return data.users || data;
  }

  async banUser(userId, banned, reason, durationMinutes = 0) {
    const res = await fetch('/api/admin/ban', {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ userId, banned, reason, durationMinutes })
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || '操作失败');
    return data.user;
  }

  stop() {
    this.enabled = false;
    this.controller?.abort();
    clearTimeout(this.retry);
  }
}
