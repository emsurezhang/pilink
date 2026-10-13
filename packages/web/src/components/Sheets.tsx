import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { client } from "../lib/client";
import { forkFrom, setModel, setThinkingLevel } from "../lib/commands";

export type SheetName = "model" | "thinking" | "session" | "role" | "fork" | "tree" | "compact";

const VALID_SHEETS = new Set<string>(["model", "thinking", "session", "role", "fork", "tree", "compact"]);

/** 极简 Sheet 管理器（命令面板与各处共用） */
type Listener = (name: SheetName | null, arg?: string) => void;
let listener: Listener = () => {};
export const SheetHost = {
  open(name: SheetName, arg?: string) {
    if (!VALID_SHEETS.has(name)) return; // 防止无效 Sheet 产生空白遮罩
    listener(name, arg);
  },
  close() {
    listener(null);
  },
  async runCommandText(text: string): Promise<void> {
    const m = text.match(/^\/(\S+)\s*(.*)$/);
    if (!m) return;
    const { runBuiltin, NEEDS_ARGS } = await import("../lib/commands");
    if (NEEDS_ARGS.has(m[1]) && !m[2]) {
      SheetHost.open(m[1] as SheetName);
      return;
    }
    const result = await runBuiltin(m[1], m[2]);
    if (typeof result === "string" && result.startsWith("__SHEET__:")) {
      SheetHost.open(result.slice(10) as SheetName);
    } else if (typeof result === "string" && result.length > 0 && !result.startsWith("__")) {
      alert(result);
    }
  },
};

export function SheetRoot() {
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [arg, setArg] = useState<string | undefined>();
  useEffect(() => {
    listener = (n, a) => {
      setSheet(n);
      setArg(a);
    };
  }, []);
  if (!sheet) return null;
  const close = () => SheetHost.close();
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        {sheet === "model" && <ModelSheet close={close} />}
        {sheet === "thinking" && <ThinkingSheet close={close} />}
        {sheet === "session" && <StatsSheet close={close} />}
        {sheet === "role" && <RoleSheet close={close} />}
        {sheet === "fork" && <ForkSheet close={close} entryId={arg} />}
        {sheet === "tree" && <TreeSheet close={close} />}
        {sheet === "compact" && <CompactSheet close={close} />}
      </div>
    </div>
  );
}

function ModelSheet({ close }: { close: () => void }) {
  const s = useApp();
  const [models, setModels] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!s.sessionKey) return;
    void client.rpc(s.sessionKey, { type: "get_available_models" } as never).then((res) => {
      if (res.success) setModels((res.data as { models: never[] }).models as never);
    });
  }, [s.sessionKey]);
  const filtered = models.filter((m) => !q || `${m.provider}/${m.id}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(filtered.map((m) => m.provider))];
  return (
    <>
      <h3>选择模型</h3>
      <input placeholder="搜索…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="sheet-list">
        {groups.map((g) => (
          <div key={g}>
            <div className="group-title">{g}</div>
            {filtered
              .filter((m) => m.provider === g)
              .map((m) => (
                <button
                  key={m.id}
                  className={s.model?.id === m.id ? "selected" : ""}
                  onClick={() => {
                    void setModel(m.provider, m.id).then(close);
                  }}
                >
                  {m.name ?? m.id}
                  {s.model?.id === m.id && " ✓"}
                </button>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}

function ThinkingSheet({ close }: { close: () => void }) {
  const s = useApp();
  const [levels, setLevels] = useState<string[]>([]);
  const [display, setDisplay] = useState<"expanded" | "collapsed" | "hidden">(s.thinkingMode);
  useEffect(() => {
    if (!s.sessionKey) return;
    void client.rpc(s.sessionKey, { type: "get_available_thinking_levels" } as never).then((res) => {
      if (res.success) setLevels((res.data as { levels: string[] }).levels);
    });
  }, [s.sessionKey]);
  return (
    <>
      <h3>思考等级</h3>
      <div className="sheet-list">
        {levels.map((l) => (
          <button
            key={l}
            className={s.thinkingLevel === l ? "selected" : ""}
            onClick={() => void setThinkingLevel(l).then(close)}
          >
            {l}
            {s.thinkingLevel === l && " ✓"}
          </button>
        ))}
      </div>
      <h3>思考显示（对历史消息同样生效，RND-2）</h3>
      <div className="seg">
        {(["expanded", "collapsed", "hidden"] as const).map((m) => (
          <button
            key={m}
            className={display === m ? "active" : ""}
            onClick={() => {
              setDisplay(m);
              s.set({ thinkingMode: m });
            }}
          >
            {m === "expanded" ? "展开" : m === "collapsed" ? "折叠" : "隐藏"}
          </button>
        ))}
      </div>
    </>
  );
}

function StatsSheet({ close }: { close: () => void }) {
  const s = useApp();
  useEffect(() => {
    void s.refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const d = s.stats as Record<string, any> | undefined;
  return (
    <>
      <h3>会话信息</h3>
      {d ? (
        <div className="stats">
          <div>用户消息：{d.userMessages} · 助手消息：{d.assistantMessages} · 工具调用：{d.toolCalls}</div>
          <div>
            Tokens：输入 {d.tokens?.input ?? 0} · 输出 {d.tokens?.output ?? 0} · 缓存读 {d.tokens?.cacheRead ?? 0}
          </div>
          <div>费用：${(d.cost ?? 0).toFixed(4)}</div>
          {d.contextUsage && (
            <div>
              上下文：{d.contextUsage.tokens ?? "—"} / {d.contextUsage.contextWindow ?? "—"}（{d.contextUsage.percent ?? "—"}%）
            </div>
          )}
          <div className="dim small path">{s.sessionPath}</div>
        </div>
      ) : (
        <div className="dim">加载中…</div>
      )}
      <button onClick={close}>关闭</button>
    </>
  );
}

function RoleSheet({ close }: { close: () => void }) {
  const s = useApp();
  const [preview, setPreview] = useState<{ source: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void s.refreshRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function choose(source: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      await s.selectRole(source, !s.isStreaming);
      close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("正在运行")) {
        if (confirm("Agent 正在运行。中止后切换？（已有历史不会重写，提示词缓存将失效）")) {
          await s.abort();
          await s.selectRole(source, true);
          close();
        }
      } else alert(msg);
    } finally {
      setBusy(false);
    }
  }
  if (preview) {
    return (
      <>
        <h3>{preview.source}</h3>
        <pre className="code preview">{preview.content}</pre>
        <div className="row">
          <button onClick={() => setPreview(null)}>← 返回</button>
          <button
            className="primary"
            onClick={() => {
              void choose(preview.source);
            }}
          >
            选此为角色
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <h3>选择角色（SYSTEM.md）</h3>
      <div className="sheet-list">
        <button className={s.roleCurrent == null ? "selected" : ""} onClick={() => void choose(null)}>
          ⌀ Pi 默认
          <div className="dim small">
            {s.roleFallback?.kind === "global" ? `回落到全局 SYSTEM.md（${s.roleFallback.path}）` : "使用 Pi 内置默认提示词"}
          </div>
        </button>
        {s.roles.map((r) => (
          <button key={r.source} className={r.current ? "selected" : ""} onClick={() => void choose(r.source)}>
            {r.title}
            <div className="dim small">
              {r.source}
              {r.native ? " · 原生" : ""}
            </div>
            <div className="dim small">{r.preview.slice(0, 80)}</div>
          </button>
        ))}
      </div>
      <div className="row">
        <button
          onClick={() => {
            const r = s.roles.find((x) => x.current) ?? s.roles[0];
            if (r) {
              void client
                .gw<{ content: string }>({ op: "roles.preview", workspaceId: s.workspaceId!, source: r.source })
                .then((res) => setPreview({ source: r.source, content: res.content }));
            }
          }}
        >
          预览当前
        </button>
        <button onClick={close}>关闭</button>
      </div>
    </>
  );
}

function ForkSheet({ close, entryId }: { close: () => void; entryId?: string }) {
  const s = useApp();
  const [forks, setForks] = useState<{ entryId: string; text: string }[]>([]);
  useEffect(() => {
    if (!s.sessionKey) return;
    void client.rpc(s.sessionKey, { type: "get_fork_messages" } as never).then((res) => {
      if (res.success) setForks((res.data as { messages: never[] }).messages as never);
    });
  }, [s.sessionKey]);
  return (
    <>
      <h3>从历史消息分叉</h3>
      <div className="sheet-list">
        {forks.map((f) => (
          <button
            key={f.entryId}
            className={entryId === f.entryId ? "selected" : ""}
            onClick={() => {
              if (!confirm(`从此处分叉？\n${f.text.slice(0, 80)}`)) return;
              void forkFrom(f.entryId).then(close);
            }}
          >
            {f.text.slice(0, 100)}
          </button>
        ))}
        {forks.length === 0 && <div className="dim">暂无可分叉的用户消息</div>}
      </div>
      <button onClick={close}>取消</button>
    </>
  );
}

function CompactSheet({ close }: { close: () => void }) {
  const s = useApp();
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  async function run() {
    if (busy || !s.sessionKey) return;
    if (s.isStreaming) {
      alert("Agent 运行中，无法压缩");
      return;
    }
    setBusy(true);
    try {
      const res = await client.rpc(s.sessionKey, {
        type: "compact",
        customInstructions: instructions.trim() || undefined,
      } as never);
      if (!res.success) throw new Error(res.error ?? "压缩失败");
      await s.loadHistory();
      await s.refreshStats();
      close();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h3>压缩上下文</h3>
      {s.contextUsage && (
        <p className="dim small">
          当前上下文：{s.contextUsage.tokens ?? "—"} / {s.contextUsage.contextWindow ?? "—"} tokens（
          {s.contextUsage.percent ?? "—"}%）
        </p>
      )}
      <input
        placeholder="压缩指令（可选，如：重点保留代码改动）"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void run()}
        autoFocus
      />
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? "压缩中…" : "开始压缩"}
        </button>
        <button onClick={close}>取消</button>
      </div>
    </>
  );
}

function TreeSheet({ close }: { close: () => void }) {
  const s = useApp();
  interface Node {
    entry: { id: string; type: string; parentId?: string | null; message?: { role?: string; content?: unknown }; timestamp?: string };
    children: Node[];
    label?: string;
  }
  const [tree, setTree] = useState<{ nodes: Node[]; leafId: string | null }>({ nodes: [], leafId: null });
  useEffect(() => {
    if (!s.sessionKey) return;
    void client.rpc(s.sessionKey, { type: "get_tree" } as never).then((res) => {
      if (res.success) {
        const d = res.data as { tree: Node[]; leafId: string | null };
        setTree({ nodes: d.tree, leafId: d.leafId });
      }
    });
  }, [s.sessionKey]);
  function labelOf(n: Node): string {
    const e = n.entry;
    if (e.type === "message") {
      const role = e.message?.role ?? "?";
      const content = e.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b: any) => b?.text ?? "").join(" ")
            : "";
      return `${role}: ${text.slice(0, 50) || "[空]"}`;
    }
    return `[${e.type}]`;
  }
  function render(nodes: Node[], depth: number): React.ReactNode {
    return nodes.map((n) => (
      <div key={n.entry.id}>
        <div className="tree-node" style={{ paddingLeft: depth * 16 }} data-leaf={n.entry.id === tree.leafId}>
          {n.entry.id === tree.leafId && "👉 "}
          {n.label && <span className="chip">{n.label}</span>}
          {labelOf(n)}
          {n.entry.message?.role === "user" && (
            <button
              className="mini"
              onClick={() => {
                if (confirm("从该节点分叉？")) void forkFrom(n.entry.id).then(close);
              }}
            >
              分叉
            </button>
          )}
        </div>
        {n.children.length > 0 && render(n.children, depth + 1)}
      </div>
    ));
  }
  return (
    <>
      <h3>会话树</h3>
      <div className="tree">{render(tree.nodes, 0)}</div>
      <div className="dim small">树导航（切换叶子）需 Bridge 支持（M3，Spike S6）；当前支持只读查看与分叉。</div>
      <button onClick={close}>关闭</button>
    </>
  );
}
