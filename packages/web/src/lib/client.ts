/**
 * Gateway WS 客户端：认证、重连（指数退避+抖动，MOB-5）、rpc/gw 承诺封装、增量补齐。
 */
import type { ClientMsg, ServerMsg, SessionKey, RpcCommand, GatewayOp, RpcResponseLoose } from "@pilink/protocol";
import { getOrCreateDeviceKey, exportPublicKeyB64, signChallenge } from "./deviceKey";

const TOKEN_KEY = "pilink.tokens";
const DEVICE_ID_KEY = "pilink.deviceId";

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export function getDeviceId(): string | null {
  return localStorage.getItem(DEVICE_ID_KEY);
}
export function setDeviceId(id: string): void {
  localStorage.setItem(DEVICE_ID_KEY, id);
}
function getTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}
function setTokens(t: Tokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(DEVICE_ID_KEY);
}

export function hasCredentials(): boolean {
  return !!getDeviceId() && !!getTokens();
}

/** 配对 + 挑战签名登录（§11.4） */
export async function pairAndLogin(code: string, deviceName: string): Promise<void> {
  const pair = getOrCreateDeviceKey();
  const pub = exportPublicKeyB64(await pair);
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName, devicePubKey: await pub }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "配对失败");
  const deviceId = body.deviceId as string;
  setDeviceId(deviceId);
  await loginWithChallenge(deviceId);
}

export async function loginWithChallenge(deviceId: string): Promise<void> {
  const key = await getOrCreateDeviceKey();
  const chRes = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  const chBody = await chRes.json();
  if (!chRes.ok) throw new Error(chBody.error ?? "获取挑战失败");
  const signature = await signChallenge(key, chBody.challenge);
  const vfRes = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, signature }),
  });
  const vfBody = await vfRes.json();
  if (!vfRes.ok) throw new Error(vfBody.error ?? "验证失败");
  setTokens({ accessToken: vfBody.accessToken, refreshToken: vfBody.refreshToken });
}

async function refreshTokens(): Promise<boolean> {
  const tokens = getTokens();
  const deviceId = getDeviceId();
  if (!tokens || !deviceId) return false;
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  });
  if (!res.ok) {
    // refresh 失败：尝试重新挑战登录
    try {
      await loginWithChallenge(deviceId);
      return true;
    } catch {
      return false;
    }
  }
  const body = await res.json();
  setTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
  return true;
}

type EventHandler = (msg: ServerMsg) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  /** 连接就绪前待发的消息（hello_ok 后按序补发，防丢包） */
  private pendingQueue: ClientMsg[] = [];
  private helloOk = false;
  private rpcWaiters = new Map<string, { resolve: (r: RpcResponseLoose) => void; reject: (e: Error) => void }>();
  private gwWaiters = new Map<string, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
  private idCounter = 0;
  private pingTimer?: ReturnType<typeof setInterval>;
  onMessage: EventHandler = () => {};
  onStatusChange: (status: "connecting" | "online" | "offline") => void = () => {};

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(resume?: { sessionKey: SessionKey; lastSeq: number; lastEntryId?: string }): Promise<void> {
    this.closedByUser = false;
    this.open(resume);
  }

  private open(resume?: { sessionKey: SessionKey; lastSeq: number; lastEntryId?: string }): void {
    const tokens = getTokens();
    const deviceId = getDeviceId();
    if (!tokens || !deviceId) {
      this.onStatusChange("offline");
      return;
    }
    this.onStatusChange("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      const hello: ClientMsg = {
        t: "hello",
        v: 1,
        deviceId,
        accessToken: tokens.accessToken,
        resume,
      };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === "hello_ok") {
        this.retry = 0;
        this.helloOk = true;
        this.onStatusChange("online");
        this.startPing();
        this.onMessage(msg);
        // 补发连接期间排队的请求（如启动时的 workspaces.list）
        const queued = this.pendingQueue;
        this.pendingQueue = [];
        for (const m of queued) this.raw(m);
        return;
      }
      if (msg.t === "rpc_res") {
        const w = this.rpcWaiters.get(msg.id);
        if (w) {
          this.rpcWaiters.delete(msg.id);
          w.resolve(msg.res);
        }
      } else if (msg.t === "gw_res") {
        const w = this.gwWaiters.get(msg.id);
        if (w) {
          this.gwWaiters.delete(msg.id);
          if (msg.ok) w.resolve(msg.data);
          else w.reject(new Error(msg.error.message));
        }
      }
      this.onMessage(msg);
    };
    ws.onclose = (e) => {
      this.stopPing();
      this.helloOk = false;
      if (this.closedByUser) return;
      if (e.code === 4001) {
        // 认证失败 → 刷新令牌后重试一次
        void refreshTokens().then((ok) => {
          if (ok && !this.closedByUser) this.scheduleReconnect(resume);
          else this.onStatusChange("offline");
        });
        return;
      }
      this.onStatusChange("offline");
      this.scheduleReconnect(resume);
    };
    ws.onerror = () => {
      /* onclose 统一处理 */
    };
  }

  private scheduleReconnect(resume?: { sessionKey: SessionKey; lastSeq: number; lastEntryId?: string }): void {
    const delay = Math.min(8000, 500 * 2 ** this.retry) + Math.random() * 300;
    this.retry++;
    setTimeout(() => {
      if (!this.closedByUser) this.open(resume);
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isConnected) this.raw({ t: "ping", ts: Date.now() });
    }, 25_000);
  }
  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  disconnect(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }

  raw(msg: ClientMsg): void {
    if (this.isConnected && this.helloOk) {
      this.ws!.send(JSON.stringify(msg));
      return;
    }
    // 未连接/未鉴权：排队等待 hello_ok 补发，避免启动时丢请求
    if (!this.closedByUser) this.pendingQueue.push(msg);
  }

  rpc(sessionKey: SessionKey, cmd: RpcCommand, timeoutMs = 120_000): Promise<RpcResponseLoose> {
    const id = `c-${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcWaiters.delete(id);
        reject(new Error(`RPC 超时（${timeoutMs / 1000}s）：${(cmd as { type?: string }).type ?? "unknown"}`));
      }, timeoutMs);
      this.rpcWaiters.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.raw({ t: "rpc", id, sessionKey, cmd });
    });
  }

  gw<T = unknown>(op: GatewayOp, timeoutMs = 60_000): Promise<T> {
    const id = `g-${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.gwWaiters.delete(id);
        reject(new Error(`操作超时（${timeoutMs / 1000}s）：${(op as { op?: string }).op ?? "unknown"}`));
      }, timeoutMs);
      this.gwWaiters.set(id, {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.raw({ t: "gw", id, op });
    });
  }

  uiResponse(sessionKey: SessionKey, requestId: string, payload: unknown): void {
    this.raw({ t: "ui_response", sessionKey, requestId, payload });
  }

  setTyping(sessionKey: SessionKey, typing: boolean): void {
    this.raw({ t: "typing", sessionKey, typing });
  }
}

export const client = new GatewayClient();
