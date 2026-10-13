/**
 * Sidebar：Workspace 选择器（别名/最近优先） + 会话列表（倒序/新建） + 设置入口。
 * 桌面端：静态侧栏，可折叠；移动端：抽屉滑出。
 */
import { useEffect, useRef, useState } from "react";
import { useApp } from "../lib/store";
import type { SessionSummary, WorkspaceInfo } from "../lib/store";

export function Sidebar() {
  const s = useApp();
  const close = () => {
    // 移动端收起抽屉；桌面端折叠侧栏（行为一致：隐藏）
    s.set({ sidebarOpen: false });
  };
  return (
    <>
      {/* 移动端遮罩：点击关闭抽屉（桌面端 CSS 隐藏） */}
      {s.sidebarOpen && <div className="side-backdrop" onClick={close} />}
      <aside className={`sidebar ${s.sidebarOpen ? "open" : "closed"}`}>
        <WorkspacePicker onCollapse={close} />
        <SessionSection />
        <footer className="side-footer">
          <button className="side-item" onClick={() => s.set({ tab: "settings" })}>
            ⚙️ 设置
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
  const label = (w: WorkspaceInfo) => s.workspaceAliases[w.workspaceId] ?? w.cwd;

  return (
    <div className="ws-picker" ref={ref}>
      <div className="ws-picker-row">
        <button className="ws-current" title={current?.cwd ?? "选择工作区"} onClick={() => setOpen(!open)}>
          <span className="ws-name">📁 {current ? label(current) : "选择工作区"}</span>
          <span className="chevron">{open ? "▾" : "▸"}</span>
        </button>
        <button className="ws-collapse" title="收起侧栏" onClick={onCollapse}>
          «
        </button>
      </div>
      {open && (
        <div className="ws-menu">
          {[...s.workspaces]
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .map((w) => (
              <div key={w.workspaceId} className={`ws-row ${w.workspaceId === s.workspaceId ? "selected" : ""}`}>
                <button
                  className="ws-row-main"
                  title={w.cwd}
                  onClick={() => {
                    setOpen(false);
                    void s.enterWorkspace(w.workspaceId, w.cwd).catch((e) => alert(e instanceof Error ? e.message : String(e)));
                  }}
                >
                  <span className="ws-row-name">{label(w)}</span>
                  <span className="ws-row-cwd dim small">{w.cwd}</span>
                </button>
                <button
                  className="ws-alias"
                  title="设置别名"
                  onClick={() => {
                    const cur = s.workspaceAliases[w.workspaceId] ?? "";
                    const a = prompt(`为工作区设置别名（留空清除）：\n${w.cwd}`, cur);
                    if (a !== null) s.setWorkspaceAlias(w.workspaceId, a);
                  }}
                >
                  ✎
                </button>
              </div>
            ))}
          {s.workspaces.length === 0 && <div className="dim small ws-empty">无可用工作区（见 Gateway 白名单配置）</div>}
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
    <div className="side-sessions">
      <div className="side-sessions-head">
        <span>会话</span>
        <button
          className="mini"
          title="新建会话（/new）"
          disabled={!s.workspaceId}
          onClick={() => void s.openSession("new").catch((e) => alert(e instanceof Error ? e.message : String(e)))}
        >
          ＋ 新建
        </button>
      </div>
      <input className="side-search" placeholder="搜索会话…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="side-session-list">
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
        {s.sessions.length === 0 && <div className="dim small">{s.workspaceId ? "该工作区暂无历史会话" : "请先选择工作区"}</div>}
      </div>
    </div>
  );
}

function SessionRow({ sess, active }: { sess: SessionSummary; active: boolean }) {
  const s = useApp();
  const busy = s.isStreaming && active;
  return (
    <button
      className={`session-row ${active ? "selected" : ""}`}
      title={sess.path}
      onClick={() => {
        if (busy && !confirm("该会话正在本机运行中，打开后将由手机托管（本机进程需先退出）。继续？")) return;
        void s.openSession(sess.path).catch((e) => alert(e instanceof Error ? e.message : String(e)));
      }}
    >
      <div className="row-title">
        {sess.name ?? sess.preview ?? sess.sessionId}
        {active && <span className="chip">当前</span>}
      </div>
      <div className="dim small">
        {sess.messageCount} 条消息 · {new Date(sess.updatedAt).toLocaleString()}
      </div>
      {sess.preview && sess.name && <div className="dim small">{sess.preview}</div>}
    </button>
  );
}
