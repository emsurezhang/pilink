/**
 * PiLink wire protocol — Client ⇄ Gateway envelopes.
 *
 * Pi RPC commands / responses / session events are reused from Pi itself
 * (`@earendil-works/pi-coding-agent`), per design doc §5.1 (D9).
 */
import type { RpcCommand, RpcResponse, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type { RpcCommand, RpcResponse };
export type PiEvent = JsonAgentSessionEvent;

/** 宽松响应类型：用于客户端/网关访问 data（Pi 的判别联合在跨命令场景不便收窄） */
export interface RpcResponseLoose {
  id?: string;
  type: "response";
  command?: string;
  success: boolean;
  data?: any;
  error?: string;
}
export type SessionKey = `${string}:${string}`; // `${workspaceId}:${sessionId}`

export function makeSessionKey(workspaceId: string, sessionId: string): SessionKey {
  return `${workspaceId}:${sessionId}` as SessionKey;
}
export function splitSessionKey(key: SessionKey): { workspaceId: string; sessionId: string } {
  const i = key.indexOf(":");
  return { workspaceId: key.slice(0, i), sessionId: key.slice(i + 1) };
}

/** Client → Gateway */
export type ClientMsg =
  | {
      t: "hello";
      v: 1;
      deviceId: string;
      accessToken: string;
      resume?: { sessionKey: SessionKey; lastSeq: number; lastEntryId?: string };
    }
  | { t: "rpc"; id: string; sessionKey: SessionKey; cmd: RpcCommand; deviceId?: string }
  | { t: "gw"; id: string; op: GatewayOp }
  | { t: "ui_response"; sessionKey: SessionKey; requestId: string; payload: unknown }
  | { t: "typing"; sessionKey: SessionKey; typing: boolean }
  | { t: "ping"; ts: number };

/** Gateway → Client */
export type ServerMsg =
  | { t: "hello_ok"; serverVersion: string; piVersion: string; features: string[] }
  | { t: "rpc_res"; id: string; res: RpcResponse }
  | { t: "event"; sessionKey: SessionKey; seq: number; ev: PiEvent }
  | { t: "gw_res"; id: string; ok: true; data: unknown }
  | { t: "gw_res"; id: string; ok: false; error: { code: string; message: string } }
  | { t: "gw_event"; ev: GatewayEvent }
  | { t: "ui_request"; sessionKey: SessionKey; requestId: string; payload: unknown }
  | { t: "pong"; ts: number };

/** Gateway 自有操作（设计文档 §5.2） */
export type GatewayOp =
  | { op: "workspaces.list" }
  | { op: "workspace.aliases.set"; aliases: Record<string, string> }
  | { op: "sessions.list"; workspaceId: string; query?: string }
  | { op: "session.open"; workspaceId: string; sessionPath: string; mode?: "auto" | "host" }
  | { op: "session.release"; sessionKey: SessionKey }
  | { op: "session.takeover"; sessionKey: SessionKey }
  | { op: "session.stats"; sessionKey: SessionKey }
  | { op: "commands.list"; sessionKey: SessionKey }
  | { op: "roles.list"; workspaceId: string }
  | { op: "roles.select"; workspaceId: string; source: string | null; force?: boolean }
  | { op: "roles.preview"; workspaceId: string; source: string }
  | { op: "fs.search"; workspaceId: string; query: string; limit?: number }
  | { op: "fs.list"; workspaceId: string; dir?: string }
  | { op: "fs.read"; workspaceId: string; path: string }
  | { op: "settings.get" }
  | { op: "settings.patch"; patch: Record<string, unknown> }
  | { op: "export.download"; sessionKey: SessionKey }
  | { op: "host.keepAwake"; enabled: boolean }
  | { op: "devices.list" }
  | { op: "devices.revoke"; deviceId: string };

export type GatewayEvent =
  | { e: "holder_changed"; sessionKey: SessionKey; holder: "tui" | "host" | "none" }
  | { e: "role_changed"; workspaceId: string; source: string | null; promptHash?: string }
  | { e: "conflict"; sessionKey: SessionKey; reason: "external_write" | "lease_lost" }
  | { e: "host_status"; sessionKey: SessionKey; status: "starting" | "ready" | "exited"; code?: number }
  | {
      e: "presence";
      sessionKey: SessionKey;
      devices: { deviceId: string; name: string; typing: boolean; lastSeen: number }[];
    }
  | { e: "cert_expiring"; hoursLeft: number };

/* ------------------------------------------------------------------ */
/* 入站消息运行时校验（zod，设计文档 §5.1）                              */
/* ------------------------------------------------------------------ */
import { z } from "zod";

const sessionKey = z.string().min(1);

export const clientMsgSchema: z.ZodType<ClientMsg> = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.literal(1),
    deviceId: z.string().min(1),
    accessToken: z.string().min(1),
    resume: z
      .object({
        sessionKey,
        lastSeq: z.number().int().nonnegative(),
        lastEntryId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({ t: z.literal("rpc"), id: z.string().min(1), sessionKey, cmd: z.record(z.unknown()) as never }),
  z.object({ t: z.literal("gw"), id: z.string().min(1), op: z.record(z.unknown()) as never }),
  z.object({ t: z.literal("ui_response"), sessionKey, requestId: z.string().min(1), payload: z.unknown() }),
  z.object({ t: z.literal("typing"), sessionKey, typing: z.boolean() }),
  z.object({ t: z.literal("ping"), ts: z.number() }),
]) as never;

/** RPC 透传白名单（设计文档 §5.3） */
export const RPC_ALLOWLIST = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  "new_session",
  "get_state",
  "get_messages",
  "set_model",
  "cycle_model",
  "get_available_models",
  "set_thinking_level",
  "cycle_thinking_level",
  "get_available_thinking_levels",
  "set_steering_mode",
  "set_follow_up_mode",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "bash",
  "abort_bash",
  "get_session_stats",
  "export_html",
  "switch_session",
  "fork",
  "clone",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "set_session_name",
  "get_commands",
]);

/** settings.patch 字段白名单（SEC-3，不触碰密钥字段） */
export const SETTINGS_PATCH_ALLOWLIST = new Set([
  "theme",
  "tuiMode",
  "defaultThinkingLevel",
  "autoCompaction",
  "autoRetry",
  "cacheWarming",
  "imageInstructions",
  "verbose",
  "quietStartup",
]);

/* ------------------------------------------------------------------ */
/* 内置斜杠命令表（设计文档附录 A / §6.1，D5）                          */
/* ------------------------------------------------------------------ */
export type CommandSource = "builtin" | "extension" | "prompt" | "skill";
export type Availability = "full" | "degraded" | "local-only";

export interface BuiltinCommandInfo {
  name: string;
  description: string;
  argHint?: string;
  availability: Availability;
  /** 需要的移动端原生交互 */
  ui: "none" | "picker" | "list" | "tree" | "editor" | "panel" | "confirm";
  degradedNote?: string;
}

export const BUILTIN_COMMANDS: BuiltinCommandInfo[] = [
  { name: "model", description: "切换模型", argHint: "[provider/model]", availability: "full", ui: "picker" },
  { name: "thinking", description: "切换思考等级", argHint: "[level]", availability: "full", ui: "picker" },
  { name: "new", description: "新建会话", availability: "full", ui: "confirm" },
  { name: "resume", description: "恢复历史会话", availability: "full", ui: "list" },
  { name: "name", description: "重命名会话", argHint: "[name]", availability: "full", ui: "editor" },
  { name: "session", description: "会话信息与统计", availability: "full", ui: "panel" },
  { name: "fork", description: "从历史消息分叉", availability: "full", ui: "list" },
  { name: "clone", description: "克隆当前分支", availability: "full", ui: "confirm" },
  { name: "compact", description: "压缩上下文", argHint: "[instructions]", availability: "full", ui: "editor" },
  { name: "copy", description: "复制最后一条助手回复", availability: "full", ui: "none" },
  { name: "reload", description: "重新加载扩展与配置", availability: "degraded", ui: "none", degradedNote: "无 Bridge 时通过重载同一会话文件实现" },
  { name: "tree", description: "会话树", availability: "full", ui: "tree" },
  { name: "export", description: "导出 HTML", argHint: "[path]", availability: "full", ui: "none" },
  { name: "settings", description: "设置", availability: "full", ui: "panel" },
  { name: "trust", description: "信任当前项目", availability: "degraded", ui: "confirm", degradedNote: "需本机终端执行 /trust（或安装 Bridge）" },
  { name: "quit", description: "结束托管（释放会话）", availability: "full", ui: "confirm" },
  { name: "scoped-models", description: "模型可见范围", availability: "degraded", ui: "list" },
  { name: "import", description: "导入会话文件", argHint: "<path>", availability: "degraded", ui: "editor" },
  { name: "share", description: "分享会话", availability: "degraded", ui: "confirm", degradedNote: "涉及外传，需二次确认" },
  { name: "login", description: "登录模型服务商", availability: "local-only", ui: "none", degradedNote: "OAuth 需本机浏览器，仅本机可用" },
  { name: "logout", description: "退出登录", availability: "local-only", ui: "none", degradedNote: "仅本机可用" },
  { name: "hotkeys", description: "快捷键与手势帮助", availability: "full", ui: "panel" },
  { name: "changelog", description: "更新日志", availability: "full", ui: "panel" },
];

/* ------------------------------------------------------------------ */
/* LF 分帧（设计文档 §7.1 / rpc.md：严禁使用 readline）                  */
/* ------------------------------------------------------------------ */

/** 将字节/UTF-8 流按 LF 切分为 JSONL 记录（仅在 LF 处切分，兼容 CRLF）。 */
export function createLfFramer(onRecord: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onRecord(line);
    }
  };
}
