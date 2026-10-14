import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Cpu,
  Files,
  Flag,
  Loader2,
  MessageSquare,
  PanelLeft,
  RefreshCw,
} from "lucide-react";
import { useApp } from "../lib/store";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { SheetHost } from "./Sheets";
import { CommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";

export function ChatView() {
  const s = useApp();
  const messages = s.stream.messages.filter((m) => m.role !== "system" && m.role !== "custom");
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lastCount = useRef(messages.length);

  // 吸底滚动：version 覆盖流式原地更新；sessionLoading/sessionKey 覆盖历史加载/切换
  const prevSessionKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const keyChanged = prevSessionKey.current !== s.sessionKey;
    prevSessionKey.current = s.sessionKey;
    if (keyChanged) setAtBottom(true);
    if ((keyChanged || atBottom) && !s.sessionLoading) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages.length, s.stream.version, atBottom, s.sessionLoading, s.sessionKey]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 空闲轮询校准
  useEffect(() => {
    if (!s.isStreaming || !s.sessionKey) return;
    const t = setInterval(() => void s.refreshState(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.isStreaming, s.sessionKey]);

  const typingDevices = s.presence.filter((d) => d.typing).map((d) => d.name);
  // 标题与侧栏会话列表同源（name → preview → sessionName），避免 get_state 不返回名称时显示"未命名"
  const curSession = s.sessions.find((x) => x.path === s.sessionPath);
  const title = curSession?.name ?? curSession?.preview ?? s.sessionName ?? "未命名会话";

  if (s.sessionLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <Loader2 size={26} className="animate-spin text-accent" />
        <p className="text-sm text-dim">正在打开会话…</p>
      </div>
    );
  }

  if (!s.sessionKey) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-s2">
          <MessageSquare size={26} className="text-dim" />
        </div>
        <p className="text-sm text-dim">尚未打开会话</p>
        <button className="btn btn-primary" onClick={() => s.set({ sidebarOpen: true })}>
          <PanelLeft size={15} />
          从侧栏选择工作区 / 会话
        </button>
        {s.workspaceId && (
          <button
            className="btn"
            onClick={() => void s.openSession("new").catch((e) => alert(e instanceof Error ? e.message : String(e)))}
          >
            新建会话
          </button>
        )}
        {!s.workspaceId && (
          <p className="text-xs text-dim">请先选择工作目录（白名单见 Gateway 配置 ~/.pilink/config.json）</p>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 顶部 slim header */}
      <header className="sticky top-0 z-10 flex h-12 items-center gap-1.5 border-b border-line bg-bg/85 px-2 backdrop-blur">
        <button className="icon-btn" title="侧栏" onClick={() => s.set({ sidebarOpen: true })}>
          <PanelLeft size={17} />
        </button>
        <span
          className={`size-2 shrink-0 rounded-full ${s.holder === "host" ? "bg-ok" : s.holder === "tui" ? "bg-warn" : "bg-line2"}`}
          title={s.holder === "host" ? "PiLink 托管" : s.holder === "tui" ? "本机 TUI 持有" : "空闲"}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold" title="点击刷新状态" onClick={() => void s.refreshState()}>
          {title}
        </span>
        {typingDevices.length > 0 && (
          <span className="hidden text-xs text-dim sm:block">{typingDevices.join("、")} 正在输入…</span>
        )}
        <ThemeToggle />
        {s.workspaceId && (
          <button className="icon-btn" title="文件浏览" onClick={() => SheetHost.open("files")}>
            <Files size={16} />
          </button>
        )}
        <button className="btn-ghost btn max-w-32 !px-2 !py-1 text-xs" title="切换模型" onClick={() => SheetHost.open("model")}>
          <Cpu size={13} />
          <span className="truncate">{s.model?.id ?? "未选模型"}</span>
        </button>
        {s.thinkingLevel && (
          <button className="btn-ghost btn !px-2 !py-1 text-xs" title="思考等级" onClick={() => SheetHost.open("thinking")}>
            <Brain size={13} />
            {s.thinkingLevel}
          </button>
        )}
        <RoleBadge />
      </header>

      {/* 消息区 + FAB */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {s.conflict && (
          <div className="mx-3 mt-2 flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="flex-1">{s.conflict}</span>
            <button className="btn-ghost btn !px-2 !py-0.5 text-xs" onClick={() => void s.reloadHistory()}>
              <RefreshCw size={12} />
              重新加载
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4" ref={listRef}>
          {messages.map((m) => (
            <MessageItem key={m.key} message={m} />
          ))}
          {s.isStreaming && messages[messages.length - 1]?.role === "user" && (
            <div className="py-3 text-sm text-dim">正在思考…</div>
          )}
          <div ref={bottomRef} />
        </div>
        {!atBottom && (
          <button
            className="absolute right-4 bottom-4 z-10 flex size-9 items-center justify-center rounded-full border border-line bg-bg p-0 shadow-lg"
            title="回到底部"
            onClick={() => bottomRef.current?.scrollIntoView({ block: "end" })}
          >
            <ArrowDown size={16} />
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
  const cur = s.roles.find((r) => r.source === current);
  const label = cur ? (cur.alias ?? cur.title) : current ? current.split("/").pop() : "Pi 默认";
  return (
    <button
      className="chip transition-colors hover:border-accent hover:text-accent"
      onClick={() => SheetHost.open("role")}
      title={current ?? "Pi 默认系统提示词"}
    >
      <Flag size={11} />
      {label}
    </button>
  );
}
