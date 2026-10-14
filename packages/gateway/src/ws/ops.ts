/**
 * Gateway 自有操作分发（设计文档 §5.2）。
 */
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_COMMANDS, SETTINGS_PATCH_ALLOWLIST, makeSessionKey, splitSessionKey } from "@pilink/protocol";
import type { GatewayOp, SessionKey } from "@pilink/protocol";
import type { Hub, ClientConn } from "./hub.js";
import type { Store } from "../db.js";
import type { GatewayConfig } from "../config.js";
import { DriverError } from "../driver/types.js";
import { LeaseManager, readLease, isLeaseStale } from "../driver/lease.js";
import { HostDriver } from "../driver/host.js";
import type { BridgeHub } from "../driver/attach.js";
import { WorkspaceRegistry, decodeWorkspaceId, encodeWorkspaceId, piDirNameForCwd } from "../workspace/registry.js";
import { listSessionsForCwd } from "../workspace/sessions.js";
import { searchFiles } from "../workspace/fssearch.js";
import { listDir, readText } from "../workspace/fsbrowser.js";
import { RoleManager } from "../role/manager.js";
import { setKeepAwake, isKeepAwake } from "../system/keepawake.js";
import type { PushManager } from "../push/push.js";

export class Ops {
  workspaces: WorkspaceRegistry;

  constructor(
    private cfg: GatewayConfig,
    private store: Store,
    private hub: Hub,
    private lease: LeaseManager,
    private bridgeHub: BridgeHub,
    private roles: RoleManager,
    private push: PushManager,
  ) {
    this.workspaces = new WorkspaceRegistry(cfg.workspaces, store);
  }

  async dispatch(conn: ClientConn, id: string, op: GatewayOp): Promise<void> {
    try {
      const data = await this.exec(conn, op);
      this.hub.send(conn, { t: "gw_res", id, ok: true, data });
    } catch (e) {
      const code = e instanceof DriverError ? e.code : "INTERNAL";
      const message = e instanceof Error ? e.message : String(e);
      this.hub.send(conn, { t: "gw_res", id, ok: false, error: { code, message } });
    }
  }

  private async exec(conn: ClientConn, op: GatewayOp): Promise<unknown> {
    switch (op.op) {
      case "workspaces.list":
        return { workspaces: this.workspaces.list(), aliases: this.readAliases() };

      case "workspace.aliases.set": {
        // 跨设备同步的 workspace 别名（白名单校验 + 长度限制，整表覆盖）
        if (!op.aliases || typeof op.aliases !== "object" || Array.isArray(op.aliases)) {
          throw new DriverError("BAD_ARGS", "aliases 必须是对象");
        }
        const allowed = new Set(this.workspaces.list().map((w) => w.workspaceId));
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(op.aliases)) {
          if (Object.keys(clean).length >= 50) break;
          const alias = String(v ?? "").trim().slice(0, 64);
          if (alias && allowed.has(k)) clean[k] = alias;
        }
        this.store.setKv("workspace_aliases", JSON.stringify(clean));
        this.store.audit(conn.deviceId, null, "workspace.aliases.set", { count: Object.keys(clean).length });
        return { aliases: clean };
      }

      case "sessions.list": {
        const cwd = decodeWorkspaceId(op.workspaceId);
        if (!this.workspaces.isAllowed(cwd)) throw new DriverError("WS_DENIED", "工作区不在白名单");
        this.store.touchWorkspace(op.workspaceId, cwd);
        return { sessions: listSessionsForCwd(cwd, op.query) };
      }

      case "session.open":
        return this.openSession(conn, op.workspaceId, op.sessionPath, op.mode ?? "auto");

      case "session.release": {
        const rt = this.hub.runtimeFor(op.sessionKey);
        if (!rt) return { released: false };
        await this.hub.destroyRuntime(op.sessionKey, "client request");
        return { released: true, resumeCommand: rt.sessionPath ? `pi --session ${rt.sessionPath}` : undefined };
      }

      case "session.takeover":
        return this.takeover(op.sessionKey);

      case "session.stats": {
        const rt = this.requireRuntime(op.sessionKey);
        const res = (await rt.driver.request({ type: "get_session_stats" } as never)) as { success: boolean; data?: unknown; error?: string };
        if (!res.success) throw new DriverError("RPC_REJECTED", String(res.error));
        return res.data;
      }

      case "commands.list": {
        const rt = this.requireRuntime(op.sessionKey);
        const dynamic = (await rt.driver.request({ type: "get_commands" } as never)) as { success: boolean; data?: { commands?: unknown[] } };
        const dynamicList = dynamic.success ? (dynamic.data?.commands ?? []) : [];
        return { builtin: BUILTIN_COMMANDS, dynamic: dynamicList };
      }

      case "roles.list": {
        const cwd = decodeWorkspaceId(op.workspaceId);
        if (!this.workspaces.isAllowed(cwd)) throw new DriverError("WS_DENIED", "工作区不在白名单");
        return {
          candidates: this.roles.listCandidates(cwd),
          current: this.roles.currentSource(cwd),
          fallback: this.roles.defaultFallbackInfo(),
        };
      }

      case "roles.preview": {
        const cwd = decodeWorkspaceId(op.workspaceId);
        return { content: this.roles.preview(cwd, op.source) };
      }

      case "roles.select": {
        const cwd = decodeWorkspaceId(op.workspaceId);
        if (!this.workspaces.isAllowed(cwd)) throw new DriverError("WS_DENIED", "工作区不在白名单");
        const sessionKey = this.activeSessionKeyForWorkspace(op.workspaceId);
        const rt = sessionKey ? this.hub.runtimeFor(sessionKey) : undefined;
        const result = await this.roles.select(cwd, op.source, rt?.driver ?? null, { force: op.force });
        this.store.audit(conn.deviceId, op.workspaceId, "role.selected", { source: op.source });
        this.hub.broadcast({ e: "role_changed", workspaceId: op.workspaceId, source: result.source, promptHash: result.promptHash });
        return result;
      }

      case "fs.search": {
        const cwd = decodeWorkspaceId(op.workspaceId);
        if (!this.workspaces.isAllowed(cwd)) throw new DriverError("WS_DENIED", "工作区不在白名单");
        return { files: searchFiles(cwd, op.query, op.limit ?? 20) };
      }

      case "fs.list": {
        // 文件浏览：目录列举（隐藏文件跳过，目录优先）
        const cwd = decodeWorkspaceId(op.workspaceId);
        if (!this.workspaces.isAllowed(cwd)) throw new DriverError("WS_DENIED", "工作区不在白名单");
        return { entries: listDir(cwd, String(op.dir ?? "")) };
      }

      case "fs.read": {
        // 文件浏览：读取文本文件（UTF-8，512KB 截断；路径越界在 fsbrowser 内防护）
        const cwd = decodeWorkspaceId(op.workspaceId);
        if (!this.workspaces.isAllowed(cwd)) throw new DriverError("WS_DENIED", "工作区不在白名单");
        return readText(cwd, String(op.path ?? ""));
      }

      case "settings.get":
        return { settings: await this.readSettings() };

      case "settings.patch":
        return { settings: await this.patchSettings(op.patch) };

      case "export.download": {
        const rt = this.requireRuntime(op.sessionKey);
        const dir = await mkdtemp(join(tmpdir(), "pilink-export-"));
        const outPath = join(dir, "session.html");
        const res = (await rt.driver.request({ type: "export_html", outputPath: outPath } as never)) as { success: boolean; error?: string };
        if (!res.success) throw new DriverError("RPC_REJECTED", String(res.error));
        const data = await readFile(outPath, "base64");
        return { filename: "session.html", dataBase64: data };
      }

      case "host.keepAwake":
        return { enabled: setKeepAwake(op.enabled) };

      case "devices.list":
        return {
          devices: this.store
            .listDevices()
            .map((d) => ({
              deviceId: d.deviceId,
              name: d.name,
              pairedAt: d.pairedAt,
              lastSeenAt: d.lastSeenAt,
              lastIp: d.lastIp,
              revoked: !!d.revokedAt,
              online: [...this.hub.clients].some((c) => c.deviceId === d.deviceId),
            })),
          keepAwake: isKeepAwake(),
          pushEnabled: this.push.enabled,
          pushPublicKey: this.push.publicKey,
          maxDevices: this.cfg.maxDevices,
        };

      case "devices.revoke":
        this.store.revokeDevice(op.deviceId);
        this.store.audit(conn.deviceId, null, "device.revoked", { deviceId: op.deviceId });
        // 断开该设备的其它在线连接（保留发起者，以便其收到本响应）
        for (const c of [...this.hub.clients]) {
          if (c.deviceId === op.deviceId && c !== conn) c.socket.close(4003, "device revoked");
        }
        return { revoked: true };

      default:
        throw new DriverError("UNKNOWN_OP", `未知操作：${(op as { op: string }).op}`);
    }
  }

  /* ---------------- session.open（§3.3 选择规则） ---------------- */

  private async openSession(conn: ClientConn, workspaceId: string, sessionPath: string, mode: "auto" | "host") {
    const result = await this.openSessionInternal(conn, workspaceId, sessionPath, mode);
    // 打开者自动订阅事件流（SYNC-8：其它设备各自订阅）
    this.hub.subscribe(conn, result.sessionKey, 0);
    return result;
  }

  private async openSessionInternal(conn: ClientConn, workspaceId: string, sessionPath: string, mode: "auto" | "host") {
    const cwd = decodeWorkspaceId(workspaceId);
    if (!this.workspaces.isAllowed(cwd)) throw new DriverError("WS_DENIED", "工作区不在白名单");
    if (!existsSync(sessionPath) && sessionPath !== "new") throw new DriverError("SESSION_NOT_FOUND", "会话文件不存在");
    if (sessionPath !== "new" && !sessionPath.startsWith(cwd === "/" ? "/" : cwd) && !sessionPath.includes(`--${piDirNameForCwd(cwd)}--`)) {
      throw new DriverError("WS_DENIED", "会话路径与工作区不符");
    }
    const sessionId = sessionPath === "new" ? `new-${Date.now()}` : sessionPath.split("/").pop()!.replace(/\.jsonl$/, "");
    const sessionKey = makeSessionKey(workspaceId, sessionId);

    // 已托管 → 复用（§10.3：只由首个请求触发）
    const existing = this.hub.runtimeFor(sessionKey);
    if (existing) return { sessionKey, holder: existing.driver.kind, reused: true };

    // Attach：本机 Bridge 正持有该会话
    if (mode === "auto" && sessionPath !== "new" && this.bridgeHub.hasBridgeFor(sessionPath)) {
      const driver = this.bridgeHub.attach(sessionKey, sessionPath);
      this.registerRuntime(sessionKey, workspaceId, cwd, sessionPath, driver);
      this.store.audit(conn.deviceId, workspaceId, "session.attach");
      return { sessionKey, holder: "tui" };
    }

    // Host：获取 lease（SYNC-2 单写者）
    const effectivePath = sessionPath === "new" ? undefined : sessionPath;
    if (effectivePath) {
      const existing_ = readLease(effectivePath);
      if (existing_ && !isLeaseStale(existing_) && !this.lease.isHeldByHost(effectivePath)) {
        if (existing_.holder === "tui" && this.bridgeHub.hasBridgeFor(effectivePath)) {
          // Bridge 在线但未走 attach（mode=host 强制）→ 请求释放
          throw new DriverError("LEASE_CONFLICT", "本机 TUI 正在持有此会话，请先交接或请求接管");
        }
        if (!this.lease.stealIfStale(effectivePath, "host")) {
          throw new DriverError("LEASE_CONFLICT", `会话被其它进程持有（pid=${existing_.pid}）`);
        }
      } else if (!this.lease.acquire(effectivePath, "host")) {
        throw new DriverError("LEASE_CONFLICT", "无法获取会话租约");
      }
    }

    let sessionPathFinal = effectivePath ?? "";
    const bridgePath = join(this.cfg.dataDir, "bridge", "index.js");
    const driver = new HostDriver(sessionKey, {
      piPath: this.cfg.piPath,
      cwd,
      sessionPath: effectivePath,
      loadBridge: this.cfg.hostLoadBridge && existsSync(bridgePath),
      bridgePath,
      onExit: () => {
        const rt = this.hub.runtimeFor(sessionKey);
        if (rt) {
          this.hub.broadcast({
            e: "host_status",
            sessionKey,
            status: "exited",
          });
          void this.hub.destroyRuntime(sessionKey, "pi exited");
        }
      },
      onUiRequest: (payload) => {
        const p = payload as { id?: string };
        if (p.id) this.hub.forwardUiRequest(sessionKey, p.id, payload);
      },
    });

    // 新会话：从 get_state 拿真实路径
    if (!sessionPathFinal) {
      try {
        const st = (await driver.request({ type: "get_state" } as never)) as { success: boolean; data?: { sessionFile?: string } };
        if (st.success) sessionPathFinal = st.data?.sessionFile ?? "";
      } catch {
        /* 启动早期 */
      }
      const realKey = makeSessionKey(workspaceId, sessionPathFinal.split("/").pop()?.replace(/\.jsonl$/, "") ?? sessionId);
      if (realKey !== sessionKey) {
        // 以真实路径重建 runtime key
        this.lease.acquire(sessionPathFinal, "host");
        this.registerRuntime(realKey, workspaceId, cwd, sessionPathFinal, driver);
        this.store.audit(conn.deviceId, workspaceId, "session.host", { new: true });
        return { sessionKey: realKey, holder: "host", sessionPath: sessionPathFinal };
      }
      this.lease.acquire(sessionPathFinal, "host");
    }

    this.registerRuntime(sessionKey, workspaceId, cwd, sessionPathFinal, driver);
    this.store.audit(conn.deviceId, workspaceId, "session.host", { path: sessionPathFinal });
    this.hub.broadcast({ e: "host_status", sessionKey, status: "starting" });
    return { sessionKey, holder: "host", sessionPath: sessionPathFinal };
  }

  private registerRuntime(sessionKey: SessionKey, workspaceId: string, cwd: string, sessionPath: string, driver: HostDriver | import("../driver/types.js").PiDriver) {
    this.hub.registerRuntime({
      sessionKey,
      workspaceId,
      cwd,
      sessionPath,
      driver,
      seq: 0,
      ring: [],
      ringBytes: 0,
      conflict: false,
      lastPiActivityAt: Date.now(),
      writeQueue: Promise.resolve(),
    });
    this.hub.broadcast({ e: "holder_changed", sessionKey, holder: driver.kind === "host" ? "host" : "tui" });
  }

  private readAliases(): Record<string, string> {
    try {
      return JSON.parse(this.store.getKv("workspace_aliases") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  }

  private requireRuntime(sessionKey: SessionKey) {
    const rt = this.hub.runtimeFor(sessionKey);
    if (!rt) throw new DriverError("NO_RUNTIME", "会话未被托管，请先 session.open");
    return rt;
  }

  private activeSessionKeyForWorkspace(workspaceId: string): SessionKey | null {
    for (const [key, rt] of this.hub.runtimes) {
      if (rt.workspaceId === workspaceId) return key;
    }
    return null;
  }

  /** takeover：本机 TUI(Bridge) 持有 → 请求其释放；陈旧 host lease → 抢占 */
  private async takeover(sessionKey: SessionKey) {
    const { workspaceId } = splitSessionKey(sessionKey);
    for (const [key, rt] of this.hub.runtimes) {
      if (key !== sessionKey) continue;
      if (rt.driver.kind === "attach") {
        await rt.driver.release();
        await this.hub.destroyRuntime(key, "takeover");
      }
      return { taken: true };
    }
    // 未托管：检查 lease
    const cwd = decodeWorkspaceId(workspaceId);
    const sessions = listSessionsForCwd(cwd);
    const target = sessions.find((s) => s.sessionId === splitSessionKey(sessionKey).sessionId);
    if (!target) throw new DriverError("SESSION_NOT_FOUND", "会话不存在");
    const lease = readLease(target.path);
    if (lease && !isLeaseStale(lease) && lease.holder === "tui" && this.bridgeHub.hasBridgeFor(target.path)) {
      const peer = this.bridgeHub.getPeer(target.path);
      if (peer) await this.bridgeHub.request(peer, { t: "request_release" }, 15_000);
      return { taken: true, note: "已请求本机 TUI 释放，请稍后重新打开" };
    }
    return { taken: true, note: "会话当前无持有者" };
  }

  /* ---------------- settings（白名单字段，SEC-3） ---------------- */

  private settingsPath(): string {
    return join(process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi"), "agent", "settings.json");
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(this.settingsPath(), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async patchSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = await this.readSettings();
    for (const [k, v] of Object.entries(patch)) {
      if (!SETTINGS_PATCH_ALLOWLIST.has(k)) throw new DriverError("SETTINGS_DENIED", `字段不在白名单：${k}`);
      current[k] = v;
    }
    await writeFile(this.settingsPath(), JSON.stringify(current, null, 2));
    this.store.audit(null, null, "settings.patched", { keys: Object.keys(patch) });
    return current;
  }
}
