/**
 * Sidebar：Workspace 选择器（别名/最近优先） + 会话列表（倒序/新建） + 设置入口。
 * 桌面端：静态侧栏，可折叠；移动端：抽屉滑出。
 */
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Pencil,
  PanelLeftClose,
  Plus,
  Settings,
} from "lucide-react";
import { useApp } from "../lib/store";
import type { SessionSummary, WorkspaceInfo } from "../lib/store";

export function Sidebar() {
  const s = useApp();
  const close = () => s.set({ sidebarOpen: false });
  return (
    <>
      {/* 移动端遮罩 */}
      {s.sidebarOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={close} />}
      <aside
        className={[
          "z-50 flex w-72 flex-col border-r border-line bg-s1 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(82vw,300px)] max-md:shadow-2xl max-md:transition-transform max-md:duration-200",
          s.sidebarOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
          s.sidebarOpen ? "" : "hidden md:hidden", // 桌面端折叠 = 隐藏（由 ☰ 重新打开）
        ].join(" ")}
      >
        <WorkspacePicker onCollapse={close} />
        <SessionSection />
        <footer className="border-t border-line p-2">
          <button className="row-item text-dim hover:text-fg" onClick={() => s.set({ tab: "settings" })}>
            <Settings size={16} />
            设置
          </button>
        </footer>
      </aside>
    </>
  );
}

/* ---------------- 组件 1：Workspace 选择（固定高度） ---------------- */

function WorkspacePicker({ onCollapse }: { onCollapse: () => void }) {
  const s = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = s.workspaces.find((w) => w.workspaceId === s.workspaceId);
  const label = (w: WorkspaceInfo) => s.workspaceAliases[w.workspaceId] ?? w.cwd.split("/").pop() ?? w.cwd;

  return (
    <div ref={ref} className="relative border-b border-line p-2">
      <div className="flex items-center gap-1">
        <button
          className="row-item flex-1 gap-2 px-2.5 py-2 font-semibold hover:bg-s2"
          title={current?.cwd ?? "选择工作区"}
          onClick={() => setOpen(!open)}
        >
          <FolderOpen size={16} className="shrink-0 text-dim" />
          <span className="min-w-0 flex-1 truncate text-left text-sm">
            {current ? label(current) : "选择工作区"}
          </span>
          {open ? <ChevronDown size={14} className="text-dim" /> : <ChevronRight size={14} className="text-dim" />}
        </button>
        <button className="icon-btn" title="收起侧栏" onClick={onCollapse}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      {open && (
        <div className="absolute inset-x-2 top-full z-50 mt-1 flex flex-col gap-0.5 rounded-xl border border-line bg-bg p-1 shadow-xl">
          {[...s.workspaces]
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .map((w) => (
              <div key={w.workspaceId} className="group flex items-center gap-0.5 rounded-lg hover:bg-s2">
                <button
                  className="min-w-0 flex-1 px-2.5 py-2 text-left"
                  title={w.cwd}
                  onClick={() => {
                    setOpen(false);
                    void s.enterWorkspace(w.workspaceId, w.cwd).catch((e) => alert(e instanceof Error ? e.message : String(e)));
                  }}
                >
                  <div className="truncate text-sm font-medium">{label(w)}</div>
                  <div className="truncate text-xs text-dim">{w.cwd}</div>
                </button>
                <button
                  className="icon-btn opacity-0 group-hover:opacity-100"
                  title="设置别名"
                  onClick={() => {
                    const cur = s.workspaceAliases[w.workspaceId] ?? "";
                    const a = prompt(`为工作区设置别名（留空清除）：\n${w.cwd}`, cur);
                    if (a !== null) s.setWorkspaceAlias(w.workspaceId, a);
                  }}
                >
                  <Pencil size={13} />
                </button>
              </div>
            ))}
          {s.workspaces.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-dim">无可用工作区（见 Gateway 白名单配置）</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- 组件 2：会话列表（占据剩余高度） ---------------- */

function SessionSection() {
  const s = useApp();
  const [q, setQ] = useState("");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
      <div className="flex items-center justify-between px-1.5 py-1">
        <span className="text-[11px] font-semibold tracking-wide text-dim uppercase">会话</span>
        <button
          className="btn-ghost btn !px-2 !py-1 text-xs"
          title="新建会话（/new）"
          disabled={!s.workspaceId}
          onClick={() => void s.openSession("new").catch((e) => alert(e instanceof Error ? e.message : String(e)))}
        >
          <Plus size={13} />
          新建
        </button>
      </div>
      <input className="input !py-1.5 text-[13px]" placeholder="搜索会话…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {s.sessions
          .filter(
            (x) =>
              !q ||
              (x.name ?? "").toLowerCase().includes(q.toLowerCase()) ||
              (x.preview ?? "").toLowerCase().includes(q.toLowerCase()),
          )
          .map((sess) => (
            <SessionRow key={sess.sessionId} sess={sess} active={s.sessionPath === sess.path} />
          ))}
        {s.sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-dim">
            {s.workspaceId ? "该工作区暂无历史会话" : "请先选择工作区"}
          </div>
        )}
      </div>
    </div>
  );
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString();
}

function SessionRow({ sess, active }: { sess: SessionSummary; active: boolean }) {
  const s = useApp();
  const busy = s.isStreaming && active;
  return (
    <button
      className={`rounded-lg border px-2.5 py-2 text-left transition-colors duration-150 ${
        active
          ? "border-accent/50 bg-accent/5"
          : "border-line hover:border-line2"
      }`}
      title={sess.path}
      onClick={() => {
        if (busy && !confirm("该会话正在本机运行中，打开后将由手机托管（本机进程需先退出）。继续？")) return;
        void s.openSession(sess.path).catch((e) => alert(e instanceof Error ? e.message : String(e)));
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {sess.name ?? sess.preview ?? sess.sessionId}
        </span>
        {active && <span className="chip !py-0 text-[10px] text-accent">当前</span>}
      </div>
      <div className="mt-0.5 text-xs text-dim">
        {sess.messageCount} 条 · {timeAgo(sess.updatedAt)}
      </div>
      {sess.preview && sess.name && (
        <div className="mt-0.5 truncate text-xs text-dim">{sess.preview}</div>
      )}
    </button>
  );
}
