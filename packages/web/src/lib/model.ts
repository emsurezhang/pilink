/**
 * 流式消息重建（设计文档 §7.1/§7.3）。
 * 事件 → UiMessage 累加器；message_end 为权威覆盖；渲染以消息/条目 id 幂等去重。
 */
import type { PiEvent } from "@pilink/protocol";

export interface UiToolCall {
  toolCallId?: string;
  name: string;
  argsText: string;
  args?: unknown;
  status: "running" | "done" | "error";
  resultText?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface UiMessage {
  key: string; // message.id 或 entryId 或生成
  role: "user" | "assistant" | "system" | "compaction" | "branch_summary" | "custom";
  text: string;
  thinking: { index: number; text: string; encrypted?: boolean }[];
  toolCalls: UiToolCall[];
  images: { data: string; mimeType: string }[];
  pending?: boolean; // 流式中
  stopReason?: string;
  timestamp?: number;
  usage?: { input: number; output: number; totalTokens: number };
  source: "live" | "history";
}

export function emptyMessage(key: string, role: UiMessage["role"], source: UiMessage["source"]): UiMessage {
  return { key, role, text: "", thinking: [], toolCalls: [], images: [], source };
}

/* ---------------- 事件应用 ---------------- */

export class StreamState {
  messages: UiMessage[] = [];
  /** toolCallId -> toolCall（跨消息归属，工具结果按 id 合并到卡片） */
  toolIndex = new Map<string, UiToolCall>();
  /** 事件版本号：applyEvent 自增，供 UI 依赖追踪（流式原地更新时引用不变） */
  version = 0;
  private current: UiMessage | null = null;
  /** wire 上 message 无 id：按角色配对未结束的 message_start（§7.1 幂等重建） */
  private openByRole = new Map<UiMessage["role"], UiMessage>();
  private seq = 0;

  private findByKey(key: string): UiMessage | undefined {
    return this.messages.find((m) => m.key === key);
  }

  applyEvent(ev: PiEvent): void {
    const e = ev as Record<string, any>;
    this.version++;
    switch (e.type) {
      case "message_start": {
        const msg = e.message ?? {};
        const key = msg.id ?? `live-${++this.seq}`;
        let m = this.findByKey(key);
        if (!m) {
          m = emptyMessage(key, roleOf(msg.role), "live");
          this.messages.push(m);
        }
        m.pending = msg.role === "assistant";
        const role = roleOf(msg.role);
        this.current = role === "assistant" ? m : null;
        this.openByRole.set(role, m);
        break;
      }
      case "message_update": {
        if (!this.current) break;
        const u = e.assistantMessageEvent ?? {};
        const m = this.current;
        switch (u.type) {
          case "text_start":
            break;
          case "text_delta":
            m.text += u.delta ?? "";
            break;
          case "text_end":
            m.text = u.content ?? m.text;
            break;
          case "thinking_start": {
            const idx = u.contentIndex ?? 0;
            if (!m.thinking.some((t) => t.index === idx)) m.thinking.push({ index: idx, text: "" });
            break;
          }
          case "thinking_delta": {
            const idx = u.contentIndex ?? 0;
            let t = m.thinking.find((x) => x.index === idx);
            if (!t) {
              t = { index: idx, text: "" };
              m.thinking.push(t);
            }
            t.text += u.delta ?? "";
            break;
          }
          case "thinking_end": {
            const idx = u.contentIndex ?? 0;
            let t = m.thinking.find((x) => x.index === idx);
            if (!t) {
              t = { index: idx, text: "" };
              m.thinking.push(t);
            }
            t.text = u.content ?? t.text;
            break;
          }
          case "toolcall_start": {
            const tc: UiToolCall = {
              toolCallId: u.id,
              name: u.toolName ?? "tool",
              argsText: "",
              status: "running",
            };
            m.toolCalls.push(tc);
            if (u.id) this.toolIndex.set(u.id, tc);
            break;
          }
          case "toolcall_delta": {
            const idx = u.contentIndex ?? 0;
            const tc = m.toolCalls[idx];
            if (tc) tc.argsText += u.delta ?? "";
            break;
          }
          case "toolcall_end": {
            const tc = u.toolCall ? this.toolIndex.get(u.toolCall.id) : undefined;
            if (tc && u.toolCall) {
              tc.args = u.toolCall.arguments;
              tc.name = u.toolCall.name ?? tc.name;
              try {
                tc.args = typeof u.toolCall.arguments === "string" ? JSON.parse(u.toolCall.arguments) : u.toolCall.arguments;
                tc.argsText = JSON.stringify(tc.args, null, 2);
              } catch {
                tc.argsText = String(u.toolCall.arguments ?? "");
              }
            }
            break;
          }
        }
        if (e.usage) m.usage = e.usage;
        break;
      }
      case "message_end": {
        const msg = e.message ?? {};
        const role = roleOf(msg.role);
        // 优先按 id 匹配；wire 上无 id 时配对同角色的未结束 message_start
        let m = msg.id ? this.findByKey(msg.id) : undefined;
        if (!m) m = this.openByRole.get(role);
        if (!m) {
          m = emptyMessage(msg.id ?? `live-${++this.seq}`, role, "live");
          this.messages.push(m);
        } else if (m.role === "custom" && msg.role) {
          m.role = role;
        }
        applyAuthoritative(m, msg, this.toolIndex);
        m.pending = false;
        if (m === this.current) this.current = null;
        if (this.openByRole.get(role) === m) this.openByRole.delete(role);
        break;
      }
      case "tool_execution_start": {
        const tc = this.toolIndex.get(e.toolCallId);
        if (tc) {
          tc.status = "running";
          tc.args = e.args ?? tc.args;
        } else {
          // 无前置 toolcall（恢复场景）：建占位卡片
          const placeholder: UiToolCall = { toolCallId: e.toolCallId, name: e.toolName ?? "tool", argsText: JSON.stringify(e.args ?? {}), args: e.args, status: "running" };
          this.toolIndex.set(e.toolCallId, placeholder);
          const host = this.messages[this.messages.length - 1];
          if (host) host.toolCalls.push(placeholder);
        }
        break;
      }
      case "tool_execution_update": {
        const tc = this.toolIndex.get(e.toolCallId);
        if (tc && e.partialResult?.content) tc.resultText = textOf(e.partialResult.content);
        break;
      }
      case "tool_execution_end": {
        const tc = this.toolIndex.get(e.toolCallId);
        if (tc) {
          tc.status = e.isError ? "error" : "done";
          tc.isError = e.isError;
          tc.durationMs = e.durationMs;
          if (e.result?.content) tc.resultText = textOf(e.result.content);
        }
        break;
      }
      case "agent_start":
        break;
      case "agent_settled":
        for (const m of this.messages) m.pending = false;
        this.current = null;
        this.openByRole.clear();
        break;
    }
  }

  /** 历史回放：AgentMessage[] → UiMessage[]（RND-6） */
  static fromHistory(messages: Record<string, any>[]): StreamState {
    const s = new StreamState();
    for (const msg of messages) {
      const m = emptyMessage(msg.id ?? `hist-${s.messages.length}`, roleOf(msg.role), "history");
      applyAuthoritative(m, msg, s.toolIndex);
      s.messages.push(m);
    }
    return s;
  }
}

function roleOf(role: string | undefined): UiMessage["role"] {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "custom";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b !== "object" || !b) return "";
        const bb = b as Record<string, any>;
        if (bb.type === "text") return bb.text ?? "";
        if (bb.type === "image") return `[图片 ${bb.mimeType ?? ""}]`;
        if (bb.type === "thinking") return bb.thinking ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function applyAuthoritative(m: UiMessage, msg: Record<string, any>, toolIndex: Map<string, UiToolCall>): void {
  m.role = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : m.role;
  m.stopReason = msg.stopReason;
  m.timestamp = msg.timestamp;
  m.usage = msg.usage;
  m.text = "";
  m.thinking = [];
  m.images = [];

  const content = msg.content;
  if (typeof content === "string") {
    m.text = content;
  } else if (Array.isArray(content)) {
    content.forEach((b: Record<string, any>, i: number) => {
      if (!b || typeof b !== "object") return;
      if (b.type === "text") m.text += (m.text ? "\n" : "") + (b.text ?? "");
      else if (b.type === "thinking") {
        m.thinking.push({ index: i, text: b.thinking ?? "", encrypted: b.encrypted });
      } else if (b.type === "image") {
        m.images.push({ data: b.data ?? "", mimeType: b.mimeType ?? "image/png" });
      } else if (b.type === "toolCall") {
        const tc: UiToolCall = {
          toolCallId: b.id,
          name: b.name ?? "tool",
          argsText: "",
          args: b.arguments,
          status: "running",
        };
        try {
          tc.argsText = typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}, null, 2);
        } catch {
          tc.argsText = "";
        }
        m.toolCalls.push(tc);
        if (b.id) toolIndex.set(b.id, tc);
      }
    });
  }

  // toolResult：合并到对应工具卡片，不作为独立消息展示
  if (msg.role === "toolResult") {
    m.role = "custom";
    m.text = "";
    const tc = msg.toolCallId ? toolIndex.get(msg.toolCallId) : undefined;
    if (tc) {
      tc.status = msg.isError ? "error" : "done";
      tc.isError = msg.isError;
      tc.resultText = textOf(content);
    }
  }
  if (m.thinking.length === 0 && msg.thinking) {
    m.thinking.push({ index: 0, text: String(msg.thinking) });
  }
}
