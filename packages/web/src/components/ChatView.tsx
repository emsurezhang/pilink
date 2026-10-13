import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { client } from "../lib/client";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { SheetHost } from "./Sheets";
import { CommandPalette } from "./CommandPalette";

export function ChatView() {
  const s = useApp();
  const messages = s.stream.messages.filter((m) => m.role !== "system" && m.role !== "custom");
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lastCount = useRef(messages.length);

  // 吸底滚动（§7.2-5）：version 覆盖流式原地更新；sessionLoading/sessionKey 覆盖历史加载完成/切换会话
  const prevSessionKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const keyChanged = prevSessionKey.current !== s.sessionKey;
    prevSessionKey.current = s.sessionKey;
    if (keyChanged) setAtBottom(true); // 切换会话：重置为吸底，跳到最新消息
    if ((keyChanged || atBottom) && !s.sessionLoading) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages.length, s.stream.version, atBottom, s.sessionLoading, s.sessionKey]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setAtBottom(nearBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 空闲状态轮询校准（agent_settled 之外的兜底）
  useEffect(() => {
    if (!s.isStreaming || !s.sessionKey) return;
    const t = setInterval(() => void s.refreshState(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.isStreaming, s.sessionKey]);

  const contextPct = s.contextUsage?.percent ?? null;
  const typingDevices = s.presence.filter((d) => d.typing).map((d) => d.name);

  if (s.sessionLoading) {
    return (
      <div className="empty-chat">
        <div className="loading-spinner" />
        <p className="dim">正在打开会话…</p>
      </div>
    );
  }

  if (!s.sessionKey) {
    return (
      <div className="empty-chat">
        <p>尚未打开会话。</p>
        <button onClick={() => s.set({ sidebarOpen: true })}>☰ 从侧栏选择工作区 / 会话</button>
        {s.workspaceId && (
          <button
            onClick={() =>
              void s.openSession("new").catch((e) => alert(e instanceof Error ? e.message : String(e)))
            }
          >
            ＋ 新建会话
          </button>
        )}
        {!s.workspaceId && <p className="dim small">请先选择工作目录（白名单见 Gateway 配置 ~/.pilink/config.json）</p>}
      </div>
    );
  }

  return (
    <div className="chat">
      <header className="top-bar">
        <div className="top-row">
          <button className="icon-btn" title="侧栏" onClick={() => s.set({ sidebarOpen: true })}>
            ☰
          </button>
          <span className="holder" data-holder={s.holder} title="会话持有者：本机 TUI / PiLink Host / 空闲（SYNC-7）">
            {s.holder === "host" ? "PiLink 托管" : s.holder === "tui" ? "本机 TUI" : "空闲"}
          </span>
          <span className="title" title="点击刷新状态" onClick={() => void s.refreshState()}>
            {s.sessionName ?? "未命名会话"}
          </span>
          {typingDevices.length > 0 && <span className="typing">{typingDevices.join("、")} 正在输入…</span>}
          <span className="spacer" />
          <span className="model" title="切换模型" onClick={() => SheetHost.open("model")}>
            {s.model ? `${s.model.provider}/${s.model.id}` : "未选模型"}
          </span>
          {s.thinkingLevel && (
            <span className="chip" title="思考等级" onClick={() => SheetHost.open("thinking")}>
              思考:{s.thinkingLevel}
            </span>
          )}
        </div>
        <div className="top-row sub">
          <RoleBadge />
          <span className="spacer" />
          {contextPct != null && (
            <span className="ctx-usage" title="上下文占用">
              <svg viewBox="0 0 20 20">
                <circle cx="10" cy="10" r="8" className="ring-bg" />
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  className="ring-fg"
                  strokeDasharray={`${(contextPct / 100) * 50.3} 50.3`}
                />
              </svg>
              {contextPct}%
            </span>
          )}
          {s.isCompacting && <span className="chip warn">压缩中…</span>}
        </div>
      </header>

      {/* chat-body：消息区与 FAB 的相对定位父级，使 fab 的 bottom 不依赖 composer 高度 */}
      <div className="chat-body">
        <div className="message-list" ref={listRef}>
          {messages.map((m) => (
            <MessageItem key={m.key} message={m} />
          ))}
          {s.isStreaming && messages[messages.length - 1]?.role === "user" && (
            <div className="msg assistant pending-hint">正在思考…</div>
          )}
          <div ref={bottomRef} />
        </div>
        {!atBottom && (
          <button className="fab" title="回到底部" onClick={() => bottomRef.current?.scrollIntoView({ block: "end" })}>
            ↓ 回到底部
          </button>
        )}
      </div>
      <Composer />
    </div>
  );
}

function RoleBadge() {
  const s = useApp();
  const current = s.roleCurrent;
  const label = current ? current.split("/").pop() : "Pi 默认";
  return (
    <span className="chip role" onClick={() => SheetHost.open("role")} title={current ?? "Pi 默认系统提示词"}>
      ⚑ {label}
    </span>
  );
}
