/**
 * 内置命令执行（设计文档 §6 / 附录 A，D5）。
 * 内置命令由客户端实现移动端原生交互；动态命令统一 prompt("/name args")。
 */
import { client } from "./client";
import { useApp } from "./store";

export interface DynamicCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: { path?: string; scope?: string };
  /** 可远程执行性（缺省视为 full）；非 full 的命令不出现在命令面板 */
  availability?: "full" | "local-only" | "degraded";
}

export async function runDynamicCommand(name: string, args = ""): Promise<void> {
  const s = useApp.getState();
  if (!s.sessionKey) throw new Error("会话未打开");
  const res = await client.rpc(s.sessionKey, {
    type: "prompt",
    message: `/${name}${args ? " " + args : ""}`,
  } as never);
  if (!res.success) throw new Error((res as { error?: string }).error ?? "命令执行失败");
}

/** 需要参数的内置命令：把模板填回输入框（由 Composer 继续） */
export const NEEDS_ARGS = new Set(["name", "compact", "import"]);

export async function runBuiltin(name: string, args: string): Promise<string | void> {
  const s = useApp.getState();
  const key = s.sessionKey;
  const rpc = (cmd: never) => {
    if (!key) throw new Error("会话未打开");
    return client.rpc(key, cmd);
  };

  switch (name) {
    case "new": {
      if (!confirm("新建会话？当前历史已落盘，不会丢失。")) return;
      await s.newSession();
      return;
    }
    case "quit": {
      if (!confirm("结束托管并释放会话？可在终端用 pi --session <path> 接回。")) return;
      await s.releaseSession();
      return;
    }
    case "copy": {
      const res = await rpc({ type: "get_last_assistant_text" } as never);
      if (res.success) {
        const text = (res.data as { text?: string }).text ?? "";
        await navigator.clipboard.writeText(text);
        return "已复制";
      }
      throw new Error((res as { error?: string }).error ?? "复制失败");
    }
    case "export": {
      const res = await client.gw<{ filename: string; dataBase64: string }>({ op: "export.download", sessionKey: key! });
      const blob = b64ToBlob(res.dataBase64, "text/html");
      downloadBlob(blob, res.filename);
      return "已导出";
    }
    case "reload": {
      // 降级：无 Bridge 时 switch_session 同一文件（§6.3）
      if (!s.sessionPath) throw new Error("未知会话路径");
      const res = await rpc({ type: "switch_session", sessionPath: s.sessionPath } as never);
      if (!res.success) throw new Error((res as { error?: string }).error ?? "reload 失败");
      await s.loadHistory();
      await s.refreshCommands();
      return "已重新加载";
    }
    case "name": {
      if (!args) return `__PROMPT__:${name}`;
      const res = await rpc({ type: "set_session_name", name: args } as never);
      if (!res.success) throw new Error((res as { error?: string }).error ?? "重命名失败");
      await s.refreshState();
      await s.refreshSessions();
      return "已重命名";
    }
    case "compact": {
      if (s.isStreaming) throw new Error("Agent 运行中，无法压缩");
      const res = await rpc({ type: "compact", customInstructions: args || undefined } as never);
      if (!res.success) throw new Error((res as { error?: string }).error ?? "压缩失败");
      await s.loadHistory();
      return "已压缩";
    }
    case "clone": {
      if (!confirm("克隆当前分支为新会话？")) return;
      const res = await rpc({ type: "clone" } as never);
      if (!res.success) throw new Error((res as { error?: string }).error ?? "克隆失败");
      await s.refreshSessions();
      return "已克隆";
    }
    case "fork": {
      return `__SHEET__:${name}`; // 打开 ForkSheet 选择历史消息
    }
    case "model":
      return `__SHEET__:${name}`;
    case "thinking":
      return `__SHEET__:${name}`;
    case "session":
      return `__SHEET__:${name}`;
    case "tree":
      return `__SHEET__:${name}`;
    case "resume":
      // 打开侧栏，从会话列表中选择
      useApp.getState().set({ tab: "chat", sidebarOpen: true });
      return;
    case "settings":
      useApp.getState().set({ tab: "settings" });
      return;
    case "trust":
      alert("项目信任需在本机终端执行 /trust（未安装 Bridge 时无法远程完成）");
      return;
    case "login":
    case "logout":
      alert("OAuth 登录/登出需要本机浏览器回调，请在本机终端执行（附录 A：仅本机）");
      return;
    case "share":
      if (!confirm("分享会将会话内容外传，确定继续？（注意脱敏）")) return;
      alert("v1 未实现远端分享，请使用 /export 导出 HTML 后自行分享");
      return;
    case "import":
      alert("v1：请手动将 JSONL 放入 ~/.pi/agent/sessions/--<path>--/ 后使用 /resume 恢复");
      return;
    case "scoped-models":
      alert("v1 降级：请在本机 pi /settings 中配置");
      return;
    case "hotkeys":
      alert("手势：长按消息→复制/fork；长按发送→Steer/Follow-up；双击输入框→命令面板");
      return;
    case "changelog":
      alert("见 Pi 安装目录 CHANGELOG.md（v1 降级说明）");
      return;
    default:
      throw new Error(`未知命令：/${name}`);
  }
}

export async function forkFrom(entryId: string): Promise<void> {
  const s = useApp.getState();
  if (!s.sessionKey) throw new Error("会话未打开");
  const res = await client.rpc(s.sessionKey, { type: "fork", entryId } as never);
  if (!res.success) throw new Error((res as { error?: string }).error ?? "fork 失败");
  await s.loadHistory();
  await s.refreshSessions();
}

export async function setModel(provider: string, modelId: string): Promise<void> {
  const s = useApp.getState();
  const res = await client.rpc(s.sessionKey!, { type: "set_model", provider, modelId } as never);
  if (!res.success) throw new Error((res as { error?: string }).error ?? "切换模型失败");
  await s.refreshState();
}

export async function setThinkingLevel(level: string): Promise<void> {
  const s = useApp.getState();
  const res = await client.rpc(s.sessionKey!, { type: "set_thinking_level", level } as never);
  if (!res.success) throw new Error((res as { error?: string }).error ?? "切换失败");
  await s.refreshState();
}

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export { b64ToBlob, downloadBlob };
