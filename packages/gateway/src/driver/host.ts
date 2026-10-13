/**
 * HostDriver（设计文档 §3.1，M1）：拉起 `pi --mode rpc` 子进程并持有会话。
 * - LF 分帧（严禁 readline，见 rpc.md）
 * - 命令 id 关联；事件无 id 直接广播
 * - extension_ui_request 转发给客户端
 * - 关闭 stdin = 优雅退出
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { RpcCommand, RpcResponse, PiEvent, SessionKey } from "@pilink/protocol";
import { createLfFramer } from "@pilink/protocol";
import { DriverError, type DriverCaps, type PiDriver } from "./types.js";

interface PendingRequest {
  resolve: (res: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HostDriverOptions {
  piPath: string;
  cwd: string;
  sessionPath?: string; // 不传 = 新会话
  sessionName?: string;
  loadBridge?: boolean;
  bridgePath?: string;
  extraArgs?: string[];
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onUiRequest?: (payload: unknown) => void;
}

export class HostDriver implements PiDriver {
  readonly kind = "host" as const;
  readonly caps: DriverCaps = { reload: false, getSystemPrompt: false, navigateTree: false, liveCoPresence: false };

  private child: ChildProcess;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(ev: PiEvent) => void>();
  private idCounter = 0;
  private exited = false;
  private frame: (chunk: string) => void;

  constructor(readonly sessionKey: SessionKey, private opts: HostDriverOptions) {
    const args = ["--mode", "rpc"];
    if (opts.sessionPath) args.push("--session", opts.sessionPath);
    if (opts.sessionName) args.push("--name", opts.sessionName);
    if (opts.loadBridge && opts.bridgePath) args.push("--extension", opts.bridgePath);
    args.push(...(opts.extraArgs ?? []));

    this.child = spawn(opts.piPath, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PILINK_BRIDGE_ROLE: "host" },
    });
    this.child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[pi stderr] ${d.toString()}`);
    });

    this.frame = createLfFramer((line) => this.handleRecord(line));
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", this.frame);
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const err = new DriverError("HOST_EXITED", `pi 进程已退出 (code=${code}, signal=${signal})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      opts.onExit?.(code, signal);
    });
    this.child.on("error", (err) => {
      this.exited = true;
      opts.onExit?.(null, null);
      throw new DriverError("HOST_EXITED", `无法启动 pi 进程：${err.message}`);
    });
  }

  static starting(sessionKey: SessionKey, opts: HostDriverOptions): HostDriver {
    return new HostDriver(sessionKey, opts);
  }

  isAlive(): boolean {
    return !this.exited && this.child.exitCode == null;
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  request(cmd: RpcCommand, signal?: AbortSignal): Promise<RpcResponse> {
    if (this.exited || !this.child.stdin?.writable) {
      return Promise.reject(new DriverError("HOST_EXITED", "pi 进程不在运行"));
    }
    const id = `gw-${++this.idCounter}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const msg = `命令超时：${(cmd as { type?: string }).type ?? "unknown"}（120s）`;
        console.error(`[pilink:host] ${msg}`);
        reject(new DriverError("RPC_TIMEOUT", msg));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      const wire = JSON.stringify({ id, ...cmd }) + "\n";
      console.log(`[pilink:host] -> ${this.sessionKey} ${String((cmd as { type?: string }).type ?? "unknown")}`);
      const ok = this.child.stdin!.write(wire);
      if (!ok) {
        // 背压：等待 drain 再继续（rpc.md 要求尊重 stdin 背压）
        this.child.stdin!.once("drain", () => {});
      }
      signal?.addEventListener(
        "abort",
        () => {
          const p = this.pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(id);
            p.reject(new DriverError("RPC_ABORTED", "调用方已取消"));
          }
        },
        { once: true },
      );
    });
  }

  onEvent(fn: (ev: PiEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 扩展 UI 回传：写回 stdin（rpc-extension-ui 子协议） */
  respondUi(requestId: string, payload: unknown): void {
    if (this.exited || !this.child.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: requestId, ...((payload ?? {}) as object) }) + "\n");
  }

  async release(): Promise<void> {
    if (this.exited) return;
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 5_000);
      this.child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }

  private handleRecord(line: string): void {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const type = rec.type as string | undefined;
    if (type === "response") {
      const id = rec.id as string | undefined;
      const p = id ? this.pending.get(id) : undefined;
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id!);
        console.log(`[pilink:host] <- ${this.sessionKey} ${String((rec.command ?? rec.type ?? "response"))} success=${Boolean(rec.success)}`);
        p.resolve(rec as unknown as RpcResponse);
      }
      return;
    }
    if (type === "extension_ui_request") {
      this.opts.onUiRequest?.(rec);
      return;
    }
    // 其余均为会话事件（json.md 事件族）
    const ev = rec as unknown as PiEvent;
    for (const fn of [...this.listeners]) fn(ev);
  }
}
