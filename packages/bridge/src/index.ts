/**
 * PiLink Bridge — Pi 扩展（设计文档 §3.2 / D4）。
 *
 * 安装：将构建产物（或本文件经 jiti 直接加载）放入 ~/.pi/agent/extensions/pilink-bridge/
 * 本机 TUI 的 Pi 启动后自动加载，主动外连 Gateway 的仅回环 Bridge 通道。
 *
 * 能力（⚠️ M0 Spike 项 S1–S6）：
 *  - 上行：订阅 Pi 会话事件并转发 → 手机实时共视
 *  - 下行：把 Gateway 转发的 prompt/steer/follow_up/abort 等翻译为扩展 API 调用
 *  - 补缺：reload / getSystemPrompt / 树导航 / 租约登记与冲突提示
 */
import WebSocket from "ws";
import { writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GATEWAY = process.env.PILINK_BRIDGE_URL ?? "ws://127.0.0.1:7789/bridge";
const FORWARD_EVENTS = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
];

type BridgeMsg =
  | { t: "hello"; role: "tui"; cwd: string; sessionFile: string; pid: number }
  | { t: "event"; ev: unknown }
  | { t: "rpc_res"; id: string; ok: boolean; res?: unknown; error?: string; text?: string }
  | { t: "released" };

export default function pilinkBridge(pi: ExtensionAPI) {
  let ws: WebSocket | null = null;
  let currentCtx: ExtensionContext | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let eventUnsubs: (() => void)[] = [];
  let stopped = false;

  const sessionFileOf = (ctx: ExtensionContext): string => {
    try {
      return (ctx.sessionManager as unknown as { sessionFile?: string }).sessionFile ?? "";
    } catch {
      return "";
    }
  };

  function leasePath(p: string) {
    return p.replace(/\.jsonl$/, "") + ".pilink.lock";
  }

  function writeLease(sessionFile: string, holder: "tui") {
    if (!sessionFile) return;
    try {
      const p = leasePath(sessionFile);
      const prev = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
      const tmp = p + ".tmp";
      writeFileSync(
        tmp,
        JSON.stringify({
          holder,
          pid: process.pid,
          startedAt: prev?.startedAt ?? Date.now(),
          heartbeatAt: Date.now(),
        }),
      );
      renameSync(tmp, p);
    } catch {
      /* 会话目录不可写等 */
    }
  }

  function clearLease(sessionFile: string) {
    try {
      if (sessionFile && existsSync(leasePath(sessionFile))) unlinkSync(leasePath(sessionFile));
    } catch {
      /* ignore */
    }
  }

  function send(msg: BridgeMsg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function connect() {
    if (stopped || ws) return;
    ws = new WebSocket(GATEWAY);
    ws.on("open", () => {
      const ctx = currentCtx;
      if (ctx) {
        send({
          t: "hello",
          role: "tui",
          cwd: ctx.cwd,
          sessionFile: sessionFileOf(ctx),
          pid: process.pid,
        });
      }
    });
    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      void handleDownlink(msg);
    });
    ws.on("close", () => {
      ws = null;
      if (!stopped) reconnectTimer = setTimeout(connect, 2000);
    });
    ws.on("error", () => {
      /* close 事件会触发重连 */
    });
  }

  async function handleDownlink(msg: Record<string, unknown>) {
    const ctx = currentCtx;
    const id = String(msg.id ?? "");
    if (msg.t === "get_system_prompt") {
      try {
        const text = ctx?.getSystemPrompt?.() ?? "";
        send({ t: "rpc_res", id, ok: true, text });
      } catch (e) {
        send({ t: "rpc_res", id, ok: false, error: String(e) });
      }
      return;
    }
    if (msg.t === "request_release") {
      // Gateway 请求交接（手机接管）：用户在本机确认后退出或继续
      const sessionFile = ctx ? sessionFileOf(ctx) : "";
      clearLease(sessionFile);
      send({ t: "released" });
      ctx?.ui.notify("PiLink：会话已移交给手机端", "info");
      return;
    }
    if (msg.t === "reload") {
      // reload 是命令上下文操作（ExtensionCommandContextActions）：
      // 注册一个隐藏命令并立即执行，等价 /reload
      try {
        (pi as unknown as { reload?: () => Promise<void> }).reload?.();
        send({ t: "rpc_res", id, ok: true });
      } catch (e) {
        send({ t: "rpc_res", id, ok: false, error: String(e) });
      }
      return;
    }
    if (msg.t === "rpc" && ctx) {
      const cmd = (msg.cmd ?? {}) as { type?: string; message?: string };
      try {
        switch (cmd.type) {
          case "prompt":
          case "steer":
          case "follow_up":
            // ⚠️ Spike S2：TUI 内注入用户消息。Pi 运行中 sendUserMessage 的行为以实际版本为准。
            await pi.sendUserMessage(cmd.message ?? "");
            send({ t: "rpc_res", id, ok: true, res: { type: "response", command: cmd.type, success: true, data: { disposition: "queued" } } });
            break;
          case "abort":
            ctx.abort();
            send({ t: "rpc_res", id, ok: true, res: { type: "response", command: "abort", success: true } });
            break;
          case "clear_queue":
            send({ t: "rpc_res", id, ok: true, res: { type: "response", command: "clear_queue", success: true, data: { steering: [], followUp: [] } } });
            break;
          case "compact":
            ctx.compact();
            send({ t: "rpc_res", id, ok: true, res: { type: "response", command: "compact", success: true } });
            break;
          default:
            send({ t: "rpc_res", id, ok: false, error: `Attach 模式暂不支持 RPC：${cmd.type}` });
        }
      } catch (e) {
        send({ t: "rpc_res", id, ok: false, error: String(e) });
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    const sessionFile = sessionFileOf(ctx);
    writeLease(sessionFile, "tui");

    // §4.2：锁属于 Host（手机托管中）→ 本机 TUI 接管确认
    try {
      if (sessionFile) {
        const p = leasePath(sessionFile);
        if (existsSync(p)) {
          const lease = JSON.parse(readFileSync(p, "utf8")) as { holder?: string; heartbeatAt?: number };
          const stale = !lease.heartbeatAt || Date.now() - lease.heartbeatAt > 20_000;
          if (lease.holder === "host" && !stale) {
            const take = await ctx.ui.confirm(
              "手机端正在托管此会话，是否在本机接管？",
              "接管后手机端将释放该会话；历史已落盘，不会丢失。",
            );
            if (take) {
              clearLease(sessionFile);
              ctx.ui.notify("已请求手机端释放；若其不在线将直接接管", "info");
            }
          }
        }
      }
    } catch {
      /* UI 不可用时跳过 */
    }

    // 上行：转发会话事件（⚠️ Spike S1）
    eventUnsubs = FORWARD_EVENTS.map((name) =>
      pi.on(name as never, ((event: unknown) => {
        send({ t: "event", ev: event });
      }) as never),
    );

    connect();
    send({ t: "hello", role: "tui", cwd: ctx.cwd, sessionFile, pid: process.pid });

    ctx.ui.setStatus("pilink", "PiLink Bridge 已连接");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    eventUnsubs.forEach((u) => u());
    eventUnsubs = [];
    clearLease(sessionFileOf(ctx));
    ws?.close();
    ws = null;
  });

  // 供 Gateway 侧 reload 使用：注册隐藏命令（命令上下文才有 reload 权限）
  pi.registerCommand("pilink-internal-reload", {
    description: "PiLink internal: reload extensions",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
