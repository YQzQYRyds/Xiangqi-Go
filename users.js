import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = process.env.DATABASE_PATH || path.join(root, 'data', 'xiangqi.db');
const defaultJsonPath = process.env.USER_STORE_PATH || path.join(root, 'users.json');

export const ADMIN_PERMISSIONS = ['users', 'records', 'settings'];
export const AVATARS = ['帥','將','仕','士','相','象','車','馬','炮','兵','卒','弈','墨','客','竹','松','泉','月','风','云'];
export const DEFAULT_COST = { N: 16384, r: 8, p: 1, keyLen: 64 };

const prefixes = ['听雨','松风','云水','竹影','清泉','落霞','山月','长风','寒梅','青岚'];
const guestWords = ['棋客','隐士','游侠','书生','行者','居士','弈者','墨客'];

export function permissions(user) {
  if (!user || user.role !== 'admin') return [];
  if (user.id === '10000001') return [...ADMIN_PERMISSIONS];
  if (Array.isArray(user.permissions)) {
    return user.permissions.filter(p => ADMIN_PERMISSIONS.includes(p));
  }
  return [];
}

export function isValidAvatar(avatar) {
  if (typeof avatar !== 'string') return false;
  if (AVATARS.includes(avatar)) return true;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar) && avatar.length <= 300000) return true;
  return false;
}

export function sanitizeAvatar(avatar) {
  if (isValidAvatar(avatar)) return avatar;
  return '弈';
}

export async function hashPassword(password, salt, cost = DEFAULT_COST) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, cost.keyLen, { N: cost.N, r: cost.r, p: cost.p }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

export function hashPasswordSync(password, salt, cost = DEFAULT_COST) {
  return crypto.scryptSync(password, salt, cost.keyLen, { N: cost.N, r: cost.r, p: cost.p }).toString('hex');
}

export async function verifyPassword(password, salt, hash, cost = DEFAULT_COST) {
  try {
    const calculated = await hashPassword(password, salt, cost);
    if (calculated.length !== hash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

export function verifyPasswordSync(password, salt, hash, cost = DEFAULT_COST) {
  try {
    const calculated = hashPasswordSync(password, salt, cost);
    if (calculated.length !== hash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatar: sanitizeAvatar(user.avatar),
    type: user.type,
    role: user.role,
    banned: !!user.banned,
    banUntil: user.banUntil || null,
    banReason: user.banReason || null,
    permissions: permissions(user),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt
  };
}

export function migrateFromJson(jsonPath, db, { backup = (!jsonPath.includes('test') && !jsonPath.includes('tmp')), force = false } = {}) {
  if (!fs.existsSync(jsonPath)) return { migrated: false, count: 0 };
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (e) {
    throw new Error(`读取旧版数据文件失败：${e.message}`, { cause: e });
  }
  if (!raw.trim()) return { migrated: false, count: 0 };

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('迁移失败：JSON 数据文件已损坏，无法解析。', { cause: e });
  }

  const fileHash = crypto.createHash('sha256').update(raw).digest('hex');
  const storedHashRow = db.prepare("SELECT value FROM settings WHERE key = 'json_migration_hash'").get();
  if (storedHashRow && storedHashRow.value === fileHash && !force) {
    return { migrated: false, count: 0, skipped: true };
  }

  let backupPath = null;
  if (backup) {
    backupPath = `${jsonPath}.bak.${Date.now()}`;
    try {
      fs.copyFileSync(jsonPath, backupPath);
    } catch (e) {
      throw new Error(`迁移前备份失败，已中止迁移：${e.message}`, { cause: e });
    }
  }

  const userList = Array.isArray(data) ? data : (data.users || []);
  const settingsData = Array.isArray(data) ? { registrationOpen: true, maxRooms: 5 } : (data.settings || {});
  const matchList = Array.isArray(data) ? [] : (data.matches || []);

  const now = Date.now();
  let userCount = 0;
  let matchCount = 0;

  // Conflict validation: check for duplicate usernames in JSON
  const seenUsernames = new Map();
  for (const u of userList) {
    if (!u.username || typeof u.username !== 'string') {
      throw new Error('迁移失败：数据中存在缺失或无效用户名的账号记录。');
    }
    const lower = u.username.trim().toLowerCase();
    if (seenUsernames.has(lower) && seenUsernames.get(lower) !== String(u.id)) {
      throw new Error(`迁移失败：数据中存在重复用户名冲突 “${u.username}”。`);
    }
    seenUsernames.set(lower, String(u.id));
  }

  db.exec('BEGIN TRANSACTION');
  try {
    const stmtInsertUser = db.prepare(`
      INSERT OR REPLACE INTO users (
        id, username, type, role, permissions_json, avatar, banned, ban_until, ban_reason, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const stmtInsertCred = db.prepare(`
      INSERT OR REPLACE INTO credentials (
        user_id, password_hash, salt, algo_version, cost_params_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const stmtInsertGuestCred = db.prepare(`
      INSERT OR REPLACE INTO guest_credentials (
        token_hash, user_id, created_at, last_used_at
      ) VALUES (?, ?, ?, ?)
    `);
    const stmtInsertMatch = db.prepare(`
      INSERT OR REPLACE INTO matches (
        id, started_at, ended_at, winner, reason, records_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const stmtInsertMatchPlayer = db.prepare(`
      INSERT INTO match_players (match_id, player_id, player_name, side) VALUES (?, ?, ?, ?)
    `);
    const stmtDeleteMatchPlayers = db.prepare(`
      DELETE FROM match_players WHERE match_id = ?
    `);

    for (const u of userList) {
      const id = String(u.id || (u.role === 'admin' ? '10000001' : crypto.randomInt(10000000, 99999999)));
      const username = u.username.trim();
      const type = u.type === 'guest' ? 'guest' : 'registered';
      const role = u.role === 'admin' ? 'admin' : 'player';
      const perms = Array.isArray(u.permissions)
        ? JSON.stringify(u.permissions)
        : (role === 'admin' && id === '10000001' ? JSON.stringify(ADMIN_PERMISSIONS) : '[]');
      const avatar = sanitizeAvatar(u.avatar);
      const banned = u.banned ? 1 : 0;
      const banUntil = u.banUntil ?? null;
      const banReason = u.banReason ?? null;
      const createdAt = u.createdAt || now;
      const updatedAt = u.updatedAt || now;
      const lastLoginAt = u.lastLoginAt || now;

      stmtInsertUser.run(id, username, type, role, perms, avatar, banned, banUntil, banReason, createdAt, updatedAt, lastLoginAt);
      userCount++;

      if (u.passwordHash && u.salt) {
        stmtInsertCred.run(id, u.passwordHash, u.salt, 'scrypt_v1', JSON.stringify(DEFAULT_COST), updatedAt);
      }
      if (u.deviceToken) {
        const tokenHash = crypto.createHash('sha256').update(String(u.deviceToken)).digest('hex');
        stmtInsertGuestCred.run(tokenHash, id, createdAt, lastLoginAt);
      }
    }

    const regOpen = settingsData.registrationOpen !== false ? 'true' : 'false';
    const maxRooms = String(Number.isInteger(settingsData.maxRooms) ? settingsData.maxRooms : 5);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('registration_open', ?)").run(regOpen);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('max_rooms', ?)").run(maxRooms);

    for (const m of matchList) {
      if (!m.id || !m.endedAt) continue;
      stmtInsertMatch.run(
        m.id,
        m.startedAt ?? null,
        m.endedAt,
        m.winner ?? null,
        m.reason ?? null,
        JSON.stringify(m.records || [])
      );
      stmtDeleteMatchPlayers.run(m.id);
      if (Array.isArray(m.players)) {
        for (const p of m.players) {
          stmtInsertMatchPlayer.run(m.id, p.id ?? null, p.name || '未知棋友', p.side || 'r');
        }
      }
      matchCount++;
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('json_migration_hash', ?)").run(fileHash);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('json_migration_time', ?)").run(String(now));
    if (backupPath) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('json_migration_backup', ?)").run(backupPath);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`数据迁移失败并已安全回滚：${err.message}`, { cause: err });
  }

  return { migrated: true, backupPath, userCount, matchCount };
}

export class UserStore {
  static openStores = new Set();
  constructor(filePath = process.env.USER_STORE_PATH || defaultDbPath, envPath = path.join(root, '.env')) {
    this.envPath = envPath;
    this.userCache = new Map();
    this.initDb(filePath);
    this.initAdmin({ force: false });
  }

  initDb(filePath) {
    let dbPath = filePath;
    let jsonToMigrate = null;

    if (filePath === ':memory:') {
      dbPath = ':memory:';
    } else if (typeof filePath === 'string' && filePath.endsWith('.json')) {
      jsonToMigrate = filePath;
      dbPath = filePath.replace(/\.json$/i, '.db');
    } else if (typeof filePath === 'string' && (filePath.endsWith('.db') || filePath.endsWith('.sqlite'))) {
      dbPath = filePath;
      const candidateJson = filePath.replace(/\.(db|sqlite)$/i, '.json');
      if (fs.existsSync(candidateJson)) jsonToMigrate = candidateJson;
    } else if (process.env.DATABASE_PATH) {
      dbPath = process.env.DATABASE_PATH;
    }

    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
      UserStore.openStores.add(this);
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('registered', 'guest')),
        role TEXT NOT NULL CHECK(role IN ('player', 'admin')),
        permissions_json TEXT NOT NULL DEFAULT '[]',
        avatar TEXT NOT NULL DEFAULT '弈',
        banned INTEGER NOT NULL DEFAULT 0,
        ban_until INTEGER,
        ban_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

      CREATE TABLE IF NOT EXISTS credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        algo_version TEXT NOT NULL DEFAULT 'scrypt_v1',
        cost_params_json TEXT NOT NULL DEFAULT '{"N":16384,"r":8,"p":1,"keyLen":64}',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS guest_credentials (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guest_credentials_user_id ON guest_credentials(user_id);

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        started_at INTEGER,
        ended_at INTEGER NOT NULL,
        winner TEXT,
        reason TEXT,
        records_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches(ended_at);

      CREATE TABLE IF NOT EXISTS match_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id TEXT,
        player_name TEXT NOT NULL,
        side TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_match_players_match_id ON match_players(match_id);
      CREATE INDEX IF NOT EXISTS idx_match_players_player_id ON match_players(player_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT,
        actor_name TEXT NOT NULL,
        target_id TEXT,
        action TEXT NOT NULL,
        details_json TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    `);

    // Prepare statements
    this.stmtFindUserById = this.db.prepare(`
      SELECT u.*, c.password_hash, c.salt, c.algo_version, c.cost_params_json
      FROM users u
      LEFT JOIN credentials c ON u.id = c.user_id
      WHERE u.id = ?
    `);
    this.stmtFindUserByUsername = this.db.prepare(`
      SELECT u.*, c.password_hash, c.salt, c.algo_version, c.cost_params_json
      FROM users u
      LEFT JOIN credentials c ON u.id = c.user_id
      WHERE u.username = ? COLLATE NOCASE
    `);
    this.stmtInsertUser = this.db.prepare(`
      INSERT INTO users (
        id, username, type, role, permissions_json, avatar, banned, ban_until, ban_reason, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtUpdateUserLogin = this.db.prepare(`
      UPDATE users SET last_login_at = ? WHERE id = ?
    `);
    this.stmtUpdateUserBan = this.db.prepare(`
      UPDATE users SET banned = ?, ban_until = ?, ban_reason = ?, updated_at = ? WHERE id = ?
    `);
    this.stmtUpdateUserFull = this.db.prepare(`
      UPDATE users SET username = ?, type = ?, role = ?, permissions_json = ?, updated_at = ? WHERE id = ?
    `);
    this.stmtUpdateUserProfile = this.db.prepare(`
      UPDATE users SET username = ?, avatar = ?, updated_at = ? WHERE id = ?
    `);
    this.stmtDeleteUser = this.db.prepare(`
      DELETE FROM users WHERE id = ?
    `);
    this.stmtCountUsers = this.db.prepare(`
      SELECT COUNT(*) as c FROM users
    `);
    this.stmtAllUsers = this.db.prepare(`
      SELECT u.*, c.password_hash, c.salt, c.algo_version, c.cost_params_json
      FROM users u
      LEFT JOIN credentials c ON u.id = c.user_id
      ORDER BY u.created_at ASC
    `);
    this.stmtCountActiveAdmins = this.db.prepare(`
      SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND banned = 0
    `);

    // Credentials
    this.stmtInsertOrReplaceCredential = this.db.prepare(`
      INSERT OR REPLACE INTO credentials (user_id, password_hash, salt, algo_version, cost_params_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindGuestCredential = this.db.prepare(`
      SELECT * FROM guest_credentials WHERE token_hash = ?
    `);
    this.stmtInsertGuestCredential = this.db.prepare(`
      INSERT OR REPLACE INTO guest_credentials (token_hash, user_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?)
    `);
    this.stmtUpdateGuestCredential = this.db.prepare(`
      UPDATE guest_credentials SET last_used_at = ? WHERE token_hash = ?
    `);
    this.stmtDeleteGuestCredentialsByUserId = this.db.prepare(`
      DELETE FROM guest_credentials WHERE user_id = ?
    `);

    // Sessions
    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, idle_expires_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindSession = this.db.prepare(`
      SELECT s.*, u.username, u.type, u.role, u.permissions_json, u.avatar, u.banned, u.ban_until, u.ban_reason, u.created_at as user_created_at
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ?
    `);
    this.stmtUpdateSessionTouch = this.db.prepare(`
      UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ?
    `);
    this.stmtDeleteSession = this.db.prepare(`
      DELETE FROM sessions WHERE token_hash = ?
    `);
    this.stmtDeleteUserSessions = this.db.prepare(`
      DELETE FROM sessions WHERE user_id = ?
    `);
    this.stmtCleanExpiredSessions = this.db.prepare(`
      DELETE FROM sessions WHERE expires_at <= ? OR idle_expires_at <= ?
    `);

    // Matches & Stats
    this.stmtFindMatchById = this.db.prepare(`
      SELECT * FROM matches WHERE id = ?
    `);
    this.stmtInsertMatch = this.db.prepare(`
      INSERT OR IGNORE INTO matches (id, started_at, ended_at, winner, reason, records_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.stmtInsertMatchPlayer = this.db.prepare(`
      INSERT INTO match_players (match_id, player_id, player_name, side)
      VALUES (?, ?, ?, ?)
    `);
    this.stmtMatchPlayers = this.db.prepare(`
      SELECT * FROM match_players WHERE match_id = ?
    `);
    this.stmtAllMatches = this.db.prepare(`
      SELECT * FROM matches ORDER BY ended_at ASC
    `);
    this.stmtUserGamesCount = this.db.prepare(`
      SELECT COUNT(*) as c FROM match_players WHERE player_id = ?
    `);
    this.stmtUserWinsCount = this.db.prepare(`
      SELECT COUNT(*) as c
      FROM match_players mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND mp.side = m.winner
    `);
    this.stmtUserDecisiveGamesCount = this.db.prepare(`
      SELECT COUNT(*) as c
      FROM match_players mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ? AND m.winner IN ('r', 'b')
    `);
    this.stmtUserRecentMatches = this.db.prepare(`
      SELECT mp.side, m.winner
      FROM match_players mp
      JOIN matches m ON mp.match_id = m.id
      WHERE mp.player_id = ?
      ORDER BY m.ended_at DESC, mp.id DESC
      LIMIT ?
    `);
    this.stmtAnonymizePlayer = this.db.prepare(`
      UPDATE match_players SET player_id = NULL, player_name = ? WHERE player_id = ?
    `);

    // Settings
    this.stmtGetSetting = this.db.prepare(`
      SELECT value FROM settings WHERE key = ?
    `);
    this.stmtSetSetting = this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
    `);

    // Audit logs
    this.stmtInsertAudit = this.db.prepare(`
      INSERT INTO audit_logs (actor_id, actor_name, target_id, action, details_json, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtListAuditLogs = this.db.prepare(`
      SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `);
    this.stmtCountAuditLogs = this.db.prepare(`
      SELECT COUNT(*) as c FROM audit_logs
    `);

    if (jsonToMigrate && fs.existsSync(jsonToMigrate)) {
      try {
        migrateFromJson(jsonToMigrate, this.db, { backup: true, force: false });
      } catch (err) {
        console.error('旧版 JSON 数据迁移警告:', err.message);
      }
    } else if ((filePath === defaultDbPath || filePath === defaultJsonPath) && fs.existsSync(defaultJsonPath) && dbPath !== ':memory:') {
      const userCount = this.stmtCountUsers.get().c;
      if (userCount === 0) {
        try {
          migrateFromJson(defaultJsonPath, this.db, { backup: true, force: false });
        } catch (err) {
          console.error('默认 users.json 迁移警告:', err.message);
        }
      }
    }
  }

  normalizeUserRow(row) {
    if (!row) return null;
    let perms = [];
    try {
      perms = JSON.parse(row.permissions_json || '[]');
    } catch {}
    if (!Array.isArray(perms)) perms = [];

    let user = this.userCache.get(row.id);
    if (!user) {
      user = {
        id: row.id,
        username: row.username,
        avatar: sanitizeAvatar(row.avatar),
        type: row.type,
        role: row.role,
        permissions: row.role === 'admin' ? (row.id === '10000001' ? [...ADMIN_PERMISSIONS] : perms) : [],
        banned: !!row.banned,
        banUntil: row.ban_until ?? null,
        banReason: row.ban_reason ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastLoginAt: row.last_login_at,
        passwordHash: row.password_hash ?? null,
        salt: row.salt ?? null,
        algoVersion: row.algo_version ?? null,
        costParams: row.cost_params_json ? JSON.parse(row.cost_params_json) : null
      };
      this.userCache.set(row.id, user);
    } else {
      user.username = row.username;
      user.avatar = sanitizeAvatar(row.avatar);
      user.type = row.type;
      user.role = row.role;
      user.permissions = row.role === 'admin' ? (row.id === '10000001' ? [...ADMIN_PERMISSIONS] : perms) : [];
      user.banned = !!row.banned;
      user.banUntil = row.ban_until ?? null;
      user.banReason = row.ban_reason ?? null;
      user.createdAt = row.created_at;
      user.updatedAt = row.updated_at;
      user.lastLoginAt = row.last_login_at;
      user.passwordHash = row.password_hash ?? null;
      user.salt = row.salt ?? null;
      user.algoVersion = row.algo_version ?? null;
      user.costParams = row.cost_params_json ? JSON.parse(row.cost_params_json) : null;
    }

    if (user.banned && user.banUntil && user.banUntil <= Date.now()) {
      user.banned = false;
      user.banUntil = null;
      user.banReason = null;
      this.stmtUpdateUserBan.run(0, null, null, Date.now(), user.id);
    }
    return user;
  }

  findUserById(id) {
    if (!id) return null;
    let user = this.userCache.get(String(id));
    if (!user) {
      const row = this.stmtFindUserById.get(String(id));
      if (!row) return null;
      user = this.normalizeUserRow(row);
    }
    if (user && user.banned && user.banUntil && user.banUntil <= Date.now()) {
      user.banned = false;
      user.banUntil = null;
      user.banReason = null;
      this.stmtUpdateUserBan.run(0, null, null, Date.now(), user.id);
    }
    return user;
  }

  findUserByUsername(username) {
    if (!username || typeof username !== 'string') return null;
    const row = this.stmtFindUserByUsername.get(username.trim());
    return this.normalizeUserRow(row);
  }

  generateNumericId() {
    let id;
    do {
      id = String(crypto.randomInt(10000000, 99999999));
    } while (this.stmtFindUserById.get(id));
    return id;
  }

  validateUsername(username) {
    if (typeof username !== 'string') throw new Error('用户名须为字符串。');
    const clean = username.trim();
    if (clean.length < 2 || clean.length > 16) {
      throw new Error('用户名长度须为 2 到 16 个字符。');
    }
    return clean;
  }

  validatePassword(password) {
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      throw new Error('密码长度须为 6 到 128 位。');
    }
  }

  initAdmin({ force = false } = {}) {
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminAvatar = AVATARS.includes(process.env.ADMIN_AVATAR) ? process.env.ADMIN_AVATAR : '帥';

    if (process.env.NODE_ENV === 'production' && (adminPassword === 'admin123' || !adminPassword)) {
      throw new Error('生产环境下禁止使用默认管理员密码（admin123），请在环境变量中显式配置高强度 ADMIN_PASSWORD。');
    }

    let existingAdmin = this.findUserById('10000001');
    if (!existingAdmin) {
      const byName = this.findUserByUsername(adminUsername);
      if (byName && byName.role === 'admin') existingAdmin = byName;
    }

    if (existingAdmin && !force) {
      return existingAdmin;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPasswordSync(adminPassword, salt, DEFAULT_COST);
    const now = Date.now();

    this.db.exec('BEGIN TRANSACTION');
    try {
      if (existingAdmin) {
        this.stmtUpdateUserProfile.run(adminUsername, adminAvatar, now, existingAdmin.id);
        this.stmtInsertOrReplaceCredential.run(existingAdmin.id, hash, salt, 'scrypt_v1', JSON.stringify(DEFAULT_COST), now);
      } else {
        this.stmtInsertUser.run(
          '10000001',
          adminUsername,
          'registered',
          'admin',
          JSON.stringify(ADMIN_PERMISSIONS),
          adminAvatar,
          0,
          null,
          null,
          now,
          now,
          now
        );
        this.stmtInsertOrReplaceCredential.run('10000001', hash, salt, 'scrypt_v1', JSON.stringify(DEFAULT_COST), now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.findUserById(existingAdmin?.id || '10000001');
  }

  seedAdmin() {
    return this.initAdmin({ force: false });
  }

  syncAdminFromEnv(envPath = this.envPath || path.join(root, '.env'), { force = true } = {}) {
    if (fs.existsSync(envPath)) {
      try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const k = trimmed.slice(0, eq).trim();
            const v = trimmed.slice(eq + 1).trim();
            process.env[k] = v;
          }
        }
      } catch {}
    }
    return this.initAdmin({ force });
  }

  register({ username, password, avatar = '弈' }) {
    const cleanName = this.validateUsername(username);
    if (this.findUserByUsername(cleanName)) {
      throw new Error('该用户名已被占用，请换一个。');
    }
    this.validatePassword(password);
    const chosenAvatar = sanitizeAvatar(avatar);

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPasswordSync(password, salt, DEFAULT_COST);
    const id = this.generateNumericId();
    const now = Date.now();

    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtInsertUser.run(id, cleanName, 'registered', 'player', '[]', chosenAvatar, 0, null, null, now, now, now);
      this.stmtInsertOrReplaceCredential.run(id, hash, salt, 'scrypt_v1', JSON.stringify(DEFAULT_COST), now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.findUserById(id);
  }

  login({ username, password }) {
    if (!username || !password) {
      throw new Error('用户名或密码错误。');
    }
    const user = this.findUserByUsername(username);
    if (!user || user.type !== 'registered' || !user.passwordHash || !user.salt) {
      throw new Error('用户名或密码错误。');
    }
    const valid = verifyPasswordSync(password, user.salt, user.passwordHash, user.costParams || DEFAULT_COST);
    if (!valid) {
      throw new Error('用户名或密码错误。');
    }
    if (user.banned) {
      const untilStr = user.banUntil ? ('至 ' + new Date(user.banUntil).toLocaleString('zh-CN', { hour12: false })) : '（永久封禁）';
      throw new Error('该账号已被封禁' + (user.banUntil ? untilStr : '') + '：' + (user.banReason || '违规操作') + (!user.banUntil ? '（永久封禁）' : ''));
    }
    const now = Date.now();
    this.stmtUpdateUserLogin.run(now, user.id);
    user.lastLoginAt = now;
    return user;
  }

  getOrCreateGuest(tokenOrDevice = null) {
    if (tokenOrDevice && typeof tokenOrDevice === 'string' && tokenOrDevice.startsWith('ip:')) {
      tokenOrDevice = null;
    }
    let lookupHash = null;
    if (tokenOrDevice && typeof tokenOrDevice === 'string' && tokenOrDevice.trim()) {
      lookupHash = crypto.createHash('sha256').update(tokenOrDevice.trim()).digest('hex');
      const existing = this.stmtFindGuestCredential.get(lookupHash);
      if (existing) {
        const user = this.findUserById(existing.user_id);
        if (user) {
          if (user.banned) {
            const untilStr = user.banUntil ? ('至 ' + new Date(user.banUntil).toLocaleString('zh-CN', { hour12: false })) : '（永久封禁）';
            throw new Error('该游客账号已被封禁' + (user.banUntil ? untilStr : '') + '：' + (user.banReason || '违规操作') + (!user.banUntil ? '（永久封禁）' : ''));
          }
          const now = Date.now();
          this.stmtUpdateGuestCredential.run(now, lookupHash);
          this.stmtUpdateUserLogin.run(now, user.id);
          user.lastLoginAt = now;
          user.guestToken = tokenOrDevice;
          return user;
        }
      }
    }

    const guestToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(guestToken).digest('hex');
    const buf = crypto.createHash('sha256').update(guestToken).digest();
    const prefix = prefixes[buf.readUInt16BE(0) % prefixes.length];
    const word = guestWords[buf.readUInt16BE(2) % guestWords.length];
    const num = (buf.readUInt16BE(4) % 9000) + 1000;
    const name = `${prefix}${word}·${num}`;
    const avatar = AVATARS[buf.readUInt16BE(6) % AVATARS.length];
    const preferredId = String(10000000 + (buf.readUInt32BE(8) % 90000000));
    const id = this.stmtFindUserById.get(preferredId) ? this.generateNumericId() : preferredId;

    const now = Date.now();
    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtInsertUser.run(id, name, 'guest', 'player', '[]', avatar, 0, null, null, now, now, now);
      this.stmtInsertGuestCredential.run(tokenHash, id, now, now);
      if (lookupHash && lookupHash !== tokenHash) {
        this.stmtInsertGuestCredential.run(lookupHash, id, now, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const user = this.findUserById(id);
    user.guestToken = guestToken;
    return user;
  }

  upgradeGuest(userId, { username, password, avatar = null }) {
    const user = this.findUserById(userId);
    if (!user || user.type !== 'guest') {
      throw new Error('仅游客账号可升级为正式注册账号。');
    }
    const cleanName = this.validateUsername(username);
    const existing = this.findUserByUsername(cleanName);
    if (existing && existing.id !== user.id) {
      throw new Error('该用户名已被占用，请换一个。');
    }
    this.validatePassword(password);
    const chosenAvatar = avatar ? sanitizeAvatar(avatar) : user.avatar;

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPasswordSync(password, salt, DEFAULT_COST);
    const now = Date.now();

    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtUpdateUserProfile.run(cleanName, chosenAvatar, now, user.id);
      this.stmtInsertOrReplaceCredential.run(user.id, hash, salt, 'scrypt_v1', JSON.stringify(DEFAULT_COST), now);
      this.db.prepare("UPDATE users SET type = 'registered' WHERE id = ?").run(user.id);
      this.stmtDeleteGuestCredentialsByUserId.run(user.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    this.logAudit({
      actorId: user.id,
      actorName: cleanName,
      targetId: user.id,
      action: 'guest_upgraded',
      details: { fromUsername: user.username, toUsername: cleanName }
    });

    return this.findUserById(user.id);
  }

  updateProfile(userId, { username, avatar }) {
    const user = this.findUserById(userId);
    if (!user) throw new Error('用户不存在。');
    if (user.type === 'guest') {
      throw new Error('游客账号由系统自动生成，不可自定义资料。请注册正式账号。');
    }
    let newName = user.username;
    let newAvatar = user.avatar;

    if (username !== undefined) {
      newName = this.validateUsername(username);
      if (newName.toLowerCase() !== user.username.toLowerCase()) {
        const existing = this.findUserByUsername(newName);
        if (existing && existing.id !== user.id) {
          throw new Error('该用户名已被占用。');
        }
      }
    }

    if (avatar !== undefined) {
      if (!isValidAvatar(avatar)) {
        throw new Error('请选择有效的头像或上传图片（支持 PNG/JPEG/WEBP，200KB以内）。');
      }
      newAvatar = avatar;
    }

    const now = Date.now();
    this.stmtUpdateUserProfile.run(newName, newAvatar, now, user.id);
    user.username = newName;
    user.avatar = newAvatar;
    user.updatedAt = now;
    return this.findUserById(user.id);
  }

  setBan(userId, banned, reason = '', durationMinutes = 0, actor = null, ip = null) {
    if (typeof banned !== 'boolean' || typeof reason !== 'string' || reason.length > 200 || !Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > 525600) {
      throw new Error('封禁参数无效（最长一年，0 表示永久）。');
    }
    const user = this.findUserById(userId);
    if (!user) throw new Error('目标用户不存在。');
    if (user.role === 'admin') {
      throw new Error('无法封禁管理员账号。');
    }

    const now = Date.now();
    const banUntil = banned && durationMinutes > 0 ? now + durationMinutes * 60000 : null;
    const banReason = banned ? (reason.trim() || '违反游戏规范') : null;

    this.stmtUpdateUserBan.run(banned ? 1 : 0, banUntil, banReason, now, user.id);
    user.banned = !!banned;
    user.banUntil = banUntil;
    user.banReason = banReason;
    user.updatedAt = now;


    this.logAudit({
      actorId: actor?.id ?? 'system',
      actorName: actor?.username ?? '系统',
      targetId: user.id,
      action: banned ? 'ban_user' : 'unban_user',
      details: { reason: banReason, durationMinutes, banUntil },
      ip
    });

    return this.findUserById(user.id);
  }

  verifyAdminPassword(adminId, password) {
    if (!password || typeof password !== 'string') return false;
    const admin = this.findUserById(adminId);
    if (!admin || !admin.passwordHash || !admin.salt) return false;
    return verifyPasswordSync(password, admin.salt, admin.passwordHash, admin.costParams || DEFAULT_COST);
  }

  manage(actor, data, ip = null) {
    const { action, userId } = data;
    const allowed = permissions(actor);
    if (!allowed.includes('users')) throw new Error('没有账号管理权限。');

    if (action === 'create') {
      if (data.type === 'guest') {
        throw new Error('后台无法为未连接的客户端生成游客凭据，请由玩家在客户端以游客模式进入。');
      }
      if (data.type !== 'registered') throw new Error('账号类型无效。');
      const user = this.register({
        username: data.username,
        password: data.password,
        avatar: data.avatar || '弈'
      }, { byAdmin: true });
      this.logAudit({
        actorId: actor.id,
        actorName: actor.username,
        targetId: user.id,
        action: 'account_create',
        details: { username: user.username, role: user.role, type: user.type },
        ip
      });
      return user;
    }

    const user = this.findUserById(userId);
    if (!user) throw new Error('目标用户不存在。');
    if (user.id === '10000001' || user.id === actor.id) {
      throw new Error('不能在此修改主管理员或自己的账号。');
    }
    if (user.role === 'admin' && actor.id !== '10000001') {
      throw new Error('仅主管理员可以修改其他管理员。');
    }

    const isSensitive = ['delete', 'password', 'clearRecords'].includes(action) ||
      (action === 'update' && (data.role === 'admin' || (Array.isArray(data.permissions) && data.permissions.length > 0)));

    if (isSensitive && data.requireReauth) {
      if (!data.adminPassword) {
        throw new Error('执行敏感管理操作需要验证当前管理员密码。');
      }
      const verified = this.verifyAdminPassword(actor.id, data.adminPassword);
      if (!verified) throw new Error('管理员密码认证失败。');
    }

    if (action === 'update') {
      if (data.type === 'guest' && user.type === 'registered') {
        throw new Error('不支持将注册账号降级为游客账号，这会导致账号失去登录凭据。');
      }
      if (!['guest', 'registered'].includes(data.type) || !['player', 'admin'].includes(data.role)) {
        throw new Error('账号类型或角色无效。');
      }
      const requestedPerms = Array.isArray(data.permissions) ? data.permissions : [];
      if (requestedPerms.some(p => !ADMIN_PERMISSIONS.includes(p) || !allowed.includes(p))) {
        throw new Error('不能授予超出自身范围的权限。');
      }
      if (data.role === 'admin' && actor.id !== '10000001') {
        throw new Error('仅主管理员可以授予管理员角色。');
      }
      if (data.role === 'admin' && user.banned) {
        throw new Error('请先解除封禁再授予管理员角色。');
      }
      if (data.role === 'admin' && data.type !== 'registered') {
        throw new Error('管理员必须是注册账号。');
      }
      if (data.type === 'registered' && !user.passwordHash && !data.password) {
        throw new Error('游客转注册账号时必须设置密码。');
      }
      const name = typeof data.username === 'string' ? data.username.trim() : '';
      this.validateUsername(name);
      const existing = this.findUserByUsername(name);
      if (existing && existing.id !== user.id) throw new Error('用户名已被占用。');

      const roleChanged = user.role !== data.role;
      const permissionsChanged = JSON.stringify(permissions(user).sort()) !== JSON.stringify(requestedPerms.slice().sort());

      this.db.exec('BEGIN TRANSACTION');
      try {
        if (data.password) {
          this.validatePassword(data.password);
          const salt = crypto.randomBytes(16).toString('hex');
          const hash = hashPasswordSync(data.password, salt, DEFAULT_COST);
          const now = Date.now();
      this.stmtInsertOrReplaceCredential.run(user.id, hash, salt, 'scrypt_v1', JSON.stringify(DEFAULT_COST), now);
      user.salt = salt;
      user.passwordHash = hash;
      user.updatedAt = now;
        }
        if (data.type === 'registered') {
          this.stmtDeleteGuestCredentialsByUserId.run(user.id);
        }
        const newPermsJson = data.role === 'admin' ? JSON.stringify(requestedPerms) : '[]';
        const now = Date.now();
        this.stmtUpdateUserFull.run(
          name,
          data.type,
          data.role,
          newPermsJson,
          now,
          user.id
        );
        user.username = name;
        user.type = data.type;
        user.role = data.role;
        user.permissions = data.role === 'admin' ? [...requestedPerms] : [];
        user.updatedAt = now;
        this.logAudit({
          actorId: actor.id,
          actorName: actor.username,
          targetId: user.id,
          action: 'account_update',
          details: {
            username: name,
            type: data.type,
            role: data.role,
            permissions: requestedPerms,
            passwordChanged: !!data.password
          },
          ip
        });
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }

      if (roleChanged || permissionsChanged || data.password) {
        this.revokeUserSessions(user.id);
      }
      return this.findUserById(user.id);
    } else if (action === 'password') {
      if (user.type !== 'registered') throw new Error('游客无密码，请先转换为注册账号。');
      this.validatePassword(data.password);
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPasswordSync(data.password, salt, DEFAULT_COST);
      this.stmtInsertOrReplaceCredential.run(user.id, hash, salt, 'scrypt_v1', JSON.stringify(DEFAULT_COST), Date.now());
      this.revokeUserSessions(user.id);
      this.logAudit({
        actorId: actor.id,
        actorName: actor.username,
        targetId: user.id,
        action: 'account_reset_password',
        details: { username: user.username },
        ip
      });
      return this.findUserById(user.id);
    } else if (action === 'clearRecords') {
      this.db.exec('BEGIN TRANSACTION');
      try {
        this.stmtAnonymizePlayer.run('已清除玩家', user.id);
        this.logAudit({
          actorId: actor.id,
          actorName: actor.username,
          targetId: user.id,
          action: 'account_clear_records',
          details: { username: user.username },
          ip
        });
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      return this.findUserById(user.id);
    } else if (action === 'delete') {
      if (user.role === 'admin') {
        const adminCount = this.stmtCountActiveAdmins.get().c;
        if (adminCount <= 1) {
          throw new Error('无法删除系统中最后一个管理员账号。');
        }
      }
      this.db.exec('BEGIN TRANSACTION');
      try {
        this.stmtAnonymizePlayer.run('已删除玩家', user.id);
        this.stmtDeleteUser.run(user.id);
      this.userCache.delete(user.id);
        this.logAudit({
          actorId: actor.id,
          actorName: actor.username,
          targetId: user.id,
          action: 'account_delete',
          details: { username: user.username, role: user.role },
          ip
        });
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      this.revokeUserSessions(user.id);
      return null;
    } else {
      throw new Error('未知管理操作。');
    }
  }

  deleteOwnAccount(userId, password, ip = null) {
    const user = this.findUserById(userId);
    if (!user || user.type !== 'registered') {
      throw new Error('用户不存在或不可注销。');
    }
    if (user.id === '10000001') {
      throw new Error('系统主管理员账号不可注销。');
    }
    if (user.role === 'admin') {
      const adminCount = this.stmtCountActiveAdmins.get().c;
      if (adminCount <= 1) {
        throw new Error('无法注销系统中最后一个管理员账号。');
      }
    }
    const valid = verifyPasswordSync(password, user.salt, user.passwordHash, user.costParams || DEFAULT_COST);
    if (!valid) {
      throw new Error('密码错误，账号注销已取消。');
    }

    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtAnonymizePlayer.run('已注销玩家', user.id);
      this.stmtDeleteUser.run(user.id);
      this.userCache.delete(user.id);
      this.logAudit({
        actorId: user.id,
        actorName: user.username,
        targetId: user.id,
        action: 'account_self_delete',
        details: { username: user.username },
        ip
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.revokeUserSessions(user.id);
    return { ok: true };
  }

  exportUserData(userId) {
    const user = this.findUserById(userId);
    if (!user) throw new Error('用户不存在。');
    const userStats = this.stats(userId);

    const matchRows = this.db.prepare(`
      SELECT m.id, m.started_at, m.ended_at, m.winner, m.reason, m.records_json,
             mp.side,
             opp.player_name as opponent_name,
             opp.side as opponent_side
      FROM match_players mp
      JOIN matches m ON mp.match_id = m.id
      LEFT JOIN match_players opp ON opp.match_id = m.id AND (opp.player_id != mp.player_id OR opp.player_id IS NULL)
      WHERE mp.player_id = ?
      ORDER BY m.ended_at DESC
    `).all(userId);

    const matches = matchRows.map(r => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      winner: r.winner,
      result: r.winner === r.side ? 'win' : (r.winner ? 'loss' : 'draw'),
      reason: r.reason,
      mySide: r.side,
      opponent: r.opponent_name || '已匿名棋友',
      movesCount: (JSON.parse(r.records_json || '[]')).length
    }));

    return {
      exportedAt: Date.now(),
      profile: publicUser(user),
      stats: userStats,
      matches
    };
  }

  createSession(userId, { ip = null, userAgent = null } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 3600 * 1000;
    const idleExpiresAt = now + 7 * 24 * 3600 * 1000;

    this.stmtInsertSession.run(
      tokenHash,
      String(userId),
      csrfToken,
      now,
      now,
      expiresAt,
      idleExpiresAt,
      ip ?? null,
      userAgent ?? null
    );

    const user = this.findUserById(userId);
    return {
      token,
      tokenHash,
      csrfToken,
      expiresAt,
      idleExpiresAt,
      user
    };
  }

  verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = this.stmtFindSession.get(tokenHash);
    if (!row) return null;

    const now = Date.now();
    if (now > row.expires_at || now > row.idle_expires_at) {
      this.stmtDeleteSession.run(tokenHash);
      return null;
    }

    const user = this.findUserById(row.user_id);
    if (!user) {
      this.stmtDeleteSession.run(tokenHash);
      return null;
    }

    const newIdleExpires = now + 7 * 24 * 3600 * 1000;
    this.stmtUpdateSessionTouch.run(now, newIdleExpires, tokenHash);

    return {
      session: {
        tokenHash,
        userId: row.user_id,
        csrfToken: row.csrf_token,
        createdAt: row.created_at,
        lastSeenAt: now,
        expiresAt: row.expires_at,
        idleExpiresAt: newIdleExpires
      },
      csrfToken: row.csrf_token,
      user,
      banned: !!user.banned
    };
  }

  deleteSession(token) {
    if (!token || typeof token !== 'string') return;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    this.stmtDeleteSession.run(tokenHash);
  }

  revokeUserSessions(userId) {
    if (!userId) return;
    this.stmtDeleteUserSessions.run(String(userId));
    if (this.onRevoke) {
      try { this.onRevoke(String(userId)); } catch {}
    }
  }

  cleanExpiredSessions() {
    const now = Date.now();
    this.stmtCleanExpiredSessions.run(now, now);
  }

  recordGame(game) {
    if (!game || !game.id) return;
    const existing = this.stmtFindMatchById.get(game.id);
    if (existing) return;

    const now = Date.now();
    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtInsertMatch.run(
        game.id,
        game.startedAt ?? null,
        game.endedAt || now,
        game.winner ?? null,
        game.reason ?? null,
        JSON.stringify(game.records || [])
      );
      if (Array.isArray(game.players)) {
        for (const p of game.players) {
          this.stmtInsertMatchPlayer.run(game.id, p.id ?? null, p.name || '未知棋友', p.side || 'r');
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  stats(id) {
    const gamesCount = this.stmtUserGamesCount.get(String(id))?.c || 0;
    const winsCount = this.stmtUserWinsCount.get(String(id))?.c || 0;
    const decisiveCount = this.stmtUserDecisiveGamesCount.get(String(id))?.c || 0;
    const recentRows = this.stmtUserRecentMatches.all(String(id), 20);
    const recentGames = recentRows.length;
    const recentWins = recentRows.filter(r => r.side === r.winner).length;
    const recentDecisive = recentRows.filter(r => r.winner === 'r' || r.winner === 'b').length;

    return {
      games: gamesCount,
      wins: winsCount,
      winRate: decisiveCount > 0 ? winsCount / decisiveCount : null,
      recentGames,
      recentWinRate: recentDecisive > 0 ? recentWins / recentDecisive : null
    };
  }

  getAllMatches() {
    const matches = this.stmtAllMatches.all();
    return matches.map(m => {
      const players = this.stmtMatchPlayers.all(m.id).map(p => ({
        id: p.player_id,
        name: p.player_name,
        side: p.side
      }));
      return {
        id: m.id,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        winner: m.winner,
        reason: m.reason,
        records: JSON.parse(m.records_json || '[]'),
        players
      };
    });
  }

  listMatchesPaged({ userId = null, offset = 0, limit = 50 } = {}) {
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.min(100, Math.max(1, Number(limit) || 50));

    let rows, total;
    if (userId) {
      total = this.db.prepare(`
        SELECT COUNT(DISTINCT m.id) as c
        FROM matches m
        JOIN match_players mp ON m.id = mp.match_id
        WHERE mp.player_id = ?
      `).get(String(userId))?.c || 0;

      rows = this.db.prepare(`
        SELECT DISTINCT m.*
        FROM matches m
        JOIN match_players mp ON m.id = mp.match_id
        WHERE mp.player_id = ?
        ORDER BY m.ended_at DESC
        LIMIT ? OFFSET ?
      `).all(String(userId), limit, offset);
    } else {
      total = this.db.prepare("SELECT COUNT(*) as c FROM matches").get()?.c || 0;
      rows = this.db.prepare("SELECT * FROM matches ORDER BY ended_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    }

    const records = rows.map(m => {
      const players = this.stmtMatchPlayers.all(m.id).map(p => ({
        id: p.player_id,
        name: p.player_name,
        side: p.side
      }));
      return {
        id: m.id,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        winner: m.winner,
        reason: m.reason,
        records: JSON.parse(m.records_json || '[]'),
        players
      };
    });

    return { records, total };
  }

  listUsers() {
    const rows = this.stmtAllUsers.all();
    return rows.map(r => {
      const u = this.normalizeUserRow(r);
      return {
        ...publicUser(u),
        stats: this.stats(u.id)
      };
    });
  }

  listUsersPaged({ query = '', filter = 'all', offset = 0, limit = 100 } = {}) {
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.min(200, Math.max(1, Number(limit) || 100));
    const cleanQuery = (query || '').trim();

    let sqlWhere = [];
    let params = [];

    if (cleanQuery) {
      sqlWhere.push('(username LIKE ? OR id LIKE ?)');
      params.push(`%${cleanQuery}%`, `%${cleanQuery}%`);
    }

    if (filter === 'registered') {
      sqlWhere.push("type = 'registered'");
    } else if (filter === 'guest') {
      sqlWhere.push("type = 'guest'");
    } else if (filter === 'admin') {
      sqlWhere.push("role = 'admin'");
    } else if (filter === 'banned') {
      sqlWhere.push("banned = 1");
    }

    const whereClause = sqlWhere.length ? `WHERE ${sqlWhere.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) as c FROM users ${whereClause}`).get(...params)?.c || 0;

    const rows = this.db.prepare(`
      SELECT * FROM users
      ${whereClause}
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const users = rows.map(r => {
      const u = this.normalizeUserRow(r);
      return {
        ...publicUser(u),
        stats: this.stats(u.id)
      };
    });

    return { users, total };
  }

  logAudit({ actorId, actorName, targetId, action, details = null, ip = null }) {
    try {
      this.stmtInsertAudit.run(
        actorId ?? null,
        actorName || '系统',
        targetId ?? null,
        action,
        details ? JSON.stringify(details) : null,
        ip ?? null,
        Date.now()
      );
    } catch (e) {
      console.error('记录审计日志失败:', e.message);
    }
  }

  listAuditLogs({ limit = 50, offset = 0 } = {}) {
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.min(100, Math.max(1, Number(limit) || 50));
    const total = this.stmtCountAuditLogs.get()?.c || 0;
    const rows = this.stmtListAuditLogs.all(limit, offset);
    const logs = rows.map(r => ({
      id: r.id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      targetId: r.target_id,
      action: r.action,
      details: r.details_json ? JSON.parse(r.details_json) : null,
      ip: r.ip,
      createdAt: r.created_at
    }));
    return { logs, total };
  }

  updateSettings(data, actor = null, ip = null) {
    if (typeof data.registrationOpen !== 'boolean' || !Number.isInteger(data.maxRooms) || data.maxRooms < 1 || data.maxRooms > 100) {
      throw new Error('房间上限须为 1–100 的整数，注册开关须为布尔值。');
    }
    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtSetSetting.run('registration_open', data.registrationOpen ? 'true' : 'false');
      this.stmtSetSetting.run('max_rooms', String(data.maxRooms));
      if (actor) {
        this.logAudit({
          actorId: actor.id,
          actorName: actor.username,
          targetId: 'server_settings',
          action: 'settings_update',
          details: { registrationOpen: data.registrationOpen, maxRooms: data.maxRooms },
          ip
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.settings;
  }

  get settings() {
    const regRow = this.stmtGetSetting.get('registration_open');
    const maxRow = this.stmtGetSetting.get('max_rooms');
    return {
      registrationOpen: regRow ? regRow.value === 'true' : true,
      maxRooms: maxRow ? Number(maxRow.value) || 5 : 5
    };
  }

  set settings(val) {
    if (val) this.updateSettings(val);
  }

  get users() {
    const self = this;
    return {
      get size() {
        return self.stmtCountUsers.get()?.c || 0;
      },
      get(id) {
        return self.findUserById(id);
      },
      has(id) {
        return !!self.stmtFindUserById.get(String(id));
      },
      values() {
        const list = self.stmtAllUsers.all().map(r => self.normalizeUserRow(r));
        return list[Symbol.iterator]();
      },
      keys() {
        const list = self.db.prepare('SELECT id FROM users ORDER BY created_at ASC').all().map(r => r.id);
        return list[Symbol.iterator]();
      },
      [Symbol.iterator]() {
        return this.values();
      },
      delete(id) {
        self.stmtDeleteUser.run(String(id));
      },
      set(id, user) {
        // Compatibility
      }
    };
  }

  get matches() {
    return this.getAllMatches();
  }

  save() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {}
  }

  close() {
    try {
      UserStore.openStores.delete(this);
      this.db.close();
    } catch {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const store = new UserStore();
  if (arg === '--init-admin') {
    store.initAdmin({ force: false });
    console.log('管理员账号初始化完成（ID: 10000001）。');
  } else if (arg === '--reset-admin') {
    store.initAdmin({ force: true });
    console.log('管理员凭据已重置为当前环境或 .env 配置（ID: 10000001）。');
  } else if (arg === '--migrate') {
    const res = migrateFromJson(defaultJsonPath, store.db, { force: true });
    console.log(`迁移完成：导入 ${res.userCount} 个账号，${res.matchCount} 局对战。`);
  } else {
    console.log('用法: node users.js [--init-admin | --reset-admin | --migrate]');
  }
}
