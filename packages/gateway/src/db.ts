/**
 * Gateway 持久化（设计文档 §10.2）。
 * 使用 Node 内置 node:sqlite（Node ≥ 22.5/24 稳定），避免原生依赖。
 * 存储设备、refresh 令牌、推送订阅、审计日志、最近工作区；不复制 Pi 的会话数据。
 */
// 注意：用动态拼接防止打包器把 node: 前缀改写掉
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { join } from "node:path";

// 注意： specifier 动态拼接，防止打包器把 node: 前缀改写掉
const builtin = "sq" + "lite";
const { DatabaseSync } = (await import(`node:${builtin}`)) as {
  DatabaseSync: typeof DatabaseSyncT;
};

type Db = DatabaseSyncT;

export interface DeviceRow {
  deviceId: string;
  name: string;
  publicKey: string; // base64url SPKI (ECDSA P-256)
  pairedAt: number;
  lastSeenAt: number;
  lastIp?: string;
  revokedAt?: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  deviceId: string | null;
  workspaceId: string | null;
  action: string;
  detail: string | null;
}

export class Store {
  readonly db: Db;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, "pilink.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        deviceId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        pairedAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL,
        lastIp TEXT,
        revokedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        tokenId TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        revokedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        deviceId TEXT NOT NULL,
        endpoint TEXT PRIMARY KEY,
        keysJson TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        deviceId TEXT,
        workspaceId TEXT,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS recent_workspaces (
        workspaceId TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        lastUsedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /* kv（通用键值：workspace 别名等跨设备同步的小数据） */
  getKv(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setKv(key: string, value: string): void {
    this.db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /* devices */
  insertDevice(d: DeviceRow): void {
    this.db
      .prepare(
        `INSERT INTO devices (deviceId, name, publicKey, pairedAt, lastSeenAt, lastIp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(d.deviceId, d.name, d.publicKey, d.pairedAt, d.lastSeenAt, d.lastIp ?? null);
  }
  getDevice(deviceId: string): DeviceRow | undefined {
    return this.db.prepare(`SELECT * FROM devices WHERE deviceId = ?`).get(deviceId) as DeviceRow | undefined;
  }
  listDevices(): DeviceRow[] {
    return this.db.prepare(`SELECT * FROM devices ORDER BY pairedAt DESC`).all() as unknown as DeviceRow[];
  }
  countActiveDevices(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM devices WHERE revokedAt IS NULL`).get() as { c: number }).c;
  }
  touchDevice(deviceId: string, ip?: string): void {
    this.db
      .prepare(`UPDATE devices SET lastSeenAt = ?, lastIp = COALESCE(?, lastIp) WHERE deviceId = ?`)
      .run(Date.now(), ip ?? null, deviceId);
  }
  revokeDevice(deviceId: string): void {
    this.db.prepare(`UPDATE devices SET revokedAt = ? WHERE deviceId = ?`).run(Date.now(), deviceId);
    this.db.prepare(`UPDATE refresh_tokens SET revokedAt = ? WHERE deviceId = ?`).run(Date.now(), deviceId);
    this.db.prepare(`DELETE FROM push_subscriptions WHERE deviceId = ?`).run(deviceId);
  }

  /* refresh tokens */
  insertRefreshToken(tokenId: string, deviceId: string, expiresAt: number): void {
    this.db
      .prepare(`INSERT INTO refresh_tokens (tokenId, deviceId, expiresAt) VALUES (?, ?, ?)`)
      .run(tokenId, deviceId, expiresAt);
  }
  getRefreshToken(tokenId: string):
    | { tokenId: string; deviceId: string; expiresAt: number; revokedAt?: number }
    | undefined {
    return this.db.prepare(`SELECT * FROM refresh_tokens WHERE tokenId = ?`).get(tokenId) as
      | { tokenId: string; deviceId: string; expiresAt: number; revokedAt?: number }
      | undefined;
  }
  revokeRefreshToken(tokenId: string): void {
    this.db.prepare(`UPDATE refresh_tokens SET revokedAt = ? WHERE tokenId = ?`).run(Date.now(), tokenId);
  }

  /* push subscriptions */
  savePushSubscription(deviceId: string, endpoint: string, keys: unknown): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (deviceId, endpoint, keysJson) VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET deviceId = excluded.deviceId, keysJson = excluded.keysJson`,
      )
      .run(deviceId, endpoint, JSON.stringify(keys));
  }
  listPushSubscriptions(deviceId?: string): { deviceId: string; endpoint: string; keysJson: string }[] {
    if (deviceId)
      return this.db.prepare(`SELECT * FROM push_subscriptions WHERE deviceId = ?`).all(deviceId) as never;
    return this.db.prepare(`SELECT * FROM push_subscriptions`).all() as never;
  }

  /* audit（SEC-3：不记录提示词/输出正文） */
  audit(deviceId: string | null, workspaceId: string | null, action: string, detail?: unknown): void {
    const text = detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail);
    this.db
      .prepare(`INSERT INTO audit_log (ts, deviceId, workspaceId, action, detail) VALUES (?, ?, ?, ?, ?)`)
      .run(Date.now(), deviceId, workspaceId, action, text ? redactSecrets(text) : null);
  }
  recentAudit(limit = 200): AuditRow[] {
    return this.db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit) as unknown as AuditRow[];
  }

  /* recent workspaces */
  touchWorkspace(workspaceId: string, cwd: string): void {
    this.db
      .prepare(
        `INSERT INTO recent_workspaces (workspaceId, cwd, lastUsedAt) VALUES (?, ?, ?)
         ON CONFLICT(workspaceId) DO UPDATE SET lastUsedAt = excluded.lastUsedAt`,
      )
      .run(workspaceId, cwd, Date.now());
  }
  listRecentWorkspaces(): { workspaceId: string; cwd: string; lastUsedAt: number }[] {
    return this.db.prepare(`SELECT * FROM recent_workspaces ORDER BY lastUsedAt DESC`).all() as never;
  }
}

/** SEC-6：日志脱敏 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(api[_-]?key"?\s*[:=]\s*"?)[A-Za-z0-9_\-]{6,}/gi, "$1***")
    .replace(/(token"?\s*[:=]\s*")[^"]+(")/gi, "$1***$2");
}
