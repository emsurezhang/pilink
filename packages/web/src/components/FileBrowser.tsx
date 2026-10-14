import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  File as FileIcon,
  FileText,
  Folder,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useApp } from "../lib/store";
import { client } from "../lib/client";
import { Markdown } from "./MessageItem";

interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

interface Reading {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 文件浏览：浏览 workspace 目录、打开并渲染 Markdown。
 * 典型场景：让 agent 生成长篇内容输出到 .md 文件后，在手机上查看排版结果。
 */
export function FileBrowser({ close }: { close: () => void }) {
  const s = useApp();
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [reading, setReading] = useState<Reading | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (d: string) => {
      if (!s.workspaceId) return;
      setLoading(true);
      setError(null);
      try {
        const res = await client.gw<{ entries: FsEntry[] }>({ op: "fs.list", workspaceId: s.workspaceId, dir: d });
        setEntries(res.entries);
        setDir(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [s.workspaceId],
  );

  useEffect(() => {
    void refresh("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(entry: FsEntry) {
    if (entry.isDir) {
      void refresh(entry.path);
      return;
    }
    if (!s.workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.gw<{ content: string; truncated: boolean; size: number }>({ op: "fs.read", workspaceId: s.workspaceId, path: entry.path });
      setReading({ path: entry.path, content: res.content, truncated: res.truncated, size: res.size });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  /* ---------- 阅读视图 ---------- */
  if (reading) {
    const isMd = /\.(md|markdown)$/i.test(reading.path);
    return (
      <>
        <div className="flex items-center gap-1">
          <button className="icon-btn" title="返回目录" onClick={() => setReading(null)}>
            <ArrowLeft size={16} />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{reading.path}</span>
          <span className="text-xs text-dim">{fmtSize(reading.size)}</span>
        </div>
        {reading.truncated && (
          <div className="flex items-center gap-1.5 rounded-md bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
            <TriangleAlert size={12} />
            文件过大，仅显示前 512KB
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-bg p-4">
          {isMd ? (
            <Markdown text={reading.content} />
          ) : (
            <pre className="m-0 text-xs whitespace-pre-wrap break-all">{reading.content}</pre>
          )}
        </div>
        <div className="flex justify-end">
          <button className="btn" onClick={() => setReading(null)}>
            返回目录
          </button>
        </div>
      </>
    );
  }

  /* ---------- 目录浏览视图 ---------- */
  const parent = dir ? dir.split("/").slice(0, -1).join("/") : null;
  const crumbs = dir ? dir.split("/") : [];

  return (
    <>
      <div className="flex items-center gap-1">
        <h3 className="m-0 flex-1 text-[15px] font-semibold">文件浏览</h3>
        {loading && <Loader2 size={14} className="animate-spin text-dim" />}
        <button className="btn-ghost btn !px-2 !py-1 text-xs" onClick={() => void refresh(dir)}>
          刷新
        </button>
      </div>

      {/* 面包屑 */}
      <div className="flex items-center gap-0.5 overflow-x-auto text-xs text-dim">
        <button className="rounded px-1 py-0.5 hover:bg-s2 hover:text-fg" onClick={() => void refresh("")}>
          根目录
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <ChevronRight size={11} />
            <button
              className="rounded px-1 py-0.5 whitespace-nowrap hover:bg-s2 hover:text-fg"
              onClick={() => void refresh(crumbs.slice(0, i + 1).join("/"))}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      {error && <div className="text-xs text-danger">{error}</div>}

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {parent !== null && (
          <button className="row-item text-dim" onClick={() => void refresh(parent)}>
            <ArrowLeft size={14} />
            ..
          </button>
        )}
        {entries.map((e) => (
          <button key={e.path} className="row-item gap-2.5" onClick={() => void open(e)}>
            {e.isDir ? (
              <Folder size={15} className="shrink-0 text-dim" />
            ) : /\.(md|markdown)$/i.test(e.name) ? (
              <FileText size={15} className="shrink-0 text-accent" />
            ) : (
              <FileIcon size={15} className="shrink-0 text-dim" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
            {!e.isDir && <span className="shrink-0 text-xs text-dim">{fmtSize(e.size)}</span>}
            <ChevronRight size={13} className="shrink-0 text-dim" />
          </button>
        ))}
        {entries.length === 0 && !loading && <div className="px-3 py-4 text-xs text-dim">空目录</div>}
      </div>

      <div className="flex justify-end">
        <button className="btn" onClick={close}>
          关闭
        </button>
      </div>
    </>
  );
}
