/**
 * Attach 模式（设计文档 §3.2，M3 ⚠️）：本机 TUI 里的 Pi 经 Bridge 扩展接入。
 * Gateway 在 127.0.0.1:<bridgePort>/bridge 监听；Bridge 扩展主动外连。
 *
 * Spike 备注（需求文档 S1/S2）：扩展事件订阅与消息注入能力以实际 Pi 版本为准；
 * 若不满足，Attach 退化为「只读共视 + 交接」（SYNC-1/2/3 仍由 Host 模式满足）。
 */
import { WebSocketServer } from "ws";
import type { RpcCommand, RpcResponse, PiEvent, SessionKey } from "@pilink/protocol";
import type { Server } from "node:http";
import { DriverError, type DriverCaps, type PiDriver, type WsLike } from "./types.js";

export interface BridgePeer {
  socket: WsLike;
  cwd: string;
  sessionFile: string;
  pid: number;
}

type PendingBridge = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BridgeHub {
  private peers = new Map<WsLike, BridgePeer>();
  private bySessionFile = new Map<string, BridgePeer>();
  private attachDrivers = new Map<string, AttachDriver>(); // sessionFile -> driver
  private pending = new Map<string, PendingBridge>();
  private idCounter = 0;
  onPeerChange?: () => void;

  constructor(private wss: WebSocketServer) {
    wss.on("connection", (socket: WsLike, req) => {
      if (req.url !== "/bridge") {
        socket.close(4004, "unknown path");
        return;
      }
      socket.on("message", (data) => this.handleMessage(socket, data.toString()));
      socket.on("close", () => this.removePeer(socket));
      socket.on("error", () => this.removePeer(socket));
    });
  }

  private handleMessage(socket: WsLike, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const t = msg.t as string;
    if (t === "hello") {
      const peer: BridgePeer = {
        socket,
        cwd: String(msg.cwd ?? ""),
        sessionFile: String(msg.sessionFile ?? ""),
        pid: Number(msg.pid ?? 0),
      };
      this.peers.set(socket, peer);
      if (peer.sessionFile) this.bySessionFile.set(peer.sessionFile, peer);
      this.onPeerChange?.();
      return;
    }
    if (t === "rpc_res" || t === "system_prompt" || t === "reload_result") {
      const id = String(msg.id ?? "");
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (msg.ok === false) p.reject(new DriverError("BRIDGE_ERROR", String(msg.error ?? "bridge error")));
        else p.resolve(msg);
      }
      return;
    }
    if (t === "event") {
      const sessionFile = this.peers.get(socket)?.sessionFile;
      if (sessionFile) this.attachDrivers.get(sessionFile)?.emitEvent(msg.ev as PiEvent);
      return;
    }
  }

  private removePeer(socket: WsLike): void {
    const peer = this.peers.get(socket);
    this.peers.delete(socket);
    if (peer && this.bySessionFile.get(peer.sessionFile) === peer) {
      this.bySessionFile.delete(peer.sessionFile);
    }
    this.onPeerChange?.();
  }

  hasBridgeFor(sessionFile: string): boolean {
    return this.bySessionFile.has(sessionFile);
  }

  listPeers(): BridgePeer[] {
    return [...this.peers.values()];
  }

  attach(sessionKey: SessionKey, sessionFile: string): AttachDriver {
    const existing = this.attachDrivers.get(sessionFile);
    if (existing) return existing;
    const driver = new AttachDriver(sessionKey, sessionFile, this);
    this.attachDrivers.set(sessionFile, driver);
    return driver;
  }

  detach(sessionFile: string): void {
    this.attachDrivers.delete(sessionFile);
  }

  request<R = unknown>(peer: BridgePeer, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<R> {
    const id = `bh-${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DriverError("BRIDGE_TIMEOUT", "Bridge 无响应"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      peer.socket.send(JSON.stringify({ id, ...payload }));
    });
  }

  getPeer(sessionFile: string): BridgePeer | undefined {
    return this.bySessionFile.get(sessionFile);
  }
}

export class AttachDriver implements PiDriver {
  readonly kind = "attach" as const;
  readonly caps: DriverCaps = { reload: true, getSystemPrompt: true, navigateTree: true, liveCoPresence: true };
  private listeners = new Set<(ev: PiEvent) => void>();
  private released = false;

  constructor(
    readonly sessionKey: SessionKey,
    readonly sessionFile: string,
    private hub: BridgeHub,
  ) {}

  isAlive(): boolean {
    return !this.released && this.hub.getPeer(this.sessionFile)?.socket.readyState === 1;
  }

  async request(cmd: RpcCommand): Promise<RpcResponse> {
    const peer = this.hub.getPeer(this.sessionFile);
    if (!peer) throw new DriverError("BRIDGE_UNAVAILABLE", "Bridge 未连接");
    const res = await this.hub.request<{ res: RpcResponse }>(peer, { t: "rpc", cmd });
    return res.res;
  }

  onEvent(fn: (ev: PiEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitEvent(ev: PiEvent): void {
    for (const fn of [...this.listeners]) fn(ev);
  }

  async getSystemPrompt(): Promise<string | undefined> {
    const peer = this.hub.getPeer(this.sessionFile);
    if (!peer) return undefined;
    try {
      const res = await this.hub.request<{ text: string }>(peer, { t: "get_system_prompt" }, 10_000);
      return res.text;
    } catch {
      return undefined;
    }
  }

  async reload(): Promise<void> {
    const peer = this.hub.getPeer(this.sessionFile);
    if (!peer) throw new DriverError("BRIDGE_UNAVAILABLE", "Bridge 未连接");
    await this.hub.request(peer, { t: "reload" }, 60_000);
  }

  async requestRelease(): Promise<void> {
    const peer = this.hub.getPeer(this.sessionFile);
    if (!peer) return; // TUI 已退出
    await this.hub.request(peer, { t: "request_release" }, 15_000);
  }

  async release(): Promise<void> {
    // 释放 = 断开接入，不影响本机 TUI 进程（设计 §3）
    this.released = true;
    this.hub.detach(this.sessionFile);
  }
}

export function createBridgeWss(server: Server, bridgePort: number): BridgeHub {
  const wss = new WebSocketServer({ server, path: "/bridge" });
  return new BridgeHub(wss);
}
