/**
 * 设备配对与认证（设计文档 §11.4 / SEC-1，D11）。
 * - 配对：一次性码（5 分钟有效）+ WebCrypto ECDSA P-256 设备公钥
 * - 登录：服务端挑战 → 设备签名 → 短期 JWT + 轮换 refresh（设备绑定）
 * - 不使用 WebAuthn/Passkey（RP ID 不能是 IP 地址）
 */
import { createHash, createHmac, timingSafeEqual, randomBytes, randomUUID, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { Store, DeviceRow } from "../db.js";

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}
function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj)));
}

export interface JwtPayload {
  sub: string; // deviceId
  typ: "access" | "refresh-jwt";
  exp: number;
  jti: string;
}

export class AuthManager {
  private pairCodes = new Map<string, { code: string; expiresAt: number }>();
  private challenges = new Map<string, { challenge: string; expiresAt: number }>();

  constructor(
    private store: Store,
    private secret: Buffer,
    private accessTtlSec: number,
    private refreshTtlSec: number,
    private maxDevices: number,
  ) {}

  /* ---------------- pairing ---------------- */

  /** 本机 CLI `pilink pair` 调用：生成一次性配对码 */
  createPairCode(): { code: string; expiresAt: number } {
    // 8 位数字， humans 友好
    const code = String(Math.floor(10000000 + Math.random() * 90000000));
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    this.pairCodes.set(code, { code, expiresAt });
    return { code, expiresAt };
  }

  /** 手机：POST /api/pair */
  pair(code: string, deviceName: string, publicKeyB64: string, ip?: string):
    | { ok: true; deviceId: string }
    | { ok: false; error: string } {
    const entry = this.pairCodes.get(code);
    if (!entry || entry.expiresAt < Date.now()) {
      this.pairCodes.delete(code);
      return { ok: false, error: "配对码无效或已过期" };
    }
    if (this.store.countActiveDevices() >= this.maxDevices) {
      return { ok: false, error: `设备数量已达上限（${this.maxDevices}），请先吊销旧设备` };
    }
    let key: ReturnType<typeof createPublicKey>;
    try {
      key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64url"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ec" || (key.asymmetricKeyDetails as { namedCurve?: string })?.namedCurve !== "prime256v1") {
        return { ok: false, error: "仅支持 ECDSA P-256 设备密钥" };
      }
    } catch {
      return { ok: false, error: "设备公钥格式无效" };
    }
    this.pairCodes.delete(code);
    const deviceId = randomUUID();
    const row: DeviceRow = {
      deviceId,
      name: deviceName.slice(0, 64) || "未命名设备",
      publicKey: publicKeyB64,
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastIp: ip,
    };
    this.store.insertDevice(row);
    this.store.audit(deviceId, null, "device.paired", { name: row.name });
    return { ok: true, deviceId };
  }

  /* ---------------- challenge / sign ---------------- */

  createChallenge(deviceId: string): { challenge: string; expiresAt: number } | { error: string } {
    const device = this.store.getDevice(deviceId);
    if (!device || device.revokedAt) return { error: "设备不存在或已吊销" };
    const challenge = `pilink-auth:${randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    this.challenges.set(deviceId, { challenge, expiresAt });
    return { challenge, expiresAt };
  }

  verifyChallenge(deviceId: string, signatureB64: string):
    | { ok: true; accessToken: string; refreshToken: string }
    | { ok: false; error: string } {
    const device = this.store.getDevice(deviceId);
    const entry = this.challenges.get(deviceId);
    this.challenges.delete(deviceId);
    if (!device || device.revokedAt) return { ok: false, error: "设备不存在或已吊销" };
    if (!entry || entry.expiresAt < Date.now()) return { ok: false, error: "挑战已过期" };
    const key = createPublicKey({ key: Buffer.from(device.publicKey, "base64url"), format: "der", type: "spki" });
    // WebCrypto 的 ECDSA 签名是 IEEE-P1363 原始格式（r||s），Node 默认期望 DER
    const verifyKey = { key, dsaEncoding: "ieee-p1363" as const };
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(entry.challenge, "utf8"),
      verifyKey,
      Buffer.from(signatureB64, "base64url"),
    );
    if (!ok) return { ok: false, error: "签名校验失败" };
    this.store.touchDevice(deviceId);
    this.store.audit(deviceId, null, "device.authenticated");
    return { ok: true, accessToken: this.issueAccessToken(deviceId), refreshToken: this.issueRefreshToken(deviceId) };
  }

  /* ---------------- JWT ---------------- */

  private signJwt(payload: JwtPayload): string {
    const header = b64urlJson({ alg: "HS256", typ: "JWT" });
    const body = b64urlJson(payload);
    const sig = createHmac("sha256", this.secret).update(`${header}.${body}`).digest("base64url");
    return `${header}.${body}.${sig}`;
  }

  private verifyJwt(token: string, typ: JwtPayload["typ"]): JwtPayload | { error: string } {
    const parts = token.split(".");
    if (parts.length !== 3) return { error: "令牌格式无效" };
    const [header, body, sig] = parts;
    const expected = createHmac("sha256", this.secret).update(`${header}.${body}`).digest();
    let given: Buffer;
    try {
      given = Buffer.from(sig, "base64url");
    } catch {
      return { error: "令牌签名无效" };
    }
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { error: "令牌签名无效" };
    let payload: JwtPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return { error: "令牌内容无效" };
    }
    if (payload.typ !== typ) return { error: "令牌类型不匹配" };
    if (payload.exp < Date.now() / 1000) return { error: "令牌已过期" };
    return payload;
  }

  issueAccessToken(deviceId: string): string {
    return this.signJwt({
      sub: deviceId,
      typ: "access",
      exp: Math.floor(Date.now() / 1000) + this.accessTtlSec,
      jti: randomUUID(),
    });
  }

  private issueRefreshToken(deviceId: string): string {
    const tokenId = randomUUID();
    this.store.insertRefreshToken(tokenId, deviceId, Date.now() + this.refreshTtlSec * 1000);
    return this.signJwt({
      sub: deviceId,
      typ: "refresh-jwt",
      exp: Math.floor(Date.now() / 1000) + this.refreshTtlSec,
      jti: tokenId,
    });
  }

  /** 校验 access token，返回设备（同时检查吊销）。 */
  authenticateAccessToken(token: string): { device?: DeviceRow; error?: string } {
    const payload = this.verifyJwt(token, "access");
    if ("error" in payload) return { error: payload.error };
    const device = this.store.getDevice(payload.sub);
    if (!device || device.revokedAt) return { error: "设备不存在或已吊销" };
    this.store.touchDevice(device.deviceId);
    return { device };
  }

  /** refresh 轮换：旧 refresh 作废，签发新对。 */
  refreshTokens(refreshToken: string):
    | { ok: true; accessToken: string; refreshToken: string }
    | { ok: false; error: string } {
    const payload = this.verifyJwt(refreshToken, "refresh-jwt");
    if ("error" in payload) return { ok: false, error: payload.error };
    const row = this.store.getRefreshToken(payload.jti);
    if (!row || row.revokedAt || row.expiresAt < Date.now()) return { ok: false, error: "refresh 令牌无效" };
    this.store.revokeRefreshToken(payload.jti);
    return { ok: true, accessToken: this.issueAccessToken(row.deviceId), refreshToken: this.issueRefreshToken(row.deviceId) };
  }
}

/** 简单内存速率限制（SEC-4） */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private windowMs: number, private max: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
