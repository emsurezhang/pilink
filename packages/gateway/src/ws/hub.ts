/**
 * WS Hub（设计文档 §4.4 / §10.3）。
 * - 每个 sessionKey：单调 seq + 环形缓冲 + 订阅者集合
 * - 多设备同时订阅（SYNC-8）；写操作串行进入 Driver
 * - presence（输入提示）、ui_request 路由、外部写入冲突监测（§4.2 兜底）
 */
import { watch, statSync } from "node:fs";
import type { WsLike } from "../driver/types.js";
import type {
  ClientMsg,
  ServerMsg,
  GatewayEvent,
  PiEvent,
  SessionKey,
  RpcCommand,
  RpcResponse,
} from "@pilink/protocol";
import { RPC_ALLOWLIST, makeSessionKey, splitSessionKey } from "@pilink/protocol";
import { DriverError, type PiDriver } from "../driver/types.js";
import { wsLog } from "../log.js";
import { LeaseManager, readLease, isLeaseStale } from "../driver/lease.js";
import type { Store } from "../db.js";

export interface ClientConn {
  socket: WsLike;
  deviceId: string;
  deviceName: string;
  ip?: string;
  /** sessionKey -> lastSeq */
  subs: Map<SessionKey, number>;
  helloOk: boolean;
  lastTyping: Map<SessionKey, number>;
}

interface RingItem {
  seq: number;
  ev: PiEvent;
  size: number;
}

export interface SessionRuntime {
  sessionKey: SessionKey;
  workspaceId: string;
  cwd: string;
  sessionPath: string;
  driver: PiDriver;
  seq: number;
  ring: RingItem[];
  ringBytes: number;
  conflict: boolean;
  lastPiActivityAt: number;
  watcher?: ReturnType<typeof setTimeout>;
  unsubEvents?: () => void;
  writeQueue: Promise<unknown>;
}

export interface HubOptions {
  ringMaxEvents: number;
  ringMaxBytes: number;
  onGwEvent?: (ev: GatewayEvent, except?: ClientConn) => void;
  onPushNotify?: (payload: { title: string; body: string }) => void;
  audit: (deviceId: string | null, workspaceId: string | null, action: string, detail?: unknown) => void;
}

export class Hub {
  clients = new Set<ClientConn>();
  runtimes = new Map<SessionKey, SessionRuntime>();
  private seqCounters = new Map<SessionKey, number>();

  constructor(
    private lease: LeaseManager,
    private store: Store,
    private opts: HubOptions,
  ) {}

  send(conn: ClientConn, msg: ServerMsg): void {
    if (conn.socket.readyState === 1) {
      conn.socket.send(JSON.stringify(msg));
      // 低频消息才逐条记日志；presence 由 typing 触发，太密
      if ((msg as { t?: string }).t !== "gw_event" || (msg as { ev?: { e?: string } }).ev?.e !== "presence") {
        wsLog("out", conn.deviceName, msg);
      }
    }
  }

  broadcast(ev: GatewayEvent, except?: ClientConn): void {
    for (const c of this.clients) {
      if (c !== except) this.send(c, { t: "gw_event", ev });
    }
  }

  addClient(conn: ClientConn): void {
    this.clients.add(conn);
  }

  removeClient(conn: ClientConn): void {
    this.clients.delete(conn);
    for (const key of conn.subs.keys()) this.updatePresence(key);
  }

  /* ---------------- 会话运行时 ---------------- */

  registerRuntime(rt: SessionRuntime): void {
    this.runtimes.set(rt.sessionKey, rt);
    rt.unsubEvents = rt.driver.onEvent((ev) => this.handlePiEvent(rt, ev));
    this.watchExternalWrites(rt);
  }

  async destroyRuntime(sessionKey: SessionKey, reason?: string): Promise<void> {
    const rt = this.runtimes.get(sessionKey);
    if (!rt) return;
    rt.unsubEvents?.();
    if (rt.watcher) clearTimeout(rt.watcher);
    await rt.driver.release().catch(() => {});
    this.lease.release(rt.sessionPath);
    this.runtimes.delete(sessionKey);
    this.broadcast({ e: "holder_changed", sessionKey, holder: "none" });
    this.opts.audit(null, splitSessionKey(sessionKey).workspaceId, "session.released", { reason });
  }

  runtimeFor(sessionKey: SessionKey): SessionRuntime | undefined {
    return this.runtimes.get(sessionKey);
  }

  private handlePiEvent(rt: SessionRuntime, ev: PiEvent): void {
    rt.lastPiActivityAt = Date.now();
    const seq = ++rt.seq;
    const item: RingItem = { seq, ev, size: JSON.stringify(ev).length };
    rt.ring.push(item);
    rt.ringBytes += item.size;
    while (rt.ring.length > 0 && (rt.ring.length > this.opts.ringMaxEvents || rt.ringBytes > this.opts.ringMaxBytes)) {
      const dropped = rt.ring.shift()!;
      rt.ringBytes -= dropped.size;
    }
    const msg: ServerMsg = { t: "event", sessionKey: rt.sessionKey, seq, ev };
    for (const c of this.clients) {
      if (c.subs.has(rt.sessionKey)) this.send(c, msg);
    }
    const type = (ev as { type?: string }).type;
    if (type === "agent_settled") {
      const aborted = (ev as { aborted?: boolean }).aborted;
      this.opts.onPushNotify?.({
        title: aborted ? "Pi 已中止" : "Pi 任务完成",
        body: rt.sessionKey,
      });
    }
  }

  /** §4.2 兜底：托管期间监测非自身写入（未装 Bridge 的终端 pi -c 双写） */
  private watchExternalWrites(rt: SessionRuntime): void {
    if (rt.driver.kind !== "host") return;
    try {
      let lastSize = 0;
      try {
        lastSize = statSync(rt.sessionPath).size;
      } catch {
        /* 新会话 */
      }
      const watcher = watch(rt.sessionPath, () => {
        clearTimeout(rt.watcher);
        rt.watcher = setTimeout(() => {
          try {
            const st = statSync(rt.sessionPath);
            const grew = st.size > lastSize;
            lastSize = Math.max(lastSize, st.size);
            const quiet = Date.now() - rt.lastPiActivityAt > 2000;
            if (grew && quiet && !rt.conflict) {
              rt.conflict = true;
              this.opts.audit(null, rt.workspaceId, "session.conflict", { path: rt.sessionPath });
              for (const c of this.clients) {
                if (c.subs.has(rt.sessionKey)) {
                  this.send(c, { t: "gw_event", ev: { e: "conflict", sessionKey: rt.sessionKey, reason: "external_write" } });
                }
              }
            }
          } catch {
            /* 文件被删除等 */
          }
        }, 500);
      });
      watcher.on("error", () => {});
      // watcher 随 runtime 销毁：包装 unsubEvents 关闭
      const origDestroy = rt.unsubEvents;
      rt.unsubEvents = () => {
        watcher.close();
        origDestroy?.();
      };
    } catch {
      /* 不支持 watch 的平台忽略 */
    }
  }

  /* ---------------- 订阅 / 增量补齐（SYNC-6） ---------------- */

  subscribe(conn: ClientConn, sessionKey: SessionKey, lastSeq: number, lastEntryId?: string): void {
    const rt = this.runtimes.get(sessionKey);
    if (!rt) {
      this.send(conn, {
        t: "gw_res",
        id: "subscribe",
        ok: false,
        error: { code: "NO_RUNTIME", message: "会话未被托管，请先 session.open" },
      });
      return;
    }
    conn.subs.set(sessionKey, lastSeq);
    // 环形缓冲命中 → 补发缺失事件；未命中 → 要求客户端以 get_entries(since lastEntryId) 全量校准
    const base = rt.ring[0]?.seq ?? rt.seq + 1;
    if (lastSeq > 0 && lastSeq >= base - 1 && lastSeq <= rt.seq) {
      for (const item of rt.ring) {
        if (item.seq > lastSeq) this.send(conn, { t: "event", sessionKey, seq: item.seq, ev: item.ev });
      }
    } else if (lastSeq > 0 && lastSeq < base - 1) {
      this.send(conn, {
        t: "gw_event",
        ev: { e: "conflict", sessionKey, reason: "lease_lost" } as GatewayEvent,
      });
      this.send(conn, {
        t: "gw_res",
        id: "resync",
        ok: false,
        error: { code: "RESYNC_REQUIRED", message: "事件缓冲已溢出，请用 get_entries 增量校准" },
      });
    }
    this.updatePresence(sessionKey);
    this.send(conn, {
      t: "gw_event",
      ev: { e: "holder_changed", sessionKey, holder: rt.driver.kind === "host" ? "host" : "tui" },
    });
    this.store.touchWorkspace(rt.workspaceId, rt.cwd);
  }

  /* ---------------- RPC 透传（§5.3 白名单 + 串行写） ---------------- */

  async handleRpc(conn: ClientConn, id: string, sessionKey: SessionKey, cmd: RpcCommand): Promise<void> {
    const type = (cmd as { type?: string }).type ?? "";
    console.log(`[pilink:gateway] rpc in ${sessionKey} type=${type} id=${id}`);
    if (!RPC_ALLOWLIST.has(type)) {
      this.opts.audit(conn.deviceId, splitSessionKey(sessionKey).workspaceId, "rpc.rejected", { type });
      this.send(conn, {
        t: "rpc_res",
        id,
        res: { type: "response", command: type, success: false, error: `命令不在放行集合：${type}` } as RpcResponse,
      });
      return;
    }
    const rt = this.runtimes.get(sessionKey);
    if (!rt) {
      this.send(conn, {
        t: "rpc_res",
        id,
        res: { type: "response", command: type, success: false, error: "会话未被托管" } as RpcResponse,
      });
      return;
    }
    if (rt.conflict) {
      this.send(conn, {
        t: "rpc_res",
        id,
        res: { type: "response", command: type, success: false, error: "会话存在写冲突，请先解决" } as RpcResponse,
      });
      return;
    }
    // 写操作串行进入 Driver（§10.3），沿用 Pi 自身队列语义
    const isWrite = !/^(get_|export_html)/.test(type);
    const task = isWrite ? (rt.writeQueue = rt.writeQueue.then(() => this.doRequest(rt, cmd))) : this.doRequest(rt, cmd);
    try {
      const res = (await task) as RpcResponse;
      console.log(`[pilink:gateway] rpc ok ${sessionKey} type=${type} success=${res.success}`);
      this.send(conn, { t: "rpc_res", id, res });
      this.opts.audit(conn.deviceId, rt.workspaceId, `rpc.${type}`);
    } catch (e) {
      console.error(`[pilink:gateway] rpc fail ${sessionKey} type=${type}`, e);
      this.send(conn, {
        t: "rpc_res",
        id,
        res: {
          type: "response",
          command: type,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        } as RpcResponse,
      });
    }
  }

  private doRequest(rt: SessionRuntime, cmd: RpcCommand): Promise<RpcResponse> {
    return rt.driver.request(cmd);
  }

  /* ---------------- presence（SYNC-8） ---------------- */

  handleTyping(conn: ClientConn, sessionKey: SessionKey, typing: boolean): void {
    conn.lastTyping.set(sessionKey, typing ? Date.now() : 0);
    this.updatePresence(sessionKey);
  }

  private updatePresence(sessionKey: SessionKey): void {
    const devices = [...this.clients]
      .filter((c) => c.subs.has(sessionKey))
      .map((c) => ({
        deviceId: c.deviceId,
        name: c.deviceName,
        typing: (c.lastTyping.get(sessionKey) ?? 0) > Date.now() - 5_000,
        lastSeen: Date.now(),
      }));
    const ev: GatewayEvent = { e: "presence", sessionKey, devices };
    for (const c of this.clients) {
      if (c.subs.has(sessionKey)) this.send(c, { t: "gw_event", ev });
    }
  }

  /* ---------------- 扩展 UI 路由（CMD-10） ---------------- */

  forwardUiRequest(sessionKey: SessionKey, requestId: string, payload: unknown): void {
    for (const c of this.clients) {
      if (c.subs.has(sessionKey)) {
        this.send(c, { t: "ui_request", sessionKey, requestId, payload });
        return; // 只发给第一个订阅者作答
      }
    }
  }

  handleUiResponse(sessionKey: SessionKey, requestId: string, payload: unknown): void {
    const rt = this.runtimes.get(sessionKey);
    if (rt && rt.driver.kind === "host") {
      (rt.driver as import("../driver/host.js").HostDriver).respondUi(requestId, payload);
    }
  }

  deviceNames(): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of this.clients) m.set(c.deviceId, c.deviceName);
    return m;
  }
}
