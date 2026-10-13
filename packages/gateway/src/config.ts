import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface GatewayConfig {
  /** Gateway 仅监听回环（设计文档 D8 / NET-1） */
  host: string;
  port: number;
  /** Bridge 通道端口（仅回环） */
  bridgePort: number;
  /** 静态托管的 web 构建产物目录 */
  webDist: string;
  /** pi 可执行文件路径 */
  piPath: string;
  /** 工作区白名单（WS-1）；空 = 仅数据目录下登记的最近工作区 */
  workspaces: string[];
  /** 设备数量上限（WS-6） */
  maxDevices: number;
  /** Host 模式下是否给 pi 进程加载 Bridge 扩展（-e） */
  hostLoadBridge: boolean;
  dataDir: string;
  /** 事件环形缓冲：条数与字节上限（§4.4） */
  ringMaxEvents: number;
  ringMaxBytes: number;
  /** access/refresh 令牌有效期（秒） */
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /** VAPID 推送密钥（可选；未配置则禁用推送） */
  vapidSubject?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
}

const DEFAULTS: Omit<GatewayConfig, "dataDir" | "webDist" | "piPath"> = {
  host: "127.0.0.1",
  port: 7788,
  bridgePort: 7789,
  workspaces: [],
  maxDevices: 5,
  hostLoadBridge: true,
  ringMaxEvents: 5000,
  ringMaxBytes: 10 * 1024 * 1024,
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 30 * 24 * 3600,
};

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const dataDir = process.env.PILINK_DATA_DIR ?? join(homedir(), ".pilink");
  mkdirSync(dataDir, { recursive: true });
  const cfgPath = join(dataDir, "config.json");
  let fileCfg: Partial<GatewayConfig> = {};
  if (existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch {
      console.warn(`[pilink] 无法解析 ${cfgPath}，使用默认配置`);
    }
  }
  const cfg: GatewayConfig = {
    ...DEFAULTS,
    ...fileCfg,
    ...overrides,
    dataDir,
    webDist: overrides.webDist ?? fileCfg.webDist ?? join(dataDir, "web"),
    piPath: overrides.piPath ?? fileCfg.piPath ?? process.env.PILINK_PI_PATH ?? "pi",
  };
  return cfg;
}

/** Gateway 签名密钥（JWT HS256 + 配对码 HMAC），仅存本机。 */
export function loadOrCreateSecret(dataDir: string): Buffer {
  const p = join(dataDir, "secret");
  if (existsSync(p)) return readFileSync(p);
  const secret = randomBytes(32);
  writeFileSync(p, secret, { mode: 0o600 });
  chmodSync(p, 0o600);
  return secret;
}
